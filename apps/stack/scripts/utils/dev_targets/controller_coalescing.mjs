import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { constants } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(import.meta.url);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const send = (socket, event) => socket.write(JSON.stringify(event) + '\n');
// Native EOF now owns cancellation, including fallback. Previously loaded
// producers drain their jobs; new requests reach only this lifetime owner.
const controllerAddress = repo => `/tmp/hstack-coalesce-${process.getuid()}/v2-${digest(realpathSync(repo))}.sock`;

function readMessages(socket, consume) {
  let pending = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try { consume(JSON.parse(line)); }
      catch { socket.destroy(); return; }
    }
  });
}

async function serve(address) {
  // The bootstrap owns fd 8's kernel lock only until a listener is ready.
  // Keeping a probe connection until the joining client connects also prevents
  // an idle incumbent from exiting between discovery and attachment.
  try {
    const incumbent = await connect(address);
    closeSync(8);
    process.send?.({ ready: true });
    process.once('disconnect', () => incumbent.destroy());
    return;
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    if (error.code === 'ECONNREFUSED') {
      if (!lstatSync(address).isSocket()) throw new Error('Unexpected socket path');
      unlinkSync(address);
    }
  }
  const groups = new Map();
  const connections = new Set();
  let closing = false;
  const idle = () => {
    if (!closing && !process.connected && !groups.size && !connections.size) {
      closing = true;
      server.close();
    }
  };
  const start = (group, job) => {
    job.child = spawn('/bin/sh', ['-c', `exec ${job.request.command}`], {
      cwd: job.request.cwd,
      env: { ...job.request.environment, HAPPIER_CONTROLLER_COALESCED: '1', HSTACK_EXEC_CONTROLLER_LIFELINE: '1' },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const publish = (stream, chunk) => {
      const event = { stream, data: chunk.toString('base64') };
      for (const socket of job.clients) send(socket, event);
    };
    job.child.stdout.on('data', chunk => publish('stdout', chunk));
    job.child.stderr.on('data', chunk => publish('stderr', chunk));
    job.child.on('error', () => {}); // The close event settles spawn failure too.
    job.child.once('close', (code, signal) => {
      for (const socket of job.clients) socket.end(JSON.stringify({ exit: code ?? 128 + (constants.signals[signal] ?? 0) }) + '\n');
      group.running = group.following;
      group.following = null;
      if (group.running) start(group, group.running);
      else groups.delete(job.key);
      idle();
    });
  };
  const server = createServer(socket => {
    connections.add(socket);
    let attached;
    socket.on('error', () => {});
    socket.once('close', () => {
      connections.delete(socket);
      if (attached) {
        const { job, group } = attached;
        job.clients.delete(socket);
        if (!job.clients.size) {
          if (group.following === job) group.following = null;
          else if (group.running === job) job.child.stdin.end();
        }
      }
      idle();
    });
    readMessages(socket, request => {
      if (attached) throw new Error('Already attached');
      if (request.status) {
        const jobs = [...groups.values()].flatMap(group => [group.running, group.following].filter(Boolean));
        const attachedCallers = jobs.reduce((count, job) => count + job.clients.size, 0);
        socket.end(JSON.stringify({ status: {
          pid: process.pid,
          socketPath: address,
          dispatchPids: jobs.filter(job => job.child?.pid).map(job => job.child.pid),
          runningDispatches: jobs.filter(job => job.child).length,
          queuedFollowers: jobs.filter(job => !job.child).length,
          attachedCallers,
          duplicateCallers: attachedCallers - jobs.length,
        } }) + '\n');
        return;
      }
      // Only the policy-projected environment participates. Credential-bearing
      // options and values stay inside the digest, never a printed identifier.
      const environment = request.environmentNames.map(name => [name, request.environment[name] ?? null]);
      const key = digest([request.repo, request.identityCwd, request.command, environment]);
      let group = groups.get(key);
      if (!group) {
        group = { running: null, following: null };
        groups.set(key, group);
      }
      // A running payload may already be using an older source/dependency view.
      // Share only the unstarted follower: its normal dispatch admission runs
      // after the leader, so later callers never inherit a pre-edit result.
      const queued = Boolean(group.running);
      let job = queued ? group.following : group.running;
      if (!job) {
        job = { key, request, clients: new Set(), child: null };
        if (queued) group.following = job;
        else group.running = job;
      }
      attached = { job, group };
      job.clients.add(socket);
      send(socket, { attached: queued ? 'queued' : 'running' });
      if (!queued && !job.child) start(group, job);
    });
  });
  server.once('error', error => {
    process.send?.({ ready: false });
    closeSync(8);
    process.disconnect?.();
  });
  server.listen(address, () => {
    chmodSync(address, 0o600);
    closeSync(8);
    process.send?.({ ready: true });
  });
  process.on('disconnect', idle);
}

function connect(address) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    socket.once('error', reject);
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
  });
}

async function attach(address, request) {
  const directory = dirname(address);
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const owner = lstatSync(directory);
  if (!owner.isDirectory() || owner.uid !== process.getuid()) throw new Error('Controller directory ownership mismatch');
  chmodSync(directory, 0o700);
  let bootstrap;
  let socket;
  try { socket = await connect(address); }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    bootstrap = spawn('/bin/sh', ['-c', 'umask 077; exec 8>"$1"; flock -x 8 || exit; exec "$2" "$3" --serve "$4"',
      'hstack-coalesce-bootstrap', address + '.lock', process.execPath, entry, address], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    await new Promise((resolve, reject) => {
      bootstrap.once('error', reject);
      bootstrap.once('message', message => message.ready ? resolve() : reject(new Error('Bootstrap unavailable')));
      bootstrap.once('exit', () => reject(new Error('Bootstrap exited')));
    });
    socket = await connect(address);
    if (bootstrap.connected) bootstrap.disconnect();
    bootstrap.unref();
  }
  const listeners = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
    // Native dispatch treats both interruption signals as cancellation130.
    process.exitCode = signal === 'SIGTERM' ? 130 : 128 + constants.signals[signal];
    socket.destroy();
  }]));
  for (const [signal, listener] of listeners) process.on(signal, listener);
  let settled = false;
  readMessages(socket, event => {
    if (event.stream) process[event.stream].write(Buffer.from(event.data, 'base64'));
    else if (event.attached === 'queued') process.stderr.write('[preferred-execution] coalesced queued\n');
    else if (event.exit !== undefined) { settled = true; process.exitCode = event.exit; }
  });
  socket.on('error', () => { process.exitCode ||= 1; });
  socket.once('close', () => {
    if (!settled) process.exitCode ||= 1;
    for (const [signal, listener] of listeners) process.removeListener(signal, listener);
  });
  send(socket, request);
}

try {
  if (process.argv[2] === '--serve') await serve(process.argv[3]);
  else if (process.argv[2] === '--status') {
    try {
      const socket = await connect(controllerAddress(process.argv[3]));
      readMessages(socket, event => process.stdout.write(JSON.stringify(event.status) + '\n'));
      socket.on('error', () => { process.exitCode = 1; });
      send(socket, { status: true });
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      process.stdout.write(JSON.stringify({ runningDispatches: 0, queuedFollowers: 0, attachedCallers: 0, duplicateCallers: 0 }) + '\n');
    }
  }
  else {
    const [repo, identityCwd, , names, command] = process.argv.slice(2);
    const physicalRepo = realpathSync(repo);
    let physicalCwd = identityCwd;
    try { physicalCwd = realpathSync(identityCwd); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await attach(controllerAddress(physicalRepo), {
      repo: physicalRepo, identityCwd: physicalCwd, cwd: process.cwd(), command,
      // Older resident controllers already implement this fresh-follower bit.
      // They drain normally; callers need no second controller identity.
      typecheck: true, environmentNames: names.split(' ').filter(Boolean), environment: process.env,
    });
  }
} catch {
  process.stderr.write('[preferred-execution] controller coalescing unavailable; retry the command\n');
  process.exitCode = 1;
}
