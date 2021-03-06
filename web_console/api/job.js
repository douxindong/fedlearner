const router = require('@koa/router')();
const { Op } = require('sequelize');
const SessionMiddleware = require('../middlewares/session');
const FindOptionsMiddleware = require('../middlewares/find_options');
const k8s = require('../libs/k8s');
const es = require('../libs/es');
const { Job, Ticket, Federation } = require('../models');
const FederationClient = require('../rpc/client');
const getConfig = require('../utils/get_confg');
const checkParseJson = require('../utils/check_parse_json');
const { clientValidateJob, clientGenerateYaml } = require('../utils/job_builder');

const config = getConfig({
  NAMESPACE: process.env.NAMESPACE,
});
const namespace = config.NAMESPACE;

let es_oparator_match_phrase;
try {
  es_oparator_match_phrase = require('../es.match_phrase');
} catch (err) { /* */ }

router.get('/api/v1/jobs', SessionMiddleware, FindOptionsMiddleware, async (ctx) => {
  const jobs = await Job.findAll({
    ...ctx.findOptions,
    order: [['created_at', 'DESC']],
  });
  const { flapps } = await k8s.getFLAppsByNamespace(namespace);
  let data = [];
  for (job of jobs) {
    if (job.status == null) job.status = 'started';
    if (job.federation_id == null) {
      const clientTicket = await Ticket.findOne({
        where: {
          name: { [Op.eq]: job.client_ticket_name },
        },
      });
      if (clientTicket) {
        job.federation_id = clientTicket.federation_id;
      }
    }
    if (job.status === 'stopped') {
      data.push({
        ...JSON.parse(job.k8s_meta_snapshot).flapp,
        localdata: job,
      });
    } else {
      data.push({
        ...(flapps.items.find((item) => item.metadata.name === job.name)),
        localdata: job,
      });
    }
  }
  ctx.body = { data };
});

router.get('/api/v1/job/:id', SessionMiddleware, async (ctx) => {
  const { id } = ctx.params;
  const job = await Job.findByPk(id);
  if (!job) {
    ctx.status = 404;
    ctx.body = {
      error: 'Job not found',
    };
    return;
  }

  if (job.status == null) job.status = 'started';
  if (job.federation_id == null) {
    const clientTicket = await Ticket.findOne({
      where: {
        name: { [Op.eq]: job.client_ticket_name },
      },
    });
    job.federation_id = clientTicket.federation_id;
  }

  var flapp;
  if (job.status === 'stopped') {
    flapp = JSON.parse(job.k8s_meta_snapshot).flapp;
  } else {
    flapp = (await k8s.getFLApp(namespace, job.name)).flapp;
  }

  ctx.body = {
    data: {
      ...flapp,
      localdata: job,
    },
  };
});

router.get('/api/v1/job/:k8s_name/pods', SessionMiddleware, async (ctx) => {
  const { k8s_name } = ctx.params;

  const job = await Job.findOne({
    where: {
      name: { [Op.eq]: k8s_name },
    },
  });

  if (!job) {
    ctx.status = 404;
    ctx.body = {
      error: 'Job not found',
    };
    return;
  }

  var pods;
  if (job.status === 'stopped') {
    pods = JSON.parse(job.k8s_meta_snapshot).pods;
  } else {
    pods = (await k8s.getFLAppPods(namespace, k8s_name)).pods;
  }

  ctx.body = { data: pods.items };
});

router.get('/api/v1/job/:k8s_name/logs', SessionMiddleware, async (ctx) => {
  const { k8s_name } = ctx.params;
  const { start_time } = ctx.query;
  if (!start_time) {
    ctx.status = 400;
    ctx.body = {
      error: 'start_time is required',
    };
    return;
  }
  const logs = await es.queryLog('filebeat-*', k8s_name, 'fedlearner-operator',
    start_time, Date.now(), es_oparator_match_phrase);

  ctx.body = { data: logs };
});

router.get('/api/v1/job/pod/:pod_name/container', SessionMiddleware, async (ctx) => {
  const { pod_name } = ctx.params;
  const base = k8s.getBaseUrl();
  const { id } = await k8s.getWebshellSession(namespace, pod_name, 'tensorflow');
  ctx.body = { data: { id, base } };
});

router.get('/api/v1/job/pod/:pod_name/logs', SessionMiddleware, async (ctx) => {
  const { pod_name } = ctx.params;
  const { start_time } = ctx.query;
  if (!start_time) {
    ctx.status = 400;
    ctx.body = {
      error: 'start_time is required',
    };
    return;
  }
  const logs = await es.queryLog('filebeat-*', '', pod_name, start_time, Date.now());

  ctx.body = { data: logs };
});

router.post('/api/v1/job', SessionMiddleware, async (ctx) => {
  const {
    name, job_type, client_ticket_name, server_ticket_name,
    client_params, server_params,
  } = ctx.request.body;

  if (!(/^[a-zA-Z\d-]+$/.test(name))) {
    ctx.status = 400;
    ctx.body = {
      error: 'name can only contain letters/numbers/-',
    };
    return;
  }

  const [client_params_pass] = checkParseJson(JSON.stringify(client_params));
  if (!client_params_pass) {
    ctx.status = 400;
    ctx.body = {
      error: 'client_params must be json',
    };
    return;
  }

  const [server_params_pass] = checkParseJson(JSON.stringify(server_params));
  if (!server_params_pass) {
    ctx.status = 400;
    ctx.body = {
      error: 'server_params must be json',
    };
    return;
  }

  const exists = await Job.findOne({
    where: {
      name: { [Op.eq]: name },
    },
  });
  if (exists) {
    ctx.status = 422;
    ctx.body = {
      error: 'Job already exists',
    };
    return;
  }

  const clientTicket = await Ticket.findOne({
    where: {
      name: { [Op.eq]: client_ticket_name },
    },
  });
  if (!clientTicket) {
    ctx.status = 422;
    ctx.body = {
      error: 'client_ticket does not exist',
    };
    return;
  }

  const clientFed = await Federation.findByPk(clientTicket.federation_id);
  if (!clientFed) {
    ctx.status = 422;
    ctx.body = {
      error: 'Federation does not exist',
    };
    return;
  }
  const rpcClient = new FederationClient(clientFed);

  let serverTicket;
  try {
    const { data } = await rpcClient.getTickets({ job_type: '', role: '' });
    serverTicket = data.find(x => x.name === server_ticket_name);
    if (!serverTicket) {
      throw new Error(`Cannot find server ticket ${server_ticket_name}`);
    }
  } catch (err) {
    ctx.status = 500;
    ctx.body = {
      error: `Cannot get server ticket: ${err.message}`,
    };
    return;
  }

  const job = {
    name, job_type, client_ticket_name, server_ticket_name,
    client_params, server_params, status: 'started',
    federation_id: clientFed.id,
  };

  try {
    clientValidateJob(job, clientTicket, serverTicket);
  } catch (e) {
    ctx.status = 400;
    ctx.body = {
      error: `client_params validation failed: ${e.message}`,
    };
    return;
  }

  try {
    await rpcClient.createJob({
      ...job,
      server_params: JSON.stringify(server_params),
    });
  } catch (err) {
    ctx.status = 500;
    ctx.body = {
      error: `RPC Error: ${err.message}`,
    };
    return;
  }

  const clientYaml = clientGenerateYaml(clientFed, job, clientTicket);

  await k8s.createFLApp(namespace, clientYaml);

  const [data, created] = await Job.findOrCreate({
    paranoid: false,
    where: {
      name: { [Op.eq]: name },
    },
    defaults: {
      ...job,
      user_id: ctx.session && ctx.session.user ? ctx.session.user.id : null,
    },
  });

  if (!created) {
    ctx.status = 422;
    ctx.body = {
      error: 'Job already exists',
    };
    return;
  }

  ctx.body = { data };
});

router.post('/api/v1/job/:id/update', SessionMiddleware, async (ctx) => {
  // get old job info
  const { id } = ctx.params;
  const old_job = await Job.findByPk(id);
  if (!old_job) {
    ctx.status = 404;
    ctx.body = {
      error: 'Job not found',
    };
    return;
  }

  if (old_job.status === 'error') {
    ctx.status = 422;
    ctx.body = {
      error: 'Cannot update errored job',
    };
    return;
  }

  const {
    name, job_type, client_ticket_name, server_ticket_name,
    client_params, server_params, status,
  } = ctx.request.body;

  if (old_job.status === 'started' && status != 'stopped') {
    ctx.status = 422;
    ctx.body = {
      error: 'Cannot change running job',
    };
    return;
  }

  if (name != old_job.name) {
    ctx.status = 422;
    ctx.body = {
      error: 'cannot change job name',
    };
    return;
  }

  if (job_type != old_job.job_type) {
    ctx.status = 422;
    ctx.body = {
      error: 'cannot change job type',
    };
    return;
  }

  const clientTicket = await Ticket.findOne({
    where: {
      name: { [Op.eq]: client_ticket_name },
    },
  });
  if (!clientTicket) {
    ctx.status = 422;
    ctx.body = {
      error: `client_ticket ${client_ticket_name} does not exist`,
    };
    return;
  }

  const OldClientTicket = await Ticket.findOne({
    where: {
      name: { [Op.eq]: old_job.client_ticket_name },
    },
  });
  if (!OldClientTicket) {
    ctx.status = 422;
    ctx.body = {
      error: `client_ticket ${old_job.client_ticket_name} does not exist`,
    };
    return;
  }

  if (clientTicket.federation_id != OldClientTicket.federation_id) {
    ctx.status = 422;
    ctx.body = {
      error: 'cannot change job federation',
    };
    return;
  }

  const clientFed = await Federation.findByPk(clientTicket.federation_id);
  if (!clientFed) {
    ctx.status = 422;
    ctx.body = {
      error: 'Federation does not exist',
    };
    return;
  }
  const rpcClient = new FederationClient(clientFed);

  let serverTicket;
  try {
    const { data } = await rpcClient.getTickets({ job_type: '', role: '' });
    serverTicket = data.find(x => x.name === server_ticket_name);
    if (!serverTicket) {
      throw new Error(`Cannot find server ticket ${server_ticket_name}`);
    }
  } catch (err) {
    ctx.status = 500;
    ctx.body = {
      error: `RPC Error: ${err.message}`,
    };
    return;
  }

  const new_job = {
    name, job_type, client_ticket_name, server_ticket_name,
    client_params, server_params, status,
    federation_id: clientTicket.federation_id,
  };

  try {
    clientValidateJob(new_job, clientTicket, serverTicket);
  } catch (e) {
    ctx.status = 400;
    ctx.body = {
      error: `client_params validation failed: ${e.message}`,
    };
    return;
  }

  // update job
  try {
    await rpcClient.updateJob({
      ...new_job,
      server_params: JSON.stringify(server_params),
    });
  } catch (err) {
    ctx.status = 500;
    ctx.body = {
      error: `RPC Error: ${err.message}`,
    };
    return;
  }

  if (old_job.status === 'started' && new_job.status === 'stopped') {
    flapp = (await k8s.getFLApp(namespace, new_job.name)).flapp;
    pods = (await k8s.getFLAppPods(namespace, new_job.name)).pods;
    old_job.k8s_meta_snapshot = JSON.stringify({ flapp, pods });
    await k8s.deleteFLApp(namespace, new_job.name);
  } else if (old_job.status === 'stopped' && new_job.status === 'started') {
    const clientYaml = clientGenerateYaml(clientFed, new_job, clientTicket);
    await k8s.createFLApp(namespace, clientYaml);
  }

  old_job.client_ticket_name = new_job.client_ticket_name;
  old_job.server_ticket_name = new_job.server_ticket_name;
  old_job.client_params = new_job.client_params;
  old_job.server_params = new_job.server_params;
  old_job.status = new_job.status;
  old_job.federation_id = new_job.federation_id;

  const data = await old_job.save();

  ctx.body = { data };
});

router.delete('/api/v1/job/:id', SessionMiddleware, async (ctx) => {
  // TODO: just owner can delete
  const { id } = ctx.params;
  const data = await Job.findByPk(id);

  if (!data) {
    ctx.status = 404;
    ctx.body = {
      error: 'Job not found',
    };
    return;
  }

  if (!data.status || data.status == 'started') {
    await k8s.deleteFLApp(namespace, data.name);
  }
  await data.destroy({ force: true });

  const ticket = await Ticket.findOne({
    where: {
      name: { [Op.eq]: data.client_ticket_name },
    },
    include: 'federation',
  });
  if (!ticket) {
    ctx.status = 404;
    ctx.body = {
      error: `Ticket ${data.client_ticket_name} does not exist`,
    };
    return;
  }
  const rpcClient = new FederationClient(ticket.federation);
  try {
    await rpcClient.deleteJob({ name: data.name });
  } catch (err) {
    ctx.status = 500;
    ctx.body = {
      error: `RPC Error: ${err.message}`,
    };
    return;
  }

  ctx.body = { data };
});

module.exports = router;
