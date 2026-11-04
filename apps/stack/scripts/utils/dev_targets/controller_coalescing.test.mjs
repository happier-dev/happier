import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const owner = join(import.meta.dirname, 'controller_coalescing.mjs');

test('an ordinary controller caller after a source edit receives the edited failing test result', {
  timeout: 15000, skip: process.platform !== 'linux',
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'ce-' });
  const payload = fixture.path('edited.test.mjs');
  const gatePath = fixture.path('s');
  const connections = [];
  const gate = createServer(socket => { connections.push(socket); });
  await new Promise(resolveListen => gate.listen(gatePath, resolveListen));
  t.after(() => { for (const socket of connections) socket.destroy(); gate.close(); });
  const source = valid => `import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
test('edited contract', async () => {
  const socket = createConnection(process.env.HAPPIER_TEST_GATE);
  await once(socket, 'connect');
  console.log('source-loaded');
  await once(socket, 'data');
  socket.end();
  assert.equal(${valid}, true);
});
`;
  const callers = [];
  t.after(() => { for (const caller of callers) if (caller.exitCode === null) caller.kill('SIGTERM'); });
  const start = () => {
    const caller = spawn(process.execPath, [owner, fixture.root, fixture.root, '0', '',
      '"$HAPPIER_TEST_NODE" --test --test-reporter=tap "$HAPPIER_TEST_PAYLOAD"'], {
      env: { ...process.env, HAPPIER_TEST_NODE: process.execPath, HAPPIER_TEST_PAYLOAD: payload,
        // This payload is a separate runner, not this test's child reporter.
        NODE_TEST_CONTEXT: undefined, HAPPIER_TEST_GATE: gatePath }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    callers.push(caller);
    let stdout = '', stderr = '', ready, attached;
    const started = new Promise(resolveStarted => { ready = resolveStarted; });
    const joined = new Promise(resolveJoined => { attached = resolveJoined; });
    caller.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('source-loaded')) { ready(); attached(false); }
    });
    caller.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.includes('coalesced queued')) attached(true);
    });
    const result = new Promise(resolveExit => caller.once('close', code => resolveExit({ code, stdout, stderr })));
    return { started, joined, result };
  };
  await writeFile(payload, source(true));
  const leader = start();
  await leader.started;
  await writeFile(payload, source(false));
  const joiner = start();
  const queued = await joiner.joined;
  connections[0].write('finish');
  const leaderResult = await leader.result;
  if (queued) {
    await joiner.started;
    connections[1].write('finish');
  }
  const joinerResult = await joiner.result;
  assert.deepEqual([leaderResult.code, joinerResult.code], [0, 1]);
  assert.match(joinerResult.stdout, /ERR_ASSERTION/);
  assert.equal(connections.length, 2, 'the later caller must execute the edited source');
});

// Short prefixes keep Unix socket paths valid under worker TMPDIRs.
for (const outcome of ['success', 'failure', 'signal']) test(`queued controller followers progress after leader ${outcome} with inherited output`, {
  timeout: 15000, skip: process.platform !== 'linux',
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'cf-' });
  const gatePath = fixture.path('s');
  const payload = fixture.path('payload.cjs');
  await writeFile(payload, `const { spawn } = require('node:child_process');
const socket = require('node:net').connect(process.argv[2]);
// A dispatch lifetime reader inherits output and waits for its parent's EOF.
spawn(process.execPath, ['-e', "process.stdout.write('reader-ready' + String.fromCharCode(10)); process.stdin.resume();"], { stdio: 'inherit' });
socket.on('data', () => process.exit(Number(process.argv[3])));
socket.resume();
`);
  const connections = [];
  const arrivals = [];
  const gate = createServer(socket => {
    connections.push(socket);
    arrivals.shift()?.(socket);
  });
  await new Promise(resolveListen => gate.listen(gatePath, resolveListen));
  t.after(() => { for (const socket of connections) socket.destroy(); gate.close(); });
  const nextConnection = () => new Promise(resolveConnection => arrivals.push(resolveConnection));
  const callers = [];
  let dispatchPids = [];
  t.after(() => {
    for (const caller of callers) if (caller.exitCode === null) caller.kill('SIGTERM');
    // Only this fixture's recorded private process groups are cleanup targets.
    for (const pid of dispatchPids) {
      try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  const start = () => {
    const caller = spawn(process.execPath, [owner, fixture.root, repoRoot, '1', '',
      '"$HAPPIER_TEST_NODE" "$HAPPIER_TEST_PAYLOAD" "$HAPPIER_TEST_GATE" "$HAPPIER_TEST_EXIT"'], {
      env: { ...process.env, HAPPIER_TEST_NODE: process.execPath, HAPPIER_TEST_PAYLOAD: payload,
        HAPPIER_TEST_GATE: gatePath, HAPPIER_TEST_EXIT: outcome === 'success' ? '0' : '7' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    callers.push(caller);
    let stdout = '', stderr = '';
    let ready;
    const started = new Promise(resolveStarted => { ready = resolveStarted; });
    let queued;
    const attached = new Promise(resolveAttached => { queued = resolveAttached; });
    caller.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('reader-ready\n')) ready();
    });
    caller.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.includes('coalesced queued')) queued();
    });
    const result = new Promise(resolveExit => caller.once('close', resolveExit));
    return { attached, result, started };
  };
  const firstConnection = nextConnection();
  const first = start();
  const leader = await firstConnection;
  await first.started;
  const follower = start();
  await follower.attached;
  const status = () => JSON.parse(spawnSync(process.execPath, [owner, '--status', fixture.root], { encoding: 'utf8' }).stdout);
  const before = status();
  dispatchPids = before.dispatchPids;
  assert.equal(before.runningDispatches, 1);
  assert.equal(before.queuedFollowers, 1);
  const followerConnection = nextConnection();
  if (outcome === 'signal') process.kill(dispatchPids[0], 'SIGKILL');
  else leader.write('finish');
  assert.equal(await first.result, outcome === 'signal' ? 137 : outcome === 'success' ? 0 : 7);
  const promoted = await followerConnection;
  const after = status();
  dispatchPids = [...dispatchPids, ...after.dispatchPids];
  assert.equal(after.runningDispatches, 1);
  assert.equal(after.queuedFollowers, 0);
  assert.equal(connections.length, 2, 'one queued follower produces exactly one successor dispatch');
  await follower.started;
  promoted.write('finish');
  assert.equal(await follower.result, outcome === 'success' ? 0 : 7);
});

for (const scenario of ['remote', 'fallback-broker', 'fallback-caller']) test(scenario === 'remote'
  ? 'a controller lifetime reader does not hold AUTO target selection'
  : `late SSH refusal preserves local fallback lifetime after ${scenario === 'fallback-broker' ? 'broker death' : 'last caller cancellation'}`,
{ timeout: 60000, skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'cs-' });
  const bin = fixture.path('bin');
  await mkdir(bin);
  const executable = (name, source) => writeFile(join(bin, name), source, { mode: 0o755 });
  // Only OS/network boundaries are replaced; classification, projection,
  // coalescing, probe orchestration and command transport stay real.
  await executable('systemctl', '#!/bin/sh\nexit 1\n');
  await executable('mutagen', '#!/bin/sh\nif [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi\n');
  await executable('ssh', `#!/bin/sh
case "$*" in
  *getconf*) printf '8 0 0.1 22000000 20 0 25480397 28311552 0 0 0 0 0 0 0 linux 25480397 28311552\\n' ;;
  *remote_execution_custody.sh*" cancel "*) exit 0 ;;
  *remote_execution_custody.sh*)
    if [ "${scenario}" != remote ]; then
      while [ "$#" -gt 1 ]; do
        if [ "$1" = -E ]; then printf 'ssh: connect to host fixture: Connection refused\\n' > "$2"; break; fi
        shift
      done
      exit 255
    fi
    printf 'native-probe-dispatched\\n'; exit 7 ;;
  *) exit 0 ;;
esac
`);
  const config = fixture.path('dev-targets.json');
  await writeFile(config, JSON.stringify({ version: 3,
    targets: [{ name: 'fixture', platform: 'posix', ssh: 'fixture-host', repoDir: repoRoot,
      cliHomeDir: fixture.root, remotePath: [bin, '/usr/bin', '/bin'] }],
    runtimePlacement: { server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' } },
    commandExecution: { mode: 'auto', targets: ['fixture'], includeLocal: false, fallback: scenario === 'remote' ? 'error' : 'local' },
  }));
  const environment = { ...process.env, HOME: fixture.root, TMPDIR: fixture.root, XDG_RUNTIME_DIR: fixture.root,
    HAPPIER_EXEC_CONFIG_PATH: config, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_STORAGE_DIR: fixture.root, HAPPIER_HSTACK_DISPATCH_CONTROL: '1',
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    HAPPIER_TEST_LAUNCHER: join(repoRoot, 'apps/stack/bin/hstack-exec') };
  for (const name of ['HAPPIER_DEV_TARGET_EXECUTION', 'HAPPIER_HSTACK_EXECUTION',
    'HAPPIER_CONTROLLER_COALESCED', 'HSTACK_EXEC_CONTROLLER_LIFELINE', 'control_input_pid', 'CI']) delete environment[name];
  // A cold projection execs a fresh shell and clears its background-job table;
  // the live fleet's warm projection must be exercised without that re-entry.
  const projection = spawnSync(process.execPath, [join(import.meta.dirname, 'native_execution_projection.mjs'),
    config, fixture.path('dev-target-exec-v1.sh'), repoRoot], { cwd: repoRoot, env: environment, encoding: 'utf8' });
  assert.equal(projection.status, 0, projection.stderr);
  let connected;
  if (scenario !== 'remote') {
    const gate = createServer();
    const gatePath = fixture.path('f');
    await new Promise(resolveListen => gate.listen(gatePath, resolveListen));
    connected = new Promise(resolveConnection => gate.once('connection', resolveConnection));
    t.after(() => gate.close());
    const payload = fixture.path('fallback.cjs');
    await writeFile(payload, 'const socket = require("node:net").connect(process.argv[2]); socket.resume();\n');
    Object.assign(environment, { HAPPIER_TEST_NODE: process.execPath, HAPPIER_TEST_PAYLOAD: payload, HAPPIER_TEST_GATE: gatePath });
    await executable('probe-command', '#!/bin/sh\nexec "$HAPPIER_TEST_NODE" "$HAPPIER_TEST_PAYLOAD" "$HAPPIER_TEST_GATE"\n');
  }
  const caller = spawn(process.execPath, [owner, fixture.root, repoRoot, '0', '',
    '"$HAPPIER_TEST_LAUNCHER" -- probe-command'], { cwd: repoRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  caller.stdout.on('data', chunk => { stdout += chunk; });
  caller.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (caller.exitCode === null) caller.kill('SIGTERM'); });
  const exited = new Promise(resolveExit => caller.once('close', resolveExit));
  if (connected) {
    const socket = await Promise.race([connected, exited.then(code => { throw new Error(`fallback did not start: exit=${code}; ${stderr}`); })]);
    t.after(() => socket.destroy());
    const status = JSON.parse(spawnSync(process.execPath, [owner, '--status', fixture.root], { encoding: 'utf8' }).stdout);
    let settled = false;
    t.after(() => { if (!settled) for (const pid of status.dispatchPids) {
      try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    } });
    const closed = new Promise(resolveClose => socket.once('close', resolveClose));
    if (scenario === 'fallback-broker') process.kill(status.pid, 'SIGKILL');
    else caller.kill('SIGTERM');
    assert.equal(await exited, scenario === 'fallback-broker' ? 1 : 130, stderr);
    assert.match(stderr, /no target accepted a command connection; configured fallback=local/);
    await closed;
    settled = true;
    return;
  }
  const code = await exited;
  assert.equal(code, 7, stderr);
  assert.match(stderr, /selected fixture /);
  assert.equal(stdout, 'native-probe-dispatched\n');
});

for (const exitKind of ['payload', 'broker']) test(`controller lifetime settles after ${exitKind === 'broker' ? 'broker SIGKILL' : 'a local exec completes'}`, { timeout: 60000, skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'cl-' });
  const payload = fixture.path('payload.cjs');
  const gatePath = fixture.path('gate.sock');
  await writeFile(payload, `const socket = require('node:net').connect(process.argv[2]);
socket.once('connect', () => process.stdout.write('started\\n'));
socket.on('end', () => process.exit(7));
socket.resume();
`);
  const gate = createServer();
  await new Promise(resolveListen => gate.listen(gatePath, resolveListen));
  const connected = new Promise(resolveConnection => gate.once('connection', resolveConnection));
  t.after(() => gate.close());
  const caller = spawn(process.execPath, [owner, fixture.root, repoRoot, '0', '',
    '"$HAPPIER_TEST_LAUNCHER" --local -- "$HAPPIER_TEST_NODE" "$HAPPIER_TEST_PAYLOAD" "$HAPPIER_TEST_GATE"'], {
    env: { ...process.env, HAPPIER_TEST_LAUNCHER: join(repoRoot, 'apps/stack/bin/hstack-exec'),
      HAPPIER_TEST_NODE: process.execPath, HAPPIER_TEST_PAYLOAD: payload, HAPPIER_TEST_GATE: gatePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  caller.stdout.resume();
  caller.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolveExit => caller.once('close', code => resolveExit(code)));
  t.after(() => { if (caller.exitCode === null) caller.kill('SIGTERM'); });
  const socket = await Promise.race([connected, exited.then(code => { throw new Error(`native payload did not connect: exit=${code}; ${stderr}`); })]);
  t.after(() => socket.destroy());
  const observed = spawnSync(process.execPath, [owner, '--status', fixture.root], { encoding: 'utf8' });
  assert.equal(observed.status, 0);
  const status = JSON.parse(observed.stdout);
  assert.equal(status.dispatchPids.length, 1);
  assert.equal((await stat(dirname(status.socketPath))).mode & 0o777, 0o700);
  assert.equal((await stat(status.socketPath)).mode & 0o777, 0o600);
  assert.equal(spawnSync('flock', ['-n', status.socketPath + '.lock', 'true']).status, 0,
    'bootstrap lock must be released before a job runs or waits for admission');
  let settled = false;
  t.after(async () => {
    if (!settled) for (const pid of status.dispatchPids) {
      try { process.kill(-pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(status.socketPath, { force: true });
    await rm(status.socketPath + '.lock', { force: true });
  });
  const closed = new Promise(resolveClose => socket.once('close', resolveClose));
  if (exitKind === 'broker') {
    // The fixture owns this private repo and the exact observed broker PID.
    process.kill(status.pid, 'SIGKILL');
  } else socket.end();
  assert.equal(await exited, exitKind === 'broker' ? 1 : 7, stderr);
  t.diagnostic(`private ${exitKind} exit observed; awaiting native job socket closure`);
  await closed;
  settled = true;
});
