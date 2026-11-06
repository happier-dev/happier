import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../../testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { brokerAddress } from './admission_socket.mjs';
import { createAdmissionBroker, readAdmissionMemorySample } from './admission_broker.mjs';
import { DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';
import { requestAdmissionSample } from './admission_client.mjs';

// Finite cutover coverage consumes an explicitly selected pre-broker producer.
// Remove with the old admitted cohort; never reinterpret the current checkout
// as historical input after the canonical producer has changed.
const oldSourceRoot = process.env.HAPPIER_TEST_PRE_BROKER_REPO;
const legacy = { skip: process.platform !== 'linux' || !oldSourceRoot };
const clientPath = fileURLToPath(new URL('./admission_client.mjs', import.meta.url));

async function restartFixture(t) {
  const children = new Map();
  const fixture = await createTempFixture(t, { prefix: 'hstack-client-restart-', beforeCleanup: async () => {
    for (const [child, closed] of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
  } });
  const native = await installNativeAdmissionFixture({ root: fixture.root });
  await native.setMemoryObservation({ availableMemoryKiB: 100, totalMemoryKiB: 100 });
  const own = child => {
    const closed = once(child, 'close');
    children.set(child, closed);
    return { child, closed };
  };
  const start = (payload, options = []) => {
    const client = own(spawn(process.execPath, [native.admissionClientPath, '--run',
      `--root=${native.admissionRoot}`, '--class=validation', '--floor-kib=1', '--machine=fixture',
      `--repo=${fixture.root}`, '--failure-id=restart-client', ...options, '--', process.execPath, '-e', payload],
    { env: { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_PM_CACHE_BASE_DIR: '' }, stdio: ['pipe', 'pipe', 'pipe'] }));
    let stdout = '', stderr = '';
    client.child.stdout.on('data', value => { stdout += value; });
    client.child.stderr.on('data', value => { stderr += value; });
    return { ...client, stdout: () => stdout, stderr: () => stderr };
  };
  return { ...fixture, native, own, start };
}

async function resetFirstBrokerRequest(fixture) {
  // Closing a real Unix socket with an unread request produces a kernel
  // reset, unlike clean EOF (which command admission already reconnects).
  const resetting = fixture.own(spawn('/usr/bin/python3', ['-c', `
import os, socket, sys
address = sys.argv[1]
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(address)
listener.listen()
print('ready', flush=True)
peer, _ = listener.accept()
peer.recv(1, socket.MSG_PEEK)
listener.close()
os.unlink(address)
peer.close()
`, brokerAddress(fixture.native.admissionRoot)], { stdio: ['ignore', 'pipe', 'ignore'] }));
  const ready = createInterface({ input: resetting.child.stdout });
  assert.equal((await once(ready, 'line'))[0], 'ready');
  ready.close();
  return resetting;
}

test('a waiting client carries its original arrival through a broker reconnect',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await restartFixture(t);
    const requests = [];
    let firstSocket;
    let firstArrival;
    const arrived = new Promise(resolve => { firstArrival = resolve; });
    const server = createServer(socket => {
      const lines = createInterface({ input: socket });
      lines.once('line', line => {
        requests.push(JSON.parse(line));
        if (requests.length === 1) { firstSocket = socket; firstArrival(); }
        else socket.end(JSON.stringify({ kind: 'refused', reason: 'HSTACK_MEMORY_BUSY' }) + '\n');
      });
    });
    server.listen(brokerAddress(fixture.native.admissionRoot));
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const client = fixture.start('process.stdout.write("unexpected");');
    await arrived;
    assert.ok(Number.isSafeInteger(requests[0].arrivedAt), 'the admission request carries its original arrival time');
    // Cross the real clock boundary so recomputing the timestamp on reconnect
    // cannot accidentally pass when both requests fall in one millisecond.
    while (Date.now() === requests[0].arrivedAt) await new Promise(setImmediate);
    firstSocket.destroy();
    assert.deepEqual(await client.closed, [75, null]);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].arrivedAt, requests[0].arrivedAt);
    assert.equal(client.stdout(), '');
  });

test('admission reports one waiting line with enqueue facts only when capacity queues the command',
  { skip: process.platform !== 'linux' }, async t => {
    for (const mode of ['queued', 'immediate', 'older-broker']) await t.test(mode, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const queued = mode !== 'immediate';
      const fixture = await restartFixture(t);
      if (mode === 'older-broker') {
        // The pre-position producer at 6ef4c629e8 has no per-request queue fields.
        // Adapt only the network boundary; admission and payload remain real.
        const nativeWrite = Socket.prototype.write;
        t.mock.method(Socket.prototype, 'write', function (chunk, ...args) {
          if (typeof chunk === 'string' && chunk.startsWith('{')) {
            const response = JSON.parse(chunk);
            if (response.kind === 'queued') {
              delete response.queuePosition;
              delete response.countAhead;
              chunk = JSON.stringify(response) + '\n';
            }
          }
          return nativeWrite.call(this, chunk, ...args);
        });
      }
      let availableMemoryKiB = queued ? 0 : 100;
      let observed;
      const broker = createAdmissionBroker({ root: fixture.native.admissionRoot,
        oldLockPath: join(fixture.root, 'old-admission.lock'),
        sampleResources: async () => {
          observed?.();
          return { availableMemoryKiB, totalMemoryKiB: 100 };
        } });
      await broker.start();
      t.after(() => broker.close());
      const arrival = new Promise(resolve => { observed = resolve; });
      const client = fixture.start('process.stdout.write("entered");');
      await arrival;
      // A status request on the real broker serializes after the arrival's
      // first admission attempt; no polling or diagnostic timer is needed.
      const sample = await requestAdmissionSample(fixture.native.admissionRoot);
      if (queued) {
        assert.equal(sample.waitingCount, 1);
        const busy = fixture.start('process.stdout.write("unexpected");', ['--no-wait']);
        assert.deepEqual(await busy.closed, [75, null]);
        assert.equal(busy.stdout(), '');
        assert.equal(busy.stderr().split('\n').filter(line => line.includes('waiting for admission')).length, 0);
        availableMemoryKiB = 100;
        // Reconnecting demand shares the sample; external memory recovery is
        // observed by the broker's existing shared catch-up, not a new arrival.
        t.mock.timers.tick(DEFAULT_FILE_CHANGE_CATCH_UP_MS);
        await requestAdmissionSample(fixture.native.admissionRoot);
        const next = fixture.start('process.stdout.write("next");', ['--no-wait']);
        assert.deepEqual(await next.closed, [0, null], next.stderr());
        assert.equal(next.stderr().split('\n').filter(line => line.includes('waiting for admission')).length, 0);
      }
      assert.deepEqual(await client.closed, [0, null], client.stderr());
      assert.equal(client.stdout(), 'entered');
      const waiting = client.stderr().split('\n').filter(line => line.includes('waiting for admission'));
      assert.equal(waiting.length, queued ? 1 : 0);
      if (mode === 'older-broker') assert.match(waiting[0], /^\[preferred-execution\] waiting for admission \(class=validation, waiting=1\)$/);
      else if (queued) assert.match(waiting[0], /^\[preferred-execution\] waiting for admission \(class=validation, position=1, ahead=0, waiting=1\)$/);
    });
  });

test('a transient admission observation failure retains the client until the next successful pass',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await restartFixture(t);
    let failObservation = false;
    let observed;
    const broker = createAdmissionBroker({ root: fixture.native.admissionRoot,
      oldLockPath: join(fixture.root, 'old-admission.lock'),
      sampleResources: ({ slots }) => readAdmissionMemorySample({ slots, readProcesses: () => new Map(), readMemory: async () => {
        if (failObservation) {
          observed?.();
          throw Object.assign(new Error('OS memory observation failed'), { code: 'EIO' });
        }
        return { availableMemoryKiB: 100, totalMemoryKiB: 100 };
      } }) });
    await broker.start();
    t.after(() => broker.close());
    failObservation = true;
    const failed = new Promise(resolve => { observed = resolve; });
    const client = fixture.start('process.stdout.write("entered");');
    await failed;
    const sample = await requestAdmissionSample(fixture.native.admissionRoot);
    assert.equal(sample.waitingCount, 1);
    assert.equal(client.stdout(), '');
    // The brief replaces the old terminal-refusal contract: a fresh arrival
    // is another natural pass, and must recover the original client once.
    failObservation = false;
    const next = fixture.start('process.stdout.write("next");');
    assert.deepEqual(await client.closed, [0, null], client.stderr());
    assert.deepEqual(await next.closed, [0, null], next.stderr());
    assert.equal(client.stdout(), 'entered');
    assert.doesNotMatch(client.stderr(), /admission refused/);
  });

test('a pre-admission real socket reset reconnects through broker startup and launches the payload once',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await restartFixture(t);
    const resetting = await resetFirstBrokerRequest(fixture);
    const client = fixture.start('process.stdout.write("entered");');
    const [status, signal] = await client.closed;
    assert.equal((await resetting.closed)[0], 0);
    assert.equal(status, 0, client.stderr());
    assert.equal(signal, null);
    assert.equal(client.stdout(), 'entered', 'reconnecting admission must launch the payload exactly once');
    assert.equal((await fixture.native.brokerStatus()).activeCount, 0);
  });

test('a real socket reset retries a finite broker sample while a typed check refusal stays terminal',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await restartFixture(t);
    const resetting = await resetFirstBrokerRequest(fixture);
    const { requestAdmissionSample } = await import(pathToFileURL(fixture.native.admissionClientPath));
    const sample = await requestAdmissionSample(fixture.native.admissionRoot);
    assert.equal((await resetting.closed)[0], 0);
    assert.equal(sample.kind, 'sample');
    assert.equal(sample.activeCount, 0);
    const refused = await requestAdmissionSample(fixture.native.admissionRoot, { kind: 'check', floorKiB: 101 });
    assert.equal(refused.kind, 'refused');
    assert.equal(refused.reason, 'HSTACK_MEMORY_CAPACITY');
  });

test('an admitted payload survives a real broker replacement without another payload or slot',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await restartFixture(t);
    const startBroker = async () => {
      const broker = fixture.own(spawn(process.execPath,
        [join(dirname(fixture.native.admissionClientPath), 'admission_broker.mjs'), '--serve', fixture.native.admissionRoot],
        { env: buildNativeAdmissionFixtureEnv(), stdio: ['ignore', 'pipe', 'ignore'] }));
      const lines = createInterface({ input: broker.child.stdout });
      assert.equal((await once(lines, 'line'))[0], 'ready');
      lines.close();
      return broker;
    };
    const original = await startBroker();
    const client = fixture.start('process.stdout.write("entered"); process.stdin.once("data", () => process.exit(0));');
    await once(client.child.stdout, 'data');
    assert.equal((await fixture.native.brokerStatus()).activeCount, 1);
    original.child.kill('SIGKILL');
    await original.closed;
    await startBroker();
    assert.equal((await fixture.native.brokerStatus()).activeCount, 1, 'replacement must recover the same client listener');
    client.child.stdin.end('finish\n');
    assert.deepEqual(await client.closed, [0, null], client.stderr());
    assert.equal(client.stdout(), 'entered', 'broker replacement must not replay admitted work');
    assert.equal((await fixture.native.brokerStatus()).activeCount, 0);
  });

test('intentional cancellation of a queued admission settles instead of reconnecting',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await restartFixture(t);
    const server = createServer();
    server.listen(brokerAddress(fixture.native.admissionRoot));
    await once(server, 'listening');
    const connected = once(server, 'connection');
    const client = fixture.start('process.stdout.write("unexpected");');
    const [peer] = await connected;
    peer.on('error', () => {});
    t.after(async () => { peer.destroy(); await new Promise(done => server.close(done)); });
    const lines = createInterface({ input: peer });
    assert.equal(JSON.parse((await once(lines, 'line'))[0]).kind, 'acquire');
    lines.close();
    client.child.kill('SIGTERM');
    assert.deepEqual(await client.closed, [130, null], client.stderr());
    assert.equal(client.stdout(), '');
  });

test('a genuine broker startup failure remains a typed terminal refusal',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await restartFixture(t);
    // Child-process startup is the external boundary. The client must retain
    // this failed producer result instead of treating every failure as restart.
    await writeFile(join(dirname(fixture.native.admissionClientPath), 'admission_broker.mjs'), 'process.exitCode = 76;\n');
    const client = fixture.start('process.stdout.write("unexpected");');
    assert.deepEqual(await client.closed, [75, null]);
    assert.match(client.stderr(), /HSTACK_ADMISSION_UNAVAILABLE:restart-client/);
    assert.equal(client.stdout(), '');
  });

test('a live broker refusal stays terminal instead of requeueing the command',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await restartFixture(t);
    await fixture.native.setMemoryObservation({ availableMemoryKiB: 0, totalMemoryKiB: 100 });
    const client = fixture.start('process.stdout.write("unexpected");', ['--no-wait']);
    assert.deepEqual(await client.closed, [75, null]);
    assert.match(client.stderr(), /HSTACK_ADMISSION_BUSY:restart-client/);
    assert.equal(client.stdout(), '');
    const status = await fixture.native.brokerStatus();
    assert.equal(status.activeCount, 0);
    assert.equal(status.waitingCount, 0);
  });

test('an admitted parent reuses its reservation for its own nested compiler despite a larger leaf class',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await restartFixture(t);
    await fixture.native.setMemoryObservation({ availableMemoryKiB: 1, totalMemoryKiB: 1 });
    const parent = fixture.start(`(async () => {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(process.execPath, [${JSON.stringify(fixture.native.admissionClientPath)}, '--run',
        '--root=' + process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT,
        '--class=compilation', '--floor-kib=2', '--machine=fixture', '--', process.execPath,
        '--input-type=module', '-e', ${JSON.stringify(`
          const { requestAdmissionSample } = await import(${JSON.stringify(pathToFileURL(fixture.native.admissionClientPath).href)});
          const sample = await requestAdmissionSample(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT);
          process.stdout.write(JSON.stringify({ active: sample.activeCount, waiting: sample.waitingCount,
            floor: process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_FLOOR_KIB }));
        `)}], { env: process.env, encoding: 'utf8' });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.status;
    })().catch(error => { console.error(error); process.exitCode = 1; });`);
    assert.deepEqual(await parent.closed, [0, null], parent.stderr());
    assert.deepEqual(JSON.parse(parent.stdout()), { active: 1, waiting: 0, floor: '1' });
    assert.equal((await fixture.native.brokerStatus()).activeCount, 0);
  });

test('a malformed broker response fails instead of reconnecting a finite read',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await restartFixture(t);
    const server = createServer(peer => {
      peer.on('error', () => {});
      peer.once('data', () => peer.end('{malformed\n'));
    });
    server.listen(brokerAddress(fixture.native.admissionRoot));
    await once(server, 'listening');
    t.after(() => new Promise(done => server.close(done)));
    const { requestAdmissionSample } = await import(pathToFileURL(fixture.native.admissionClientPath));
    await assert.rejects(requestAdmissionSample(fixture.native.admissionRoot), SyntaxError);
  });

async function oldParent(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-old-parent-', registerCleanup: false });
  let newAdmission, trap, parent, exited;
  const peers = new Set();
  t.after(async () => {
    try {
      if (parent) {
        parent.stdin.end();
        if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM');
        await exited;
      }
    } finally {
      for (const peer of peers) peer.destroy();
      if (trap?.listening) await new Promise(resolveClosed => trap.close(resolveClosed));
      await newAdmission?.cleanup();
      await fixture.cleanup();
    }
  });
  const { installNativeAdmissionFixture: installOldFixture } = await import(pathToFileURL(
    join(oldSourceRoot, 'apps/stack/scripts/testkit/core/native_admission_fixture.mjs')));
  // The canonical old fixture preserves its producer/helper closure and real
  // observer arithmetic. Null selects an empty OS snapshot, never host owners.
  const { launcher, admissionRoot } = await installOldFixture({ root: fixture.root, observedPidsPath: null });
  assert.ok(admissionRoot.startsWith(fixture.root + '/'), 'old records must remain in the private fixture');
  const { binDir } = writeFakeBin({ root: fixture.root, name: 'awk', content: `#!/bin/sh
case "$*" in */proc/meminfo*) printf '134217728 134217728\\n' ;; *) exec /usr/bin/awk "$@" ;; esac
` });
  await mkdir(admissionRoot, { recursive: true, mode: 0o700 });
  // Numeric-UID root activation renames the new authority. The old admitted
  // parent keeps its original root and identity; the new client requests the
  // different canonical root and must authenticate inheritance read-only.
  newAdmission = await createTempFixture(t, { parentDir: '/tmp', prefix: 'ha-client-', registerCleanup: false });
  const clientAdmissionRoot = newAdmission.root;
  let brokerConnections = 0;
  trap = createServer(socket => {
    brokerConnections++;
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.resume();
    socket.end(JSON.stringify({ kind: 'refused', reason: 'HSTACK_MEMORY_BUSY' }) + '\n');
  });
  trap.listen(brokerAddress(clientAdmissionRoot));
  await once(trap, 'listening');
  const driver = fixture.path('old-parent.mjs');
  await writeFile(driver, `
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const identityKey = 'HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN';
const root = process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT;
const [pid, birth] = process.env[identityKey].split(':');
const original = join(root, 'owners', pid + '-' + birth);
process.stdout.write('ready\\n');
for await (const mode of createInterface({ input: process.stdin })) {
  const env = { ...process.env };
  let forged;
  if (mode === 'stale') {
    env[identityKey] = pid + ':0';
    forged = join(root, 'owners', pid + '-0');
    mkdirSync(forged);
    writeFileSync(join(forged, 'process'), pid + ' 0\\n');
    for (const field of ['machine', 'class']) copyFileSync(join(original, field), join(forged, field));
  }
  if (mode === 'machine') env.HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE = 'wrong-machine';
  if (mode === 'mixed') env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT = pid;
  const result = spawnSync(process.execPath, [${JSON.stringify(clientPath)}, '--run',
    '--root=' + ${JSON.stringify(clientAdmissionRoot)}, '--class=native-source-test', '--floor-kib=1048576',
    '--machine=' + env.HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE,
    ...(mode === 'ordinary' ? [] : ['--require-inherited']), '--', process.execPath,
    '-e', 'process.stdout.write("nested");'], { env, encoding: 'utf8' });
  if (forged) rmSync(forged, { recursive: true });
  process.stdout.write(JSON.stringify({ status: result.status, stdout: result.stdout }) + '\\n');
}
`);
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${binDir}:${process.env.PATH}`,
    HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_STACK_PM_CACHE_BASE_DIR: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '1' };
  parent = spawn('/bin/sh', [launcher, '--heavyweight-admission', '--class=native-source-test',
    '--machine=worker', '--', process.execPath, driver], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  exited = once(parent, 'close');
  const exitFailure = ([code, signal]) => new Error('private old parent closed before response: '
    + JSON.stringify({ code, signal }));
  const lines = createInterface({ input: parent.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const result = await Promise.race([lines.next(), exited.then(status => {
      throw exitFailure(status);
    })]);
    if (result.done) throw exitFailure(await exited);
    return result.value;
  };
  assert.equal(await next(), 'ready', 'the original launcher must admit the private old parent');
  const ownerNames = await readdir(join(admissionRoot, 'owners'));
  assert.equal(ownerNames.length, 1);
  const owner = join(admissionRoot, 'owners', ownerNames[0]);
  const fields = ['process', 'class', 'machine'];
  const before = await Promise.all(fields.map(field => readFile(join(owner, field))));
  return { fixture, parent, run: async mode => {
    parent.stdin.write(mode + '\n');
    return JSON.parse(await next());
  }, connections: () => brokerConnections,
  unchanged: async () => (await Promise.all(fields.map(field => readFile(join(owner, field)))))
    .every((value, index) => value.equals(before[index])) };
}

test('a live old-format admitted parent passes required and ordinary nested children without another admission',
  legacy, async t => {
    const owner = await oldParent(t);
    const required = await owner.run('required');
    const ordinary = await owner.run('ordinary');
    assert.equal(required.status, 0, 'the admitted old parent must satisfy inherited admission');
    assert.equal(ordinary.status, 0, 'an ordinary nested child must reuse the same admitted parent');
    assert.equal(required.stdout, 'nested');
    assert.equal(ordinary.stdout, 'nested');
    assert.equal(owner.connections(), 0, 'old-parent inheritance must never request a broker slot');
    assert.equal(await owner.unchanged(), true, 'the adapter must preserve the original owner record');
  });

test('old-format inheritance refuses a forged incarnation, mismatched machine and mixed modern slot',
  legacy, async t => {
    const owner = await oldParent(t);
    for (const mode of ['stale', 'machine', 'mixed']) {
      const result = await owner.run(mode);
      assert.equal(result.status, 1, 'unproven old admission must be refused');
      assert.equal(result.stdout, '');
    }
    assert.equal(owner.connections(), 0);
    assert.equal(await owner.unchanged(), true);
  });
