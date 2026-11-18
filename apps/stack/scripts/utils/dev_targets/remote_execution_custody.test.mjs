import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile, access, chmod, readdir, copyFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';

const custody = new URL('./remote_execution_custody.sh', import.meta.url).pathname;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const tempHelper = new URL('../../../../../scripts/testing/process/temporaryDirectories.mjs', import.meta.url).href;

// Observe the real signal syscall boundary, including its return status. Keep
// custody's identity checks and process teardown real beneath this observer.
function spawnObservedCustody(args, options) {
  const child = spawn('/bin/bash', ['-c', `
    kill() {
      local status observed_signal=$1
      builtin kill "$@" 2>/dev/null; status=$?
      [ "$observed_signal" != -s ] || observed_signal="-$2"
      case "$observed_signal" in
        -TERM|-KILL) printf '[fixture-signal] %s %s %s\\n' "$observed_signal" "\${!#}" "$status" >&5 ;;
      esac
      return "$status"
    }
    systemctl() {
      local status
      command systemctl "$@"; status=$?
      if [ "$2" = kill ]; then
        printf '[fixture-signal] -%s %s %s\\n' "\${3#--signal=}" "\${!#}" "$status" >&5
      fi
      return "$status"
    }
    export -f kill systemctl
    exec /bin/bash "$@"
  `, 'custody-observer', custody, ...args], { ...options, stdio: [...options.stdio, 'ignore', 'ignore', 'pipe'] });
  let trace = '';
  child.stdio[5].on('data', chunk => { trace += chunk; });
  child.custodySignalTrace = () => trace;
  return child;
}

function signalEvents(stderr) {
  const prefix = '[preferred-execution] custody_signal ';
  return stderr.split(/\r?\n/u).filter(line => line.startsWith(prefix))
    .map(line => JSON.parse(line.slice(prefix.length)));
}

function assertSignalEvents(stderr, executionId, trace, initiatingExecutionId = executionId) {
  const events = signalEvents(stderr);
  const syscalls = trace.split(/\r?\n/u).filter(line => line.startsWith('[fixture-signal] '))
    .map(line => {
      const [, signal, target, result] = line.split(' ');
      return { signal: signal.slice(1), target: target.startsWith('happier-jobs-') ? target : Number(target), result: Number(result) };
    });
  const actual = events.map(event => {
    assert.deepEqual(Object.keys(event).sort(), ['at', 'execution_id', 'initiating_execution_id', 'members', 'reason', 'signal', 'syscall_result', 'target_id', 'target_kind']);
    assert.match(event.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u);
    assert.equal(event.execution_id, executionId);
    assert.equal(event.initiating_execution_id, initiatingExecutionId);
    assert.ok(['completed', 'lifeline_eof', 'signal', 'custody_cancel', 'controller_orphan_cleanup', 'reaper_orphan', 'native_cleanup'].includes(event.reason));
    assert.ok(['pid', 'pgid', 'scope'].includes(event.target_kind));
    if (event.target_kind === 'scope') assert.match(event.target_id, /^happier-jobs-\d+-\d+\.scope$/u);
    else assert.ok(Number.isSafeInteger(event.target_id) && event.target_id > 0);
    assert.ok(Array.isArray(event.members));
    for (const member of event.members) assert.match(member, /^\d+:\d+$/u);
    return { signal: event.signal, target: event.target_kind === 'pgid' ? -event.target_id : event.target_id, result: event.syscall_result };
  });
  const sorted = values => values.map(value => JSON.stringify(value)).sort();
  assert.deepEqual(sorted(actual), sorted(syscalls), 'every actual TERM/KILL must have exactly one result event');
  return events;
}

test('unrelated nondumpable process does not veto abandoned scratch while a live command keeps its root', { skip: process.platform !== 'linux' }, async t => {
  if (spawnSync('sudo', ['-n', 'true']).status !== 0) return t.skip('noninteractive procfs observation unavailable');
  if (spawnSync('python3', ['--version']).status !== 0) return t.skip('native nondumpable fixture requires python3');
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-nondumpable-' });
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const identity = new URL('../proc/native_process_identity.sh', import.meta.url).pathname;
  const token = spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity', identity, String(process.pid)], { encoding: 'utf8' }).stdout.trim();
  const directories = Array.from({ length: 8 }, (_, index) => join(root, `happier-stack-unit-abandoned-${index}`));
  const held = join(root, 'happier-stack-unit-held');
  const opaqueHeld = join(root, 'happier-stack-unit-opaque-held');
  for (const directory of [...directories, held, opaqueHeld]) {
    await mkdir(directory);
    await writeFile(join(directory, '.happier-test-temp-owner'), `happier-test-temp-v1\n${bootId}\n2147483647\n${token}\n2147483647\n`);
  }
  const heldChild = join(held, 'child');
  const opaqueChild = join(opaqueHeld, 'child');
  await mkdir(heldChild);
  await mkdir(opaqueChild);
  const fixtures = [
    spawn('python3', ['-u', '-c', 'import ctypes,sys\nassert ctypes.CDLL(None).prctl(4,0,0,0,0)==0\nprint("ready",flush=True)\nsys.stdin.read()'], {
      env: { ...process.env, TMPDIR: opaqueChild }, stdio: ['pipe', 'pipe', 'pipe'],
    }),
    spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));console.log("ready")'], {
      env: { ...process.env, TMPDIR: heldChild }, stdio: ['pipe', 'pipe', 'pipe'],
    }),
  ];
  await Promise.all(fixtures.map(async child => {
    const closed = once(child, 'close');
    t.after(async () => { child.stdin.end(); await closed; });
    await Promise.race([
      once(child.stdout, 'data'),
      closed.then(() => { throw new Error('native custody fixture exited before readiness'); }),
    ]);
  }));
  const fixtureEnv = await processCensusEnv(root, fixtures.map(child => child.pid));
  const result = spawnSync('/bin/bash', [custody, 'reap-test-temp-roots', '-', '-'], {
    env: { ...fixtureEnv, TMPDIR: root }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  let reclaimed = 0;
  for (const directory of directories) {
    try { await access(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; reclaimed++; }
  }
  assert.equal(reclaimed, directories.length, 'one unrelated nondumpable process must not veto the abandoned-root batch');
  await access(held);
  await access(opaqueHeld); // Ignoring unreadable processes would lose this live root.
  // A readable holder must protect the same ancestor as the denied-read
  // collector. Scope only the OS census, keeping real procfs binding reads.
  const readableEnv = await processCensusEnv(root, [fixtures[1].pid]);
  const readable = spawnSync('/bin/bash', [custody, 'test-temp-users', held, 'readable'], {
    env: { ...readableEnv, TMPDIR: root }, encoding: 'utf8',
  });
  assert.equal(readable.status, 0, readable.stderr);
  assert.ok(new Set(readable.stdout.split('\n')).has(held));
  await access(held);
  await access(opaqueHeld);
  // The fallback observer inherits its caller's environment unless custody
  // removes those bindings. It must not retain its own finished command root.
  const commandEnv = await processCensusEnv(root, fixtures.map(child => child.pid));
  delete commandEnv.TMPDIR;
  const command = spawnSync('/bin/bash', [custody, 'run', join(root, 'worker-home/remote-exec/completed.pid'), 'completed',
    process.execPath, '-e', 'console.log(process.env.TMPDIR)'], { env: commandEnv, encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  await assert.rejects(access(command.stdout.trim()), { code: 'ENOENT' }, 'the observer must not retain finished private scratch');
});

async function processCensusEnv(root, pids) {
  if (process.platform !== 'linux') return { ...process.env };
  // Scope only the OS census to the fixture's known processes. Denied host
  // reads have a separate native contract above. Keep real /proc/group checks.
  writeFakeBin({ root, name: 'ps', content: `#!/bin/sh
if [ "$*" = '-eo pid=,pgid=,stat=,uid=' ]; then
  exec /bin/ps -p ${pids.join(',')} -o pid=,pgid=,stat=,uid=
fi
exec /bin/ps "$@"
` });
  return { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` };
}

test('routed scratch defaults beneath the disk-backed worker home and preserves an explicit TMPDIR', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-worker-scratch-' });
  const workerHome = join(root, 'worker-home');
  const env = await processCensusEnv(root, [process.pid]);
  delete env.TMPDIR;
  delete env.TMP;
  delete env.TEMP;
  const explicit = join(root, 'explicit');
  await mkdir(explicit);
  for (const tmpdir of [undefined, '', explicit]) {
    const invocationEnv = { ...env, ...(tmpdir === undefined ? {} : { TMPDIR: tmpdir }) };
    const result = spawnSync('/bin/bash', [custody, 'run', join(workerHome, 'remote-exec/scratch.pid'), 'scratch',
      process.execPath, '--input-type=module', '-e', `
        import { mkdtempSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        const scratch = mkdtempSync(join(tmpdir(), 'hstack-payload-scratch-'));
        mkdtempSync(join(tmpdir(), 'yarn--'));
        console.log(scratch);
        rmSync(scratch, { recursive: true });
      `], { env: invocationEnv, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const scratchParent = dirname(result.stdout.trim());
    if (tmpdir || process.platform !== 'linux') assert.equal(scratchParent, tmpdir || join(workerHome, 'tmp'));
    else {
      assert.equal(dirname(scratchParent), join(workerHome, 'tmp'));
      assert.match(scratchParent, /hstack-/);
      await assert.rejects(access(scratchParent), { code: 'ENOENT' }, result.stderr);
    }
  }
});

test('completed commands leave no private scratch roots containing read-only Go module caches', { skip: process.platform !== 'linux' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-readonly-command-', registerCleanup: false });
  const { root } = fixture;
  const paths = [];
  t.after(async () => {
    for (const path of paths) await chmod(join(path, 'go-cache'), 0o700).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fixture.cleanup();
  });
  const env = await processCensusEnv(root, [process.pid]);
  delete env.TMPDIR;
  delete env.TMP;
  delete env.TEMP;
  for (let index = 0; index < 3; index++) {
    const result = spawnSync('/bin/bash', [custody, 'run', join(root, `worker-home/remote-exec/completed-${index}.pid`), `completed-${index}`,
      process.execPath, '--input-type=module', '-e', `
        import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
        import { join } from 'node:path';
        const root = process.env.TMPDIR;
        console.log(root);
        const cache = join(root, 'go-cache');
        mkdirSync(cache);
        writeFileSync(join(cache, 'module'), 'compiler cache');
        chmodSync(cache, 0o500);
      `], { env, encoding: 'utf8' });
    paths.push(result.stdout.trim());
    assert.equal(result.status, 0, 'successful command teardown must remove its read-only cache');
  }
  assert.equal((await readdir(join(root, 'worker-home/tmp'))).length, 0, 'N completed executions retain zero private roots');
});

test('command scratch is removed after failure and every trappable cancellation path', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-command-exits-' });
  const env = await processCensusEnv(root, [process.pid]);
  delete env.TMPDIR;
  delete env.TMP;
  delete env.TEMP;
  for (const mode of ['failure', 'SIGHUP', 'SIGINT', 'SIGTERM', 'lifeline']) {
    await t.test(mode, async () => {
      const child = spawn('/bin/bash', [custody, 'run', join(root, `worker-home/remote-exec/${mode}.pid`), mode,
        process.execPath, '-e', `console.log(process.env.TMPDIR);${mode === 'failure' ? 'process.exit(23)' : 'process.stdin.resume();setInterval(()=>{},1000)'}`], {
        env: { ...env, ...(mode === 'lifeline' ? { HAPPIER_REMOTE_EXEC_LIFELINE: '1' } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '', error = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { error += chunk; });
      const closed = once(child, 'close');
      t.after(() => child.kill('SIGTERM'));
      await waitFor(() => output.includes('\n'), 'payload did not publish command scratch');
      if (mode === 'lifeline') child.stdin.end();
      else if (mode !== 'failure') child.kill(mode);
      const [code, signal] = await closed;
      assert.equal(signal, null, error);
      if (mode === 'lifeline') assert.ok([130, 143].includes(code), error);
      else assert.equal(code, mode === 'failure' ? 23 : 130, error);
      await assert.rejects(access(output.trim()), { code: 'ENOENT' }, error);
    });
  }
});

test('default command scratch admits Chromium singleton sockets on the disk-backed worker path', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-socket-', parentDir: '/tmp' });
  const env = { ...process.env };
  delete env.TMPDIR;
  const result = spawnSync('/bin/bash', [custody, 'run', join(root, 'worker-home/remote-exec/socket.pid'), 'socket',
    process.execPath, '--input-type=module', '-e', `
      import { mkdtempSync, accessSync, rmSync } from 'node:fs';
      import { createServer } from 'node:net';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      // Exercise the observed Chromium pathname at the real OS boundary.
      const singleton = mkdtempSync(join(tmpdir(), 'org.chromium.Chromium.'));
      const server = createServer();
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(join(singleton, 'SingletonSocket'), resolve);
        });
        accessSync(join(singleton, 'SingletonSocket'));
        await new Promise(resolve => server.close(resolve));
      } finally { rmSync(singleton, { recursive: true, force: true }); }
    `], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('private scratch cleanup retains an older process that receives its binding and execs', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-older-process-' });
  const handoff = join(root, 'handoff');
  assert.equal(spawnSync('mkfifo', [handoff]).status, 0);
  // A pre-existing worker can receive a new scratch path through IPC. exec
  // publishes its new environment without changing the kernel birth token.
  const older = spawn('/bin/bash', ['-c', 'IFS= read -r directory < "$1"; exec env TMPDIR="$directory" /bin/sleep 300', '-', handoff], {
    detached: true, stdio: 'ignore',
  });
  t.after(async () => { const closed = once(older, 'close'); older.kill('SIGTERM'); await closed; });
  const identity = new URL('../proc/native_process_identity.sh', import.meta.url).pathname;
  const olderToken = Number(spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity', identity, String(older.pid)], { encoding: 'utf8' }).stdout);
  assert.ok(olderToken > 0);
  // Establish a strictly older holder, so this detects an age-based shortcut.
  // Observe a later kernel identity without guessing a tick duration.
  await waitFor(() => Number(spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$$"', 'identity', identity], { encoding: 'utf8' }).stdout) > olderToken,
    'kernel birth token did not advance past the older fixture');
  const env = await processCensusEnv(root, [older.pid]);
  delete env.TMPDIR;
  const result = spawnSync('/bin/bash', [custody, 'run', join(root, 'worker-home/remote-exec/older.pid'), 'older', process.execPath, '--input-type=module', '-e', `
    import { writeFileSync, readFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(handoff)}, process.env.TMPDIR + '\\n');
    while (!readFileSync('/proc/${older.pid}/environ', 'utf8').split('\\0').includes('TMPDIR=' + process.env.TMPDIR)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    console.log(process.env.TMPDIR);
  `], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Number(spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity', identity, String(older.pid)], { encoding: 'utf8' }).stdout), olderToken);
  assert.ok(running(older.pid), 'scratch cleanup must leave the external holder alive');
  await access(result.stdout.trim());
});

test('command exit retains a detached cwd holder without an inherited temporary binding', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-command-cwd-holder-' });
  const env = await processCensusEnv(root, [process.pid]);
  const holderFile = join(root, 'holder.pid');
  writeFakeBin({ root, name: 'ps', content: `#!/bin/sh
if [ "$*" = '-eo pid=,pgid=,stat=,uid=' ]; then
  extra=$(cat ${quote(holderFile)} 2>/dev/null)
  exec /bin/ps -p ${process.pid}\${extra:+,$extra} -o pid=,pgid=,stat=,uid=
fi
exec /bin/ps "$@"
` });
  delete env.TMPDIR;
  delete env.TMP;
  delete env.TEMP;
  const result = spawnSync('/bin/bash', [custody, 'run', join(root, 'worker-home/remote-exec/held.pid'), 'held',
    process.execPath, '--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      import { tmpdir } from 'node:os';
      import { writeFileSync } from 'node:fs';
      const env = { ...process.env };
      delete env.TMPDIR; delete env.TMP; delete env.TEMP;
      const directory = tmpdir();
      const holder = spawn('/bin/sleep', ['300'], { cwd: directory, env, detached: true, stdio: 'ignore' });
      holder.unref();
      writeFileSync(${JSON.stringify(holderFile)}, String(holder.pid));
      console.log(JSON.stringify({ directory, pid: holder.pid }));
    `], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const held = JSON.parse(result.stdout.trim());
  t.after(() => { try { process.kill(held.pid, 'SIGTERM'); } catch {} });
  assert.ok(running(held.pid), 'the detached holder remains live');
  await access(held.directory);
});

test('explicit maintenance reclaims marked dead temp owners while retaining live groups, reused PIDs and unmarked neighbors', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-custody-' });
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const identity = new URL('../proc/native_process_identity.sh', import.meta.url).pathname;
  const token = spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity', identity, String(process.pid)], { encoding: 'utf8' }).stdout;
  const liveGroup = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
  t.after(() => liveGroup.kill('SIGTERM'));
  const env = await processCensusEnv(root, [process.pid, liveGroup.pid]);
  const marker = (pid, start, group) => `happier-test-temp-v1\n${bootId}\n${pid}\n${start}\n${group}\n`;
  const roots = {};
  for (const [name, owner] of Object.entries({
    'happier-stack-unit-dead': marker(2147483647, token, 2147483647),
    'happier-dev-test-reused': marker(process.pid, `${token}0`, 2147483647),
    'happier-external-hooks-config-live': marker(process.pid, token, 2147483647),
    'docs-check-child': marker(2147483647, token, liveGroup.pid),
    'docs-check-unmarked': null,
    'unrelated-scratch': marker(2147483647, '1', 2147483647),
  })) {
    const directory = join(root, name);
    await mkdir(directory);
    if (owner) await writeFile(join(directory, '.happier-test-temp-owner'), owner);
    roots[name] = directory;
  }
  const result = spawnSync('/bin/bash', [custody, 'reap-test-temp-roots', '-', '-'], { env: { ...env, TMPDIR: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(roots['happier-stack-unit-dead']), { code: 'ENOENT' });
  await assert.rejects(access(roots['happier-dev-test-reused']), { code: 'ENOENT' });
  for (const name of ['happier-external-hooks-config-live', 'docs-check-child', 'docs-check-unmarked', 'unrelated-scratch']) await access(roots[name]);
  assert.ok(running(liveGroup.pid), 'temp reclamation signaled a live child group');
});

test('abandoned test Home reclamation observes the process census once per pass, not once per root, and retains a root a live process works in', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-batch-' });
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const identity = new URL('../proc/native_process_identity.sh', import.meta.url).pathname;
  const token = spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity', identity, String(process.pid)], { encoding: 'utf8' }).stdout;
  const abandoned = Array.from({ length: 8 }, (_, index) => join(root, `happier-test-home-abandoned-${index}`));
  for (const directory of abandoned) await mkdir(directory);
  // A live process that dropped the binding but still works inside a root.
  const worker = { ...process.env };
  delete worker.HAPPIER_TEST_TEMP_ROOTS;
  const holder = spawn('/bin/sleep', ['300'], { cwd: abandoned[0], detached: true, stdio: 'ignore', env: worker });
  t.after(() => holder.kill('SIGTERM'));
  const env = await processCensusEnv(root, [process.pid, holder.pid]);
  // Count census launches at the process boundary; the census itself runs.
  const censusLog = join(root, 'census.log');
  writeFakeBin({ root, name: 'node', content: `#!/bin/sh
case "$*" in *--test-temp-users*) echo census >> ${quote(censusLog)} ;; esac
exec ${quote(process.execPath)} "$@"
` });
  for (const directory of abandoned) {
    await writeFile(join(directory, '.happier-test-temp-owner'), `happier-test-temp-v1\n${bootId}\n2147483647\n${token}\n2147483647\n`);
  }
  const result = spawnSync('/bin/bash', [custody, 'reap-test-temp-roots', '-', '-'], { env: { ...env, TMPDIR: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('happier-test-home-')), ['happier-test-home-abandoned-0'], result.stderr);
  assert.equal((await readFile(censusLog, 'utf8')).trim().split('\n').length, 1);
});

test('test-root reclamation skips the process census when every candidate is retained by its live group', { skip: process.platform !== 'linux' }, async t => {
  // Every top-level test producer runs this pass at exit (2026-11-16 controller: ~2.6 full censuses a
  // minute, ~3 CPU-s each). A root whose creator group still lives is retained whatever the census says.
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-live-groups-' });
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const identity = new URL('../proc/native_process_identity.sh', import.meta.url).pathname;
  const token = spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity', identity, String(process.pid)], { encoding: 'utf8' }).stdout;
  const liveGroup = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
  t.after(() => liveGroup.kill('SIGTERM'));
  const env = await processCensusEnv(root, [process.pid, liveGroup.pid]);
  const censusLog = join(root, 'census.log');
  await writeFile(censusLog, '');
  writeFakeBin({ root, name: 'node', content: `#!/bin/sh
case "$*" in *--test-temp-users*) echo census >> ${quote(censusLog)} ;; esac
exec ${quote(process.execPath)} "$@"
` });
  const retained = Array.from({ length: 3 }, (_, index) => join(root, `happier-test-home-live-group-${index}`));
  for (const directory of retained) {
    await mkdir(directory);
    await writeFile(join(directory, '.happier-test-temp-owner'), `happier-test-temp-v1\n${bootId}\n2147483647\n${token}\n${liveGroup.pid}\n`);
  }
  const result = spawnSync('/bin/bash', [custody, 'reap-test-temp-roots', '-', '-'], { env: { ...env, TMPDIR: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const directory of retained) await access(directory);
  assert.equal((await readFile(censusLog, 'utf8')).trim(), '', 'no census for candidates their live group already retains');
});

test('maintenance reclaims dead scratch when a census process exits before its environment is read', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-stale-census-' });
  const identity = new URL('../proc/native_process_identity.sh', import.meta.url).pathname;
  const token = spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity', identity, String(process.pid)], { encoding: 'utf8' }).stdout;
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const directory = join(root, 'happier-stack-unit-dead');
  await mkdir(directory);
  await writeFile(join(directory, '.happier-test-temp-owner'), `happier-test-temp-v1\n${bootId}\n2147483647\n${token}\n2147483647\n`);
  // Keep this real exited child unreaped by blocking its Node parent below.
  // Only ps's OS snapshot is stale; the native identity and /proc are real.
  const exiting = spawn('/usr/bin/true', [], { stdio: 'ignore' });
  const result = spawnSync('/bin/bash', ['-c', `
    . ${quote(identity)}
    while heavyweight_process_is_current ${exiting.pid} -; do sleep 0.01; done
    ps() {
      if [ "$*" = '-eo pid=,pgid=,stat=,uid=' ]; then
        command ps -p ${exiting.pid} -o pid=,pgid=,stat=,uid= | awk '{$3="S"; print}'
      else command ps "$@"; fi
    }
    export -f ps
    exec /bin/bash ${quote(custody)} reap-test-temp-roots - -
  `], { env: { ...process.env, TMPDIR: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(access(directory), { code: 'ENOENT' }, result.stderr);
});

test('dispatch cost does not scale with retained temporary roots sharing one process inventory', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-inventory-' });
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const identity = new URL('../proc/native_process_identity.sh', import.meta.url).pathname;
  const token = spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity', identity, String(process.pid)], { encoding: 'utf8' }).stdout;
  const directories = Array.from({ length: 64 }, (_, index) => join(root, `happier-stack-unit-retained-${index}`));
  // A surviving OS process is the genuine custody boundary. The synthetic
  // environment makes repeated /proc scans dominate launch noise on small hosts.
  const holder = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore', env: {
    ...process.env, HAPPIER_TEST_TEMP_ROOTS: directories.join('\n'), HAPPIER_CUSTODY_SCAN_FIXTURE: 'x'.repeat(64 * 1024),
  } });
  t.after(() => holder.kill('SIGTERM'));
  const createRoot = async directory => {
    await mkdir(directory);
    await writeFile(join(directory, '.happier-test-temp-owner'), `happier-test-temp-v1\n${bootId}\n2147483647\n${token}\n2147483647\n`);
  };
  const dispatch = () => {
    const started = performance.now();
    const result = spawnSync('/bin/bash', [custody, 'run', join(root, 'remote-exec/inventory.pid'), 'inventory', '/usr/bin/true'], {
      env: { ...process.env, TMPDIR: root }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return performance.now() - started;
  };
  await createRoot(directories[0]);
  const oneRoot = dispatch();
  for (const directory of directories.slice(1)) await createRoot(directory);
  const deadNeighbor = join(root, 'happier-stack-unit-dead-neighbor');
  await createRoot(deadNeighbor);
  const manyRoots = dispatch();
  t.diagnostic(`retained-root dispatch: one=${oneRoot.toFixed(0)}ms, 64=${manyRoots.toFixed(0)}ms`);
  await access(deadNeighbor); // Dispatch must not sweep shared scratch at all.
  for (const directory of directories) await access(directory);
  assert.ok(running(holder.pid), 'retained-root inventory signaled its live holder');
  // This is a relative scaling contract, not a launch timeout: a 64x root
  // increase must not multiply the process-environment work by the same factor.
  assert.ok(manyRoots < oneRoot * 8, `retained-root dispatch scaled from ${oneRoot.toFixed(0)}ms to ${manyRoots.toFixed(0)}ms`);
});

test('SIGKILL temp creator retains its root until its surviving child group exits', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-sigkill-' });
  const creator = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createTestTempDirectory } from ${JSON.stringify(tempHelper)};
    import { spawn } from 'node:child_process';
    const fixture = createTestTempDirectory('happier-stack-unit-', ${JSON.stringify(root)});
    const child = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
    console.log(JSON.stringify({ root: fixture.root, child: child.pid }));
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', childPid, directory;
  creator.stdout.on('data', chunk => { output += chunk; });
  t.after(() => {
    creator.kill('SIGKILL');
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
  });
  await waitFor(() => output.includes('\n'), 'temp creator did not publish its root');
  ({ root: directory, child: childPid } = JSON.parse(output.trim()));
  const env = await processCensusEnv(root, [process.pid, childPid]);
  const closed = once(creator, 'close');
  creator.kill('SIGKILL');
  await closed;
  const dispatch = () => spawnSync('/bin/bash', [custody, 'reap-test-temp-roots', '-', '-'], { env: { ...env, TMPDIR: root }, encoding: 'utf8' });
  assert.equal(dispatch().status, 0);
  await access(directory);
  assert.ok(running(childPid), 'the reaper killed a surviving temp owner');
  process.kill(childPid, 'SIGTERM');
  await waitFor(() => !running(childPid), 'fixture child did not stop');
  const cleanup = dispatch();
  assert.equal(cleanup.status, 0, cleanup.stderr);
  await assert.rejects(access(directory), { code: 'ENOENT' }, cleanup.stderr);
});

test('remote cancellation removes roots created by its payload after the group stops', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-cancel-' });
  const env = { ...process.env };
  delete env.TMPDIR;
  const cancellationEnv = await processCensusEnv(root, [process.pid]);
  delete cancellationEnv.TMPDIR;
  const child = spawn('/bin/bash', [custody, 'run', join(root, 'remote-exec/cancel.pid'), 'cancel', process.execPath, '--input-type=module', '-e', `
    import { createTestTempDirectory } from ${JSON.stringify(tempHelper)};
    const fixture = createTestTempDirectory('happier-dev-test-bin-');
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    mkdtempSync(join(tmpdir(), 'yarn--'));
    console.log(fixture.root);
    setInterval(() => {}, 1000);
  `], { env: cancellationEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  t.after(() => child.kill('SIGTERM'));
  const closed = once(child, 'close');
  await waitFor(() => output.includes('\n'), 'payload did not publish its temp root');
  child.kill('SIGTERM');
  assert.deepEqual(await closed, [130, null], error);
  await assert.rejects(access(output.trim()), { code: 'ENOENT' }, error);
  await assert.rejects(access(dirname(output.trim())), { code: 'ENOENT' }, error);
  const escaped = spawnSync('/bin/bash', [custody, 'run', join(root, 'remote-exec/escaped.pid'), 'escaped', process.execPath, '--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    import { tmpdir } from 'node:os';
    const child = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(JSON.stringify({ root: tmpdir(), pid: child.pid }));
  `], { env, encoding: 'utf8' });
  assert.equal(escaped.status, 0, escaped.stderr);
  const inheritor = JSON.parse(escaped.stdout.trim());
  t.after(() => { try { process.kill(inheritor.pid, 'SIGTERM'); } catch {} });
  await access(inheritor.root);
  assert.ok(running(inheritor.pid), 'command teardown touched a detached scratch consumer');
});

test('detached descendants retain inherited temporary roots after their creator and its group exit', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-temp-detached-' });
  const creator = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createTestTempDirectory } from ${JSON.stringify(tempHelper)};
    import { spawn } from 'node:child_process';
    const fixture = createTestTempDirectory('happier-stack-unit-', ${JSON.stringify(root)});
    const child = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
    console.log(JSON.stringify({ root: fixture.root, child: child.pid }));
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', childPid, directory;
  creator.stdout.on('data', chunk => { output += chunk; });
  t.after(() => {
    creator.kill('SIGKILL');
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
  });
  await waitFor(() => output.includes('\n'), 'detached creator did not publish its root');
  ({ root: directory, child: childPid } = JSON.parse(output.trim()));
  const env = await processCensusEnv(root, [process.pid, childPid]);
  const closed = once(creator, 'close');
  creator.kill('SIGKILL');
  await closed;
  const dispatch = () => spawnSync('/bin/bash', [custody, 'reap-test-temp-roots', '-', '-'], { env: { ...env, TMPDIR: root }, encoding: 'utf8' });
  assert.equal(dispatch().status, 0);
  await access(directory);
  assert.ok(running(childPid), 'the reaper signaled an escaped temp owner');
  process.kill(childPid, 'SIGTERM');
  await waitFor(() => !running(childPid), 'detached fixture child did not stop');
  const cleanup = dispatch();
  assert.equal(cleanup.status, 0, cleanup.stderr);
  await assert.rejects(access(directory), { code: 'ENOENT' }, cleanup.stderr);
});
function running(pid) {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() && !result.stdout.trim().startsWith('Z');
}
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

test('dispatch startup avoids per-record processes and blocked custody performs no recurring probes', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-custody-cost-' });
  const records = join(root, 'remote-exec');
  await mkdir(records);
  // Match the observed retained-record scale without creating hundreds of
  // artificial workers: each record names this genuinely live parent.
  for (let index = 0; index < 505; index++) {
    await writeFile(join(records, `native-live ${index}.pid`), `${process.pid}\n`);
  }
  const trace = join(root, 'process-counts');
  for (const name of ['ps', 'sed', 'tr']) {
    writeFakeBin({ root, name, content: `#!/bin/sh
case ${name}:"$1" in
  ps:-p) printf 'pid-probe\\n' >> "$CUSTODY_COUNT_TRACE" ;;
  sed:*) case "$3" in */remote-exec/native-*.pid) printf 'record-read\\n' >> "$CUSTODY_COUNT_TRACE" ;; esac ;;
  tr:*) printf 'trim-process\\n' >> "$CUSTODY_COUNT_TRACE" ;;
esac
exec /usr/bin/${name} "$@"
` });
  }
  await writeFile(trace, '');
  const child = spawn('/bin/bash', [custody, 'run', join(records, 'current.pid'), 'current', process.execPath, '-e',
    'console.log("blocked");process.stdin.resume();process.stdin.once("end",()=>process.exit(0))'], {
    env: { ...process.env, TMPDIR: root, PATH: join(root, 'bin') + ':' + process.env.PATH, CUSTODY_COUNT_TRACE: trace },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => { child.stdin.end(); await closed; });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  await waitFor(() => output.includes('blocked\n'), () => `custody payload did not block: ${error}`);
  const startup = await readFile(trace, 'utf8');
  const counts = Object.fromEntries(['pid-probe', 'record-read', 'trim-process'].map(name => [name, startup.split('\n').filter(line => line === name).length]));
  assert.deepEqual(counts, { 'pid-probe': 0, 'record-read': 0, 'trim-process': 0 }, 'retained live records require no per-record subprocesses');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await readFile(trace, 'utf8'), startup, 'blocked custody must not repeat process probes');
});

test('failed process inventory preserves native records instead of declaring their owners dead', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-custody-inventory-' });
  const records = join(root, 'remote-exec');
  await mkdir(records);
  const record = join(records, 'native-unobserved.pid');
  await writeFile(record, `${process.pid}\n`);
  writeFakeBin({ root, name: 'ps', content: '#!/bin/sh\nexit 1\n' });
  writeFakeBin({ root, name: 'uname', content: '#!/bin/sh\nprintf "Darwin\\n"\n' });
  const result = spawnSync('/bin/bash', [custody, 'run', join(records, 'current.pid'), 'current', '/usr/bin/true'], {
    env: { ...process.env, TMPDIR: root, PATH: join(root, 'bin') + ':' + process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(record, 'utf8'), `${process.pid}\n`);
});

test('new dispatch reaps identified legacy native orphans and preserves live and reused PID neighbors', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-custody-' });
  const records = join(root, 'remote-exec');
  await mkdir(records);
  const deadFile = join(records, 'native-dead.pid');
  await writeFile(deadFile, '2147483647\n');
  const orphanId = 'native-orphan-1791280000';
  const orphanFile = join(records, `${orphanId}.pid`);
  const childFile = join(root, 'stubborn.pid');
  const body = `printf '%s\\n' "$$" > ${quote(orphanFile)}; bash -c ${quote(`trap '' TERM; printf '%s\\n' "$$" > ${quote(childFile)}; while :; do sleep 1; done`)} & wait`;
  const parent = spawnSync(process.execPath, ['-e', `require('node:child_process').spawn('/bin/bash', ['-c', ${JSON.stringify(body)}, ${JSON.stringify(orphanId)}], { detached: true, stdio: 'ignore' }).unref();`]);
  assert.equal(parent.status, 0);
  let orphanPid, childPid;
  t.after(() => {
    for (const pid of [orphanPid, childPid]) { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
  });
  await waitFor(async () => {
    orphanPid = Number(await readFile(orphanFile, 'utf8').catch(() => '0'));
    childPid = Number(await readFile(childFile, 'utf8').catch(() => '0'));
    return orphanPid > 0 && childPid > 0;
  }, 'legacy native execution did not start');
  const liveId = 'native-live-1791280000';
  const live = spawn('/bin/bash', ['-c', 'while :; do sleep 1; done', liveId], { stdio: 'ignore' });
  t.after(() => live.kill('SIGTERM'));
  const liveFile = join(records, `${liveId}.pid`);
  await writeFile(liveFile, `${live.pid}\n`);
  const reusedFile = join(records, 'native-reused-1791280000.pid');
  await writeFile(reusedFile, `${live.pid}\n`);
  const unrelatedFile = join(root, 'unrelated.pid');
  const unrelatedParent = spawnSync(process.execPath, ['-e', `const child = require('node:child_process').spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(unrelatedFile)}, String(child.pid)); child.unref();`]);
  assert.equal(unrelatedParent.status, 0);
  const unrelatedPid = Number(await readFile(unrelatedFile, 'utf8'));
  t.after(() => { try { process.kill(unrelatedPid, 'SIGTERM'); } catch {} });
  const mismatchedFile = join(records, 'native-mismatched-1791280000.pid');
  await writeFile(mismatchedFile, `${unrelatedPid}\n`);
  const next = spawnObservedCustody(['run', join(records, 'native-next-1791280000.pid'), 'native-next-1791280000', '/usr/bin/true'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  next.stderr.on('data', chunk => { error += chunk; });
  assert.deepEqual(await once(next, 'close'), [0, null], error);
  const events = assertSignalEvents(error, orphanId, next.custodySignalTrace(), 'native-next-1791280000');
  assert.ok(events.some(event => event.target_kind === 'pid' && event.target_id === childPid && event.signal === 'KILL'), error);
  for (const event of events) assert.equal(event.reason, 'reaper_orphan');
  await waitFor(() => !running(childPid) && !running(orphanPid), 'legacy orphan survived reaping');
  await assert.rejects(readFile(orphanFile), { code: 'ENOENT' });
  await assert.rejects(readFile(deadFile), { code: 'ENOENT' });
  assert.ok(running(live.pid), 'live neighbor was terminated');
  assert.equal(await readFile(liveFile, 'utf8'), `${live.pid}\n`);
  assert.equal(await readFile(reusedFile, 'utf8'), `${live.pid}\n`);
  assert.ok(running(unrelatedPid), 'an orphan with mismatched execution identity was terminated');
  await assert.rejects(readFile(mismatchedFile), { code: 'ENOENT' });
});

test('native child signals retain their loaded POSIX owner after source removal and escape inherited execution ids', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-native-signals-' });
  const source = join(root, 'native_execution_signals.sh');
  await copyFile(new URL('./native_execution_signals.sh', import.meta.url), source);
  const executionId = 'native-signal-"\\\n\t';
  const child = spawn('/bin/bash', [custody, 'run', join(root, 'native-signals.pid'), executionId, '/bin/sh', '-c', `
    . ${quote(source)}
    sleep 300 &
    target=$!
    printf 'READY %s\\n' "$target"
    read -r command || exit 97
    native_execution_signal "$HAPPIER_REMOTE_EXECUTION_ID" "$HAPPIER_REMOTE_EXECUTION_ID" native_cleanup TERM pid "$target" ''
    wait "$target"
    exit 0
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = once(child, 'close');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await completion; });
  let error = '', output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  await waitFor(() => /^READY \d+\n$/u.test(output), 'POSIX signal owner did not load');
  const target = Number(output.split(' ')[1]);
  await unlink(source);
  child.stdin.end('signal\n');
  assert.deepEqual(await completion, [0, null], error);
  const events = signalEvents(error).filter(event => event.reason === 'native_cleanup');
  assert.equal(events.length, 1, error);
  assert.deepEqual({ ...events[0], at: undefined }, { at: undefined,
    execution_id: executionId, initiating_execution_id: executionId, reason: 'native_cleanup',
    signal: 'TERM', target_kind: 'pid', target_id: target, members: [], syscall_result: 0 });
  assert.equal(running(target), false, 'unlinked source prevented owned child teardown');
});

test('remote custody preserves payload input when no lifetime pipe is requested', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-input-' });
  const child = spawnObservedCustody(['run', join(root, 'remote-exec/input-custody.pid'), 'input-custody', '/bin/cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const closed = once(child, 'close');
  child.stdin.end('input survives custody\n');
  assert.deepEqual(await closed, [0, null]);
  assert.equal(output, 'input survives custody\n');
  assert.deepEqual(assertSignalEvents(error, 'input-custody', child.custodySignalTrace()), [], 'completion without live members must not send or log a signal');
  await assert.rejects(readFile(join(root, 'remote-exec/input-custody.pid')), { code: 'ENOENT' });
});

test('remote lifetime custody does not leak its private pipe descriptor to the payload', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-lifeline-fds-' });
  const child = spawn('/bin/bash', [custody, 'run', join(root, 'remote-exec/fds.pid'), 'fds', '/bin/bash', '-c', `
    if [ -e /proc/$$/fd/3 ]; then
      printf 'inherited-lifeline='; readlink /proc/$$/fd/3
    fi
    printf 'payload-complete\\n'
  `], { env: { ...process.env, HAPPIER_REMOTE_EXEC_LIFELINE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  assert.deepEqual(await once(child, 'close'), [0, null], error);
  assert.equal(output, 'payload-complete\n', error);
});

test('a remote script cut short on stdin never runs, and a complete one leaves the following input unread', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-script-frame-' });
  const marker = join(root, 'partial-script-ran');
  const script = `printf 'script-ran\\n'; read -r control; printf 'control=%s\\n' "$control"; : > ${quote(marker)}`;
  // Without a lifetime pipe the payload reads custody's stdin directly, so it
  // observes exactly the bytes that follow the declared script length.
  const env = { ...process.env, HAPPIER_REMOTE_EXEC_SCRIPT_STDIN: '1' };
  const run = (id, input) => spawnSync('/bin/bash', [custody, 'run', join(root, `remote-exec/${id}.pid`), id, '/bin/bash', '-c'],
    { env, input, encoding: 'utf8' });

  const truncated = run('truncated', `${Buffer.byteLength(script) + 1}\n${script}`);
  assert.equal(truncated.status, 255, truncated.stderr);
  assert.equal(truncated.stdout, '');
  await assert.rejects(access(marker), { code: 'ENOENT' });

  const complete = run('complete', `${Buffer.byteLength(script)}\n${script}following-input\n`);
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(complete.stdout, 'script-ran\ncontrol=following-input\n');
  await access(marker);
});

test('control input reaches the admitted payload and EOF cancels its process tree', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-control-' });
  const pidFile = join(root, 'remote-exec/control-custody.pid');
  const child = spawnObservedCustody(['run', pidFile, 'control-custody', process.execPath, '-e', `
    console.log('READY');
    process.stdin.once('data', chunk => console.log('BODY:' + chunk.toString().trim()));
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, HAPPIER_REMOTE_EXEC_LIFELINE: '1', HAPPIER_REMOTE_EXEC_CONTROL_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const closed = once(child, 'close');
  await waitFor(() => output.includes('READY\n'), 'controller did not become ready');
  assert.doesNotMatch(output, /BODY:/);
  child.stdin.write('{"requestPath":"/tmp/request"}\n');
  await waitFor(() => output.includes('BODY:{"requestPath":"/tmp/request"}'), 'control ACK never reached payload');
  child.stdin.end();
  assert.deepEqual(await closed, [130, null]);
  const events = assertSignalEvents(error, 'control-custody', child.custodySignalTrace());
  assert.ok(events.some(event => event.reason === 'lifeline_eof' && event.signal === 'TERM'), error);
  await assert.rejects(readFile(pidFile), { code: 'ENOENT' });
});

test('dispatcher death ends a TERM-ignoring payload even though its output readers are gone', { skip: process.platform === 'win32' }, async t => {
  // sshd exits with the dispatcher: lifeline EOF arrives with stdout/stderr
  // readers already closed, so custody's teardown diagnostics hit a dead pipe.
  const { root } = await createTempFixture(t, { prefix: 'hstack-dispatcher-death-' });
  const marker = join(root, 'payload.pid');
  let payloadPid;
  t.after(() => { if (payloadPid) { try { process.kill(payloadPid, 'SIGKILL'); } catch {} } });
  const child = spawn('/bin/bash', [custody, 'run', join(root, 'remote-exec/dispatcher-death.pid'), 'dispatcher-death', '/bin/bash', '-c',
    `trap '' TERM; printf '%s\\n' "$$" > ${quote(marker)}; while :; do sleep 1; done`],
  { env: { ...process.env, HAPPIER_REMOTE_EXEC_LIFELINE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  await waitFor(async () => {
    payloadPid = Number(await readFile(marker, 'utf8').catch(() => '0'));
    return payloadPid > 0;
  }, 'payload did not start');
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.end();
  await closed;
  await waitFor(() => !running(payloadPid), 'payload survived its dispatcher');
});

test('control input survives the native admitted process tree', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-admitted-control-' });
  const native = await installNativeAdmissionFixture({ root, prepareDependencies: true });
  writeFakeBin({ root, name: 'awk', content: '#!/bin/sh\ncase "$*" in */proc/meminfo*) printf "28000000 30000000\\n" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n' });
  writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  const child = spawn('/bin/bash', [custody, 'run', join(root, 'remote-exec/native-input.pid'), 'native-input', '/bin/sh', native.launcher, '--heavyweight-admission', '--class=runtime-build', '--machine=worker', '--', process.execPath, '-e', `
    console.log('READY');
    process.stdin.once('data', chunk => { console.log('BODY:' + chunk.toString().trim()); process.exit(0); });
    process.stdin.once('end', () => process.exit(91));
  `], { env: { ...buildNativeAdmissionFixtureEnv(), PATH: join(root,'bin') + ':' + process.env.PATH, HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_REMOTE_EXEC_LIFELINE: '1', HAPPIER_REMOTE_EXEC_CONTROL_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let output = '', error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  const closed = once(child, 'close');
  await waitFor(() => output.includes('READY\n') || child.exitCode !== null || child.signalCode !== null,
    () => `native controller did not become ready (exit=${child.exitCode}, signal=${child.signalCode}): ${error}`);
  assert.match(output, /READY\n/u, `native controller exited before readiness (exit=${child.exitCode}, signal=${child.signalCode}): ${error}`);
  child.stdin.write('{"requestPath":"/tmp/request"}\n');
  assert.deepEqual(await closed, [0, null], error);
  assert.match(output, /BODY:/);
});

test('remote custody cleans up stubborn descendants after the command leader exits and preserves its result', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-leader-exit-' });
  const marker = join(root, 'child.pid');
  const body = `bash -c ${quote(`trap '' TERM; printf '%s\\n' "$$" > ${quote(marker)}; while :; do sleep 1; done`)} & while [ ! -f ${quote(marker)} ]; do sleep 0.01; done; exit 7`;
  let childPid;
  t.after(() => { if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} } });
  const child = spawnObservedCustody(['run', join(root, 'remote-exec/leader-exit.pid'), 'leader-exit', '/bin/bash', '-c', body], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  child.stderr.on('data', chunk => { error += chunk; });
  const closed = once(child, 'close');
  await waitFor(async () => {
    childPid = Number(await readFile(marker, 'utf8').catch(() => '0'));
    return childPid > 0;
  }, 'descendant did not start');
  const identity = new URL('../proc/native_process_identity.sh', import.meta.url).pathname;
  const token = spawnSync('/bin/bash', ['-c', '. "$1"; heavyweight_process_token "$2"', 'identity', identity, String(childPid)], { encoding: 'utf8' }).stdout.trim();
  assert.deepEqual(await closed, [7, null]);
  await waitFor(() => !running(childPid), 'descendant survived normal command leader exit');
  const events = assertSignalEvents(error, 'leader-exit', child.custodySignalTrace());
  assert.deepEqual(events.map(event => event.signal), ['TERM', 'KILL']);
  for (const event of events) {
    assert.equal(event.reason, 'completed');
    assert.equal(event.target_kind, 'pgid');
    assert.equal(event.syscall_result, 0);
    if (process.platform === 'linux') assert.ok(event.members.includes(`${childPid}:${token}`), error);
  }
});

test('TTY custody cancellation terminates a foreground job that defers wrapper traps', { skip: process.platform !== 'linux' }, async t => {
  for (const [reason, initiatingExecutionId, cancelArgs] of [
    ['custody_cancel', 'tty-custody', []],
    ['controller_orphan_cleanup', 'native-cleanup-dispatch', ['controller_orphan_cleanup', 'native-cleanup-dispatch']],
  ]) await t.test(reason, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-tty-' });
  const marker = join(root, 'foreground.pid');
  const pidFile = join(root, 'remote-exec/tty-custody.pid');
  const body = `trap '' TERM; printf '%s\\n' "$$" > ${quote(marker)}; while :; do sleep 1; done`;
  const command = ['/bin/bash', custody, 'run', pidFile, 'tty-custody', '/bin/bash', '-c', body].map(quote).join(' ');
  const terminal = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let childPid;
  t.after(() => {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    if (terminal.exitCode == null && terminal.signalCode == null) terminal.kill('SIGKILL');
  });
  await waitFor(async () => {
    childPid = Number(await readFile(marker, 'utf8').catch(() => '0'));
    return childPid > 0;
  }, 'foreground TTY job did not start');
  const cancel = spawnObservedCustody(['cancel', pidFile, 'tty-custody', ...cancelArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '';
  cancel.stderr.on('data', chunk => { error += chunk; });
  const closed = once(cancel, 'close');
  assert.deepEqual(await closed, [0, null]);
  const events = assertSignalEvents(error, 'tty-custody', cancel.custodySignalTrace(), initiatingExecutionId);
  assert.ok(events.some(event => event.target_kind === 'pgid' && event.target_id === childPid && event.signal === 'KILL'), error);
  for (const event of events) assert.equal(event.reason, reason);
  await waitFor(() => !running(childPid), 'foreground TTY job survived cancellation');
  await waitFor(async () => !(await readFile(pidFile, 'utf8').catch(() => '')), 'TTY execution identity survived cancellation');
  });
});

test('delayed group cancellation reports unavailable identity without signaling an unverified group', { skip: process.platform !== 'linux' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-remote-group-identity-' });
  const leader = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
  t.after(() => leader.kill('SIGTERM'));
  const pidFile = join(root, 'identity.pid');
  const signals = join(root, 'signals');
  const tokenReads = join(root, 'token-reads');
  await writeFile(pidFile, `${process.pid}\n${leader.pid}\n`);
    // ps, kernel-token reads and signals are the OS boundary. Simulate reuse
  // during TERM grace without creating or signaling any unrelated real group.
  for (const identityState of ['reused', 'unavailable']) {
    const bootstrap = `
    ps() {
      case "$*" in
        '-p ${process.pid} -o command=') printf '%s\\n' identity-execution ;;
        '-p ${leader.pid} -o ppid=') printf '%s\\n' ${process.pid} ;;
        '-p ${leader.pid} -o pgid=') printf '%s\\n' ${leader.pid} ;;
        '-eo pid=,pgid=') printf '%s %s\\n' ${leader.pid} ${leader.pid} ;;
      esac
    }
    read() {
      builtin read "$@" || return
      [ "$#" = 2 ] && [ "$1" = -r ] && [ "$2" = heavyweight_stat_line ] || return 0
      # Native identity now reads procfs with Bash rather than awk. Substitute
      # only this OS stat record, keeping its real parser and guards active.
      case "\${heavyweight_stat_line-}" in
        '${leader.pid} ('*)
          ${identityState === 'unavailable' ? 'heavyweight_stat_line=unavailable' : `if [ -f ${quote(tokenReads)} ]; then fixture_token=202; else : > ${quote(tokenReads)}; fixture_token=101; fi
          heavyweight_stat_line="${leader.pid} (fixture) S ${Array(18).fill('0').join(' ')} $fixture_token"`} ;;
      esac
    }
    kill() {
      local observed_signal=$1
      [ "$observed_signal" != -s ] || observed_signal="-$2"
      printf '%s %s\\n' "$observed_signal" "\${!#}" >> ${quote(signals)}
      [ "$observed_signal" != -TERM ]
    }
    export -f ps read kill
    exec /bin/bash ${quote(custody)} cancel ${quote(pidFile)} identity-execution
    `;
    const result = spawnSync('/bin/bash', ['-c', bootstrap], { encoding: 'utf8' });
    // A diagnostic is not successful cancellation: the user's custody
    // contract requires a nonzero result while the original group is unknown.
    assert.equal(result.status, 1, result.stderr);
    await access(pidFile);
    const recorded = await readFile(signals, 'utf8');
    assert.ok(recorded.includes(`-TERM -${leader.pid}`), recorded);
    assert.ok(!recorded.includes(`-KILL -${leader.pid}`), 'an unverified group was signaled after the grace period');
    assert.ok(result.stderr.trim().length > 0, `${identityState} identity left incomplete cancellation silent`);
    assert.ok(result.stderr.includes(String(leader.pid)), 'diagnostic did not identify the unverified group');
    const event = signalEvents(result.stderr).find(event => event.target_kind === 'pgid' && event.target_id === leader.pid && event.signal === 'TERM');
    assert.equal(event?.syscall_result, 1, 'failed signal syscalls must retain their actual result');
  }
});
