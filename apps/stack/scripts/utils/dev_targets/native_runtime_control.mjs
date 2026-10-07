import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveHeavyweightPressureRetryMilliseconds } from './heavyweight_pressure_cadence.mjs';

// This is the native dispatcher's control channel broker, not an admission
// owner. Every candidate, exclusion and admission is selected by hstack-exec.
// The waiting channel survives unsuccessful no-wait alternative selections.
const [launcher, ...args] = process.argv.slice(2);
const channels = new Set();
let waiting, winner, cadence, completing = false;
let pendingInput = [];
const pressureCadenceMs = resolveHeavyweightPressureRetryMilliseconds();

function stop(channel) {
  if (!channel || channel.closed) return;
  channel.stopping = true;
  channel.child.stdin.end();
  channel.child.kill('SIGTERM');
}

async function finish(code) {
  if (completing) return;
  completing = true;
  clearTimeout(cadence);
  input.close();
  process.stdin.pause();
  for (const channel of channels) if (!channel.closed) stop(channel);
  await Promise.all([...channels].map(channel => channel.completion));
  process.exitCode = code;
}

function scheduleAlternative() {
  if (completing || winner || !waiting?.worker || waiting.worker === 'local' || cadence
      || (process.env.HSTACK_EXEC_RUNTIME_SOURCE_UPLOAD === '1' && !waiting.sourceUploaded)) return;
  cadence = setTimeout(() => {
    cadence = null;
    if (completing || winner) return;
    // A selected alternative can still be flushing before actual admission.
    // Keep it alive, but exclude its worker from the next pool observation.
    // Pending selectors share the existing probe owner; do not duplicate one
    // whose worker has not yet been selected.
    if (![...channels].some(channel => channel !== waiting && !channel.closed && !channel.worker)) {
      launch('try', [...channels].map(channel => channel.worker).filter(Boolean).join(' '));
    }
    scheduleAlternative();
  }, pressureCadenceMs);
}

function choose(channel, line) {
  if (winner || completing) { stop(channel); return; }
  let ready;
  try { ready = JSON.parse(line.slice('HAPPIER_RUNTIME_BUILD_READY='.length)); }
  catch { void finish(1); return; }
  if (!ready || typeof ready.worker !== 'string' || !ready.runtimeTarget?.platform || !ready.runtimeTarget?.arch
      || (channel.worker && ready.worker !== channel.worker)) {
    process.stderr.write('[preferred-execution] invalid runtime worker READY\n');
    void finish(1);
    return;
  }
  winner = channel;
  clearTimeout(cadence);
  // READY is actual worker admission. Only now release the old queued demand;
  // failures before this point never reset its queue age or backfill charge.
  for (const other of channels) if (other !== channel) stop(other);
  process.stdout.write(`${line}\n`);
  for (const chunk of pendingInput) channel.child.stdin.write(chunk);
  pendingInput = [];
}

function launch(mode, excludedWorker = '') {
  const child = spawn(launcher, args, {
    env: { ...process.env, HSTACK_EXEC_RUNTIME_CONTROL_CHILD: mode, HSTACK_EXEC_RUNTIME_SKIP_TARGETS: excludedWorker,
      HSTACK_EXEC_PRE_DISPATCH_RETRY_COUNT: '', HSTACK_EXEC_PRE_DISPATCH_EXCLUDED_TARGETS: '',
      HSTACK_EXEC_PRE_DISPATCH_BUSY_TARGETS: '', HSTACK_EXEC_PRE_DISPATCH_SYNC_FAILED: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const channel = { child, worker: '', closed: false, stopping: false, sourceUploaded: false };
  channels.add(channel);
  child.stdin.on('error', () => {}); // Closing/canceling a losing channel is expected.
  const stdout = createInterface({ input: child.stdout });
  stdout.on('line', line => {
    if (line.startsWith('HAPPIER_RUNTIME_BUILD_READY=')) choose(channel, line);
    else if (line.startsWith('HAPPIER_RUNTIME_BUILD_PREPARE=')) {
      try {
        const { worker } = JSON.parse(line.slice('HAPPIER_RUNTIME_BUILD_PREPARE='.length));
        if (typeof worker !== 'string' || (channel.worker && worker !== channel.worker)) throw new Error('invalid source-transfer worker');
        channel.worker = worker;
        if (!channel.stopping && !completing && !winner) process.stdout.write(`${line}\n`);
      } catch (error) { process.stderr.write(`${error.message}\n`); void finish(1); }
    }
    else if (!channel.stopping) process.stdout.write(`${line}\n`);
  });
  const stderr = createInterface({ input: child.stderr });
  stderr.on('line', line => {
    if (line.startsWith('HSTACK_RUNTIME_SELECTED:')) {
      channel.worker = line.slice('HSTACK_RUNTIME_SELECTED:'.length);
      if (channel === waiting) scheduleAlternative();
    } else process.stderr.write(`${line}\n`);
  });
  channel.completion = new Promise(resolve => child.once('close', (code, signal) => {
    channel.closed = true;
    channels.delete(channel);
    resolve();
    if (completing || channel.stopping) return;
    if (channel === winner) { void finish(code ?? (signal ? 130 : 1)); return; }
    if (mode === 'try') {
      scheduleAlternative();
    } else {
      // A started worker's result is authoritative even if its READY was
      // missing/malformed. Never turn payload exits into placement retries.
      void finish(code ?? 1);
    }
  }));
  child.once('error', error => { process.stderr.write(`${error.message}\n`); void finish(1); });
  return channel;
}

const input = createInterface({ input: process.stdin });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { void finish(1); return; }
  if (typeof message?.prepareWorker === 'string') {
    const channel = [...channels].find(candidate => candidate.worker === message.prepareWorker && !candidate.closed && !candidate.stopping);
    if (channel && !channel.sourceUploaded) {
      channel.sourceUploaded = true;
      channel.child.stdin.write('source-uploaded\n');
      scheduleAlternative();
    }
    return;
  }
  if (winner) winner.child.stdin.write(line + '\n');
  else pendingInput.push(line + '\n');
});
process.stdin.on('end', () => { void finish(130); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void finish(signal === 'SIGHUP' ? 129 : 130); });
waiting = launch('wait');
