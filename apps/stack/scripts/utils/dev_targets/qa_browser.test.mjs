import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { rootCertificates } from 'node:tls';
import { createServer } from 'node:http';
import { resolveQaBrowserUrl, runQaBrowserSession, runQaBrowserWorker, stopQaBrowsers } from './qa_browser.mjs';
import { resolveRemoteStackStatePaths } from './remote_commands.mjs';
import { runCaptureResult, spawnProc, killProcessTree } from '../proc/proc.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';

// Real CDP transport at the external Chromium boundary; the worker's launch,
// executable adaptation and cleanup remain real.
async function fakeChromeCommandLine(t, executable = process.execPath, onCommand = () => true) {
  const sockets = new Set();
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once('data', bytes => {
      const length = bytes[1] & 127;
      const mask = bytes.subarray(2, 6);
      const payload = Buffer.from(bytes.subarray(6, 6 + length));
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      const command = JSON.parse(payload.toString());
      assert.equal(command.method, 'Browser.getBrowserCommandLine');
      socket.once('data', () => socket.end(Buffer.from([0x88, 0])));
      if (!onCommand()) return;
      const response = Buffer.from(JSON.stringify({ id: command.id, result: { arguments: [executable] } }));
      const header = response.length < 126 ? Buffer.from([0x81, response.length]) : Buffer.from([0x81, 126, response.length >> 8, response.length & 255]);
      socket.write(Buffer.concat([header, response]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

test('canonical browser recovery closes its retained session and removes only its temporary profile', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-qa-browser-recovery-' });
  const profile = await mkdtemp(join(root, 'hstack-qa-browser-'));
  const neighbor = await mkdtemp(join(root, 'hstack-qa-browser-'));
  const session = 'hstack-retained-lane-fixture';
  const { binDir } = writeFakeBin({ root, name: 'agent-browser', content: `#!${process.execPath}
const assert=require('node:assert/strict');
assert.deepEqual(process.argv.slice(2),['--session',${JSON.stringify(session)},'close']);
if(process.env.QA_BROWSER_CLOSE_FAIL)process.exit(1);
` });
  const commandArgs = [fileURLToPath(new URL('./qa_browser.mjs', import.meta.url)), '--cleanup', session, profile];
  const env = { ...process.env, TMPDIR: root, PATH: `${binDir}:${process.env.PATH}` };
  const failed = await runCaptureResult(process.execPath, commandArgs, { env: { ...env, QA_BROWSER_CLOSE_FAIL: '1' } });
  assert.equal(failed.ok, false);
  await access(profile);
  const result = await runCaptureResult(process.execPath, commandArgs, { env });
  assert.equal(result.ok, true, result.err);
  await assert.rejects(access(profile), { code: 'ENOENT' });
  await access(neighbor);
});

for (const ownerSignal of ['SIGINT', 'SIGKILL']) test(`${ownerSignal} owner exit closes detached browser beyond executor cancellation grace`, { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-qa-browser-cancel-', registerCleanup: false });
  const { root } = fixture;
  const chromePort = await fakeChromeCommandLine(t);
  const closeMarker = join(root, 'browser-closed');
  const trustCertPath = join(root, 'leaf.crt');
  await writeFile(trustCertPath, rootCertificates[0]);
  const spkiHash = createHash('sha256').update(new X509Certificate(rootCertificates[0]).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const { binDir } = writeFakeBin({ root, name: 'agent-browser', content: `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);
if(a.includes('open')){
require('node:assert/strict').ok(a[a.indexOf('--args')+1].split(',').includes(${JSON.stringify(`--ignore-certificate-errors-spki-list=${spkiHash}`)}),'controller certificate trust must reach Chromium launch');
fs.writeFileSync(path.join(a[a.indexOf('--profile')+1],'DevToolsActivePort'),${JSON.stringify(`${chromePort}\n/devtools/browser/fixture-browser\n`)});
}
else setTimeout(()=>fs.writeFileSync(${JSON.stringify(closeMarker)},'closed'),2500);
` });
  const script = `
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { runQaBrowserSession } from ${JSON.stringify(new URL('./qa_browser.mjs', import.meta.url).href)};
import { runCaptureResult, spawnProc, killProcessTree } from ${JSON.stringify(new URL('../proc/proc.mjs', import.meta.url).href)};
${captureReadyRemote.toString()}
let ready, resolveTunnel;
const tunnel = { completion: new Promise(resolve => { resolveTunnel = resolve; }) };
await runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'fixture',
      repoDir: ${JSON.stringify(fileURLToPath(new URL('../../../../../', import.meta.url)))}, cliHomeDir: ${JSON.stringify(root)},
      remotePath: ${JSON.stringify([binDir, dirname(process.execPath)])} },
    stackName: 'agent-qa-browser', stackBaseDir: ${JSON.stringify(root)}, sessionName: 'graceful-close', url: 'http://localhost:3025',
    trustCertPath: ${JSON.stringify(trustCertPath)},
    env: { ...process.env, TMPDIR: ${JSON.stringify(root)} },
    onReady: value => { ready = value; console.log('CONTROLLER_READY='+JSON.stringify(value)); },
  }, {
    capture: (command, args, options) => command === 'ssh' && args.at(-1).includes(' cancel ')
      ? runCaptureResult('/bin/bash', ['-c', args.at(-1)], options) : captureReadyRemote(command, args),
    // Replace SSH transport only: remote command/custody, worker and process
    // cleanup remain real, including the executor's group-cancellation grace.
    spawnProcess: (label, _command, args, env, options) => {
      if (label.startsWith('browser-forward:')) return tunnel;
      return spawnProc(label, '/bin/bash', ['-c', args.at(-1)], env, options);
    },
    stopProcess: async child => {
      if (child !== tunnel) return await killProcessTree(child, 'SIGINT');
      await access(${JSON.stringify(closeMarker)});
      await assert.rejects(access(ready.profile), { code: 'ENOENT' });
      resolveTunnel({ code: 0 });
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/fixture-browser' }) }),
  });
`;
  const controller = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = new Promise(resolve => controller.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    try {
      if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGTERM');
      await completion;
      const paths = resolveRemoteStackStatePaths({ platform: 'posix', cliHomeDir: root, repoDir: process.cwd() },
        { stackName: 'agent-qa-browser', runtimeMode: 'controlled' });
      await stopQaBrowsers({ stackName: 'agent-qa-browser', envPath: paths.stackEnvPath });
    } finally { await fixture.cleanup(); }
  });
  let output = '', error = '', ready;
  controller.stderr.on('data', chunk => { error += chunk; });
  await new Promise((resolve, reject) => {
    controller.once('error', reject);
    controller.once('close', () => { if (!ready) reject(new Error(error)); });
    controller.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(value => value.startsWith('CONTROLLER_READY='));
      if (line) { ready = JSON.parse(line.slice('CONTROLLER_READY='.length)); resolve(); }
    });
  });
  controller.kill(ownerSignal);
  assert.deepEqual(await completion, ownerSignal === 'SIGINT' ? { code: 0, signal: null } : { code: null, signal: ownerSignal }, error);
  if (ownerSignal === 'SIGKILL') {
    // A killed controller cannot await cleanup. Observe the remote boundary's
    // completion independently, including its asynchronous close subprocess.
    for (let attempts = 0; attempts < 150; attempts++) {
      if (await access(closeMarker).then(() => true, () => false)
        && await access(ready.profile).then(() => false, () => true)) break;
      await delay(50);
    }
  }
  await access(closeMarker);
  await assert.rejects(access(ready.profile), { code: 'ENOENT' });
});

// The SSH/Mutagen capture boundary uses the real sync wire shape. Browser
// placement, remote custody, forwards and readiness orchestration stay real.
async function captureReadyRemote(_command, args) {
  return { ok: true, exitCode: 0, err: '', out: args.includes('list') ? JSON.stringify([{
    name: 'happier-absent', paused: false, status: 'watching', successfulCycles: 3,
    alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true },
  }]) : '' };
}

test('lane browser forwards are retired only by their owning QA Stack browser inventory', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-qa-browser-ownership-' });
  const producerEnvPath = join(root, 'producer-env');
  const qaEnvPath = join(root, 'agent-qa-browser', 'env');
  const signalSource = new EventEmitter();
  let resolveExited, resolveReady, tunnel;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const worker = { stdin: new PassThrough(), completion: new Promise(resolve => { resolveExited = resolve; }) };
  worker.stdin.on('data', () => resolveExited({ code: 0 }));
  const session = runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: root },
    stackName: 'agent-qa-browser', sessionName: 'ownership', stackBaseDir: root, url: 'http://localhost:3025',
    env: { ...process.env, HAPPIER_STACK_STORAGE_DIR: root,
      HAPPIER_STACK_STACK: 'producer', HAPPIER_STACK_ENV_FILE: producerEnvPath },
    onReady: resolveReady,
  }, {
    signalSource, capture: captureReadyRemote,
    // Replace only SSH's process boundary; the owner supplies the actual
    // environment, and Stack's real OS inventory decides sweep eligibility.
    spawnProcess: (label, _command, _args, env, options) => {
      if (label.startsWith('browser-forward:')) {
        tunnel = spawnProc(label, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], env, options);
        return tunnel;
      }
      setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
      return worker;
    },
    stopProcess: child => killProcessTree(child, 'SIGINT'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/fixture' }) }),
  });
  try {
    await ready;
    const producer = await stopQaBrowsers({ stackName: 'producer', envPath: producerEnvPath });
    assert.ok(!producer.pids.includes(tunnel.pid), 'producer browser retirement must not select the QA forward');
    assert.equal(tunnel.exitCode, null, 'the forward must survive producer browser retirement');
    const owning = await stopQaBrowsers({ stackName: 'agent-qa-browser', envPath: qaEnvPath });
    assert.ok(owning.pids.includes(tunnel.pid), 'owning QA browser retirement must select the actual forward');
  } finally {
    signalSource.emit('SIGINT');
    await session.catch(error => assert.match(error.message, /QA browser SSH forward exited/));
  }
});

test('an unavailable QA browser host fails closed without launching a controller-local worker', async () => {
  let spawned = 0;
  const error = await runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'absent', cliHomeDir: '/fixture' },
    stackName: 'agent-qa-browser', sessionName: 'unavailable', stackBaseDir: '/fixture', url: 'http://localhost:3025',
  }, {
    capture: async () => ({ ok: false, exitCode: 255, err: 'unavailable' }),
    spawnProcess: () => { spawned += 1; return { completion: Promise.resolve({ code: 0 }) }; },
  }).then(() => null, error => error);
  assert.equal(spawned, 0, 'browser host failure must not spawn any controller-local browser');
  assert.match(error?.message ?? '', /QA browser host.*absent.*unavailable/);
});

test('unreadable or malformed explicit trust fails before any remote browser launch', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-qa-browser-trust-' });
  const malformed = join(root, 'malformed.crt');
  await writeFile(malformed, 'not a certificate');
  let remoteCalls = 0;
  for (const trustCertPath of [join(root, 'missing.crt'), malformed]) {
    await assert.rejects(runQaBrowserSession({
      target: { name: 'absent', platform: 'posix', ssh: 'absent', cliHomeDir: '/fixture' },
      stackName: 'agent-qa-browser', sessionName: 'invalid-trust', stackBaseDir: '/fixture',
      url: 'http://localhost:3025', trustCertPath,
    }, { capture: async () => { remoteCalls += 1; return { ok: false, exitCode: 255 }; } }), /requires a readable certificate file/);
  }
  assert.equal(remoteCalls, 0);
});

test('remote QA browser worker stays alive with custody stdin closed until its owner signals cleanup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-qa-browser-worker-'));
  const chromePort = await fakeChromeCommandLine(t);
  let child;
  let completion;
  try {
    // External agent-browser process boundary; worker/profile/custody lifetime is real.
    await writeFile(join(root, 'agent-browser'), `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);if(a.includes('open'))fs.writeFileSync(path.join(a[a.indexOf('--profile')+1],'DevToolsActivePort'),${JSON.stringify(`${chromePort}\n/devtools/browser/fixture-browser\n`)});`, { mode: 0o755 });
    let stdout = '';
    let stderr = '';
    let ready;
    child = spawn(process.execPath, [fileURLToPath(new URL('./qa_browser.mjs', import.meta.url)), '--worker', 'custody-eof'],
      { env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    completion = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const line = stdout.split('\n').find(value => value.startsWith('HSTACK_QA_BROWSER='));
        if (line) { ready = JSON.parse(line.slice('HSTACK_QA_BROWSER='.length)); resolve(); }
      });
      child.once('error', reject);
      child.once('exit', code => { if (!ready) reject(new Error(`worker exited ${code}: ${stderr}`)); });
    });
    await delay(100);
    assert.equal(child.exitCode, null, stderr);
    await access(ready.profile);
    child.kill('SIGTERM');
    assert.deepEqual(await completion, { code: 0, signal: null });
    await assert.rejects(access(ready.profile), { code: 'ENOENT' });
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (completion) await completion;
    await rm(root, { recursive: true, force: true });
  }
});

test('QA browser retains the selected Home and borrowed Expo origins without leaking route credentials', () => {
  const url = 'http://happier-agent-qa-example.localhost:8081/?server=http%3A%2F%2Fhappier-agent-qa-example.localhost%3A3025&happier_hmr=0';
  assert.equal(resolveQaBrowserUrl(url, ['http://127.0.0.1:4050', 'https://external.example.test']), url);
  assert.throws(() => resolveQaBrowserUrl('http://operator:secret@localhost:3025'), /without credentials/);
  assert.throws(() => resolveQaBrowserUrl(url, ['http://operator:secret@localhost:4050']), /without credentials/);
});

test('closing a browser during CDP readiness interrupts the wait and retires its worker', async () => {
  const signalSource = new EventEmitter();
  let resolveExited;
  let resolveWaiting;
  const waiting = new Promise(resolve => { resolveWaiting = resolve; });
  const child = { stdin: new PassThrough(), completion: new Promise(resolve => { resolveExited = resolve; }) };
  child.stdin.on('data', () => resolveExited({ code: 0 }));
  const session = runQaBrowserSession({ target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
    stackName: 'agent-qa-browser', sessionName: 'closing', stackBaseDir: '/fixture', url: 'http://localhost:3025',
  }, { signalSource,
    capture: captureReadyRemote,
    spawnProcess: (label, _command, _args, _env, options) => {
      if (!label.startsWith('browser-forward:')) setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
      return child;
    },
    stopProcess: async () => { resolveExited({ code: 0 }); },
    fetchImpl: async (_url, { signal }) => {
      resolveWaiting();
      return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  await waiting;
  signalSource.emit('SIGINT');
  await session;
});

test('QA browser CDP readiness can complete beyond the former default cutoff', async (t) => {
  const signalSource = new EventEmitter();
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let resolveExited;
  const child = { stdin: new PassThrough(), completion: new Promise(resolve => { resolveExited = resolve; }) };
  child.stdin.on('data', () => resolveExited({ code: 0 }));
  let probes = 0;
  let ready;
  await runQaBrowserSession({ target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
    stackName: 'agent-qa-browser', sessionName: 'slow-ready', stackBaseDir: '/fixture', url: 'http://localhost:3025',
    onReady: value => { ready = value; signalSource.emit('SIGINT'); },
  }, { signalSource,
    capture: captureReadyRemote,
    spawnProcess: (label, _command, _args, _env, options) => {
      if (!label.startsWith('browser-forward:')) setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
      return child;
    },
    stopProcess: async () => { resolveExited({ code: 0 }); },
    fetchImpl: async () => {
      if (probes++ === 0) { clock += 2 * 60 * 60_000; return { ok: false }; }
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/fixture' }) };
    },
  });
  assert.equal(ready.localFallback, false);
  assert.equal(ready.target, 'absent');
  assert.equal(probes, 2);
});

test('each QA browser lifetime preserves canonical Home origins through its own SOCKS route and cleans only its profile', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-qa-browser-pointer-' });
  const { binDir } = writeFakeBin({ root, name: 'chromium', content: `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n` });
  const chromePort = await fakeChromeCommandLine(t, join(binDir, 'chromium'));
  const instances = [];
  const closed = [];
  // agent-browser is an external process boundary; profiles and lifecycle logic
  // remain real. Its DevToolsActivePort is the Chromium-owned wire contract.
  const capture = async (command, args) => {
    assert.equal(command, 'agent-browser');
    const session = args[args.indexOf('--session') + 1];
    if (args.at(-1) === 'about:blank') {
      const launchArgs = args[args.indexOf('--args') + 1].split(',');
      assert.ok(launchArgs.includes('--no-sandbox'),
        'the dedicated QA browser must launch without the Chromium sandbox');
      assert.ok(!launchArgs.some(arg => arg.startsWith('--ignore-certificate-errors')),
        'browser trust must remain unchanged without an explicit certificate');
      const proxy = launchArgs.find(arg => arg.startsWith('--proxy-server=socks5://127.0.0.1:'));
      if (args.includes('--executable-path')) {
        const launched = await runCaptureResult(args[args.indexOf('--executable-path') + 1], launchArgs);
        assert.equal(launched.ok, true, launched.err);
        assert.ok(JSON.parse(launched.out).includes('--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'),
          'the launched Chromium must receive desktop pointer and hover as one intact argument');
        instances.push({ launchArgs, proxyPort: proxy ? Number(proxy.split(':').at(-1)) : null });
      }
      const profile = args[args.indexOf('--profile') + 1];
      await writeFile(join(profile, 'DevToolsActivePort'), `${chromePort}\n/devtools/browser/fixture-browser\n`);
    } else {
      assert.equal(args.at(-1), 'close');
      closed.push(session);
    }
    return { ok: true, exitCode: 0, out: '', err: '' };
  };
  const start = () => {
    const input = new PassThrough();
    const signals = new EventEmitter();
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const completion = runQaBrowserWorker({ sessionName: 'same-lane-name', input, proxy: true,
      writeReady: value => { resolveReady(value); } }, { capture, signalSource: signals });
    completion.catch(rejectReady);
    t.after(async () => { signals.emit('SIGINT'); await completion; });
    return { input, ready, completion, signals };
  };
  const first = start();
  const second = start();
  const [a, b] = await Promise.all([first.ready, second.ready]);
  assert.equal(instances.length, 2, 'both QA browser launches must configure the desktop input environment');
  closed.length = 0; // Executable-discovery browsers have already closed before readiness.
  assert.notEqual(a.profile, b.profile);
  assert.notEqual(a.session, b.session);
  await access(a.profile); await access(b.profile);
  first.input.end();
  // Remote execution custody gives its payload EOF on stdin. Custody signals,
  // not payload stdin, own browser lifetime after readiness.
  await delay(50);
  await access(a.profile);
  first.signals.emit('SIGINT');
  await first.completion;
  await assert.rejects(access(a.profile), { code: 'ENOENT' });
  await access(b.profile);
  assert.deepEqual(closed, [a.session]);
  second.signals.emit('SIGTERM');
  await second.completion;
  await assert.rejects(access(b.profile), { code: 'ENOENT' });
  assert.deepEqual(closed, [a.session, b.session]);
  for (const instance of instances) {
    assert.ok(instance.launchArgs.includes('--proxy-bypass-list=<-loopback>'),
      'canonical localhost Home addresses must not bypass the controller route');
    assert.ok(instance.proxyPort, 'use native origin-preserving transport rather than rewriting the Home URL');
  }
  assert.deepEqual(instances.map(instance => instance.proxyPort).sort(), [a.proxyPort, b.proxyPort].sort());
  assert.notEqual(a.proxyPort, b.proxyPort);
});

for (const failure of ['invalid executable', 'discovery close', 'cancel query']) {
  test(`QA browser ${failure} retires the discovery browser without publishing readiness`, async t => {
    const signals = new EventEmitter();
    const chromePort = await fakeChromeCommandLine(t, failure === 'invalid executable' ? 'relative/chromium' : process.execPath,
      () => {
        if (failure !== 'cancel query') return true;
        signals.emit('SIGINT');
        return false;
      });
    let profile;
    let closes = 0;
    let ready = false;
    const completion = runQaBrowserWorker({ sessionName: 'failed-discovery', input: new PassThrough(),
      writeReady: () => { ready = true; } }, {
      signalSource: signals,
      capture: async (_command, args) => {
        if (args.includes('open')) {
          assert.ok(!args.includes('--executable-path'), 'failed discovery must never launch the final browser');
          profile = args[args.indexOf('--profile') + 1];
          await writeFile(join(profile, 'DevToolsActivePort'), `${chromePort}\n/devtools/browser/fixture-browser\n`);
        } else {
          assert.equal(args.at(-1), 'close');
          closes++;
          if (failure === 'discovery close' && closes === 1) return { ok: false, exitCode: 1, err: 'external close failure' };
        }
        return { ok: true, exitCode: 0, out: '', err: '' };
      },
    });
    if (failure === 'cancel query') await completion;
    else await assert.rejects(completion, failure === 'invalid executable' ? /executable/ : /discovery cleanup failed/);
    assert.equal(ready, false);
    assert.equal(closes, failure === 'discovery close' ? 2 : 1);
    await assert.rejects(access(profile), { code: 'ENOENT' });
    assert.equal(signals.listenerCount('SIGINT'), 0);
  });
}
