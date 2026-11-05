import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { rootCertificates } from 'node:tls';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { resolveQaBrowserUrl, runQaBrowserSignin, runQaBrowserSession as runRealQaBrowserSession, runQaBrowserWorker, stopQaBrowsers, stopStackQaBrowsers } from './qa_browser.mjs';
import { runQaBrowserSigninPage } from './qa_browser_signin_page.mjs';
import { buildRemoteQaBrowserStopCommand, resolveRemoteStackStatePaths } from './remote_commands.mjs';
import { runCaptureResult, spawnProc, killProcessTree } from '../proc/proc.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { withPatchedProcessEnv } from '../../testkit/core/env_scope.mjs';
import { readStackInfoSnapshot } from '../../stack/stack_info_snapshot.mjs';
import { resolveMutagenSessionName } from './mutagen_project.mjs';
import { captureDevTargetSyncFixture } from '../../testkit/core/dev_target_sync.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { parseVoiceWavContainer } from '../../../../../packages/tests/src/testkit/voice/voiceWavParser.mjs';

// CDP WebSocket is an external boundary. Keep the pool, executor and lifetime real.
class AnsweringCdpSocket extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(data) {
    const command = JSON.parse(data);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ id: command.id, result: { product: 'fixture' } }),
    })));
  }
  close() {}
}
function runQaBrowserSession(input, boundaries = {}) {
  return runRealQaBrowserSession(input, { WebSocketImpl: AnsweringCdpSocket, ...boundaries });
}

for (const fault of ['not connected', 'connected but silent', 'HTTP pending', 'CDP refused', 'forward exited']) {
  test(`browser acquisition retires ${fault} before handing out its one replacement`, { timeout: 10_000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const signals = new EventEmitter();
    const events = [];
    let starts = 0;
    let dropForward;
    let firstProbe;
    const probing = new Promise(resolve => { firstProbe = resolve; });
    let ready;
    const completion = runQaBrowserSession({
      target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
      stackName: 'agent-qa-browser', stackBaseDir: '/fixture', sessionName: 'attach-admission',
      url: new URL('fixture', 'http:' + '//localhost').href,
      onReady(value) { events.push(`ready:${starts}`); ready = value; signals.emit('SIGINT'); },
    }, {
      signalSource: signals, capture: captureReadyRemote,
      spawnProcess(label, _command, _args, _env, options) {
        if (label.startsWith('browser-forward:')) return { completion: new Promise(resolve => { dropForward = resolve; }) };
        const attempt = ++starts;
        events.push(`start:${attempt}`);
        let finish;
        const child = { stdin: new PassThrough(), completion: new Promise(resolve => { finish = resolve; }) };
        child.stdin.on('data', () => { events.push(`retired:${attempt}`); finish({ code: 0 }); });
        setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
        return child;
      },
      stopProcess: async () => {},
      fetchImpl: async (_url, { signal }) => {
        if (starts === 1 && (fault === 'HTTP pending' || fault === 'forward exited')) {
          firstProbe();
          if (fault === 'forward exited') queueMicrotask(() => dropForward({ code: 255 }));
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'fixture' }) };
      },
      WebSocketImpl: class extends AnsweringCdpSocket {
        constructor() {
          super();
          this.attempt = starts;
          firstProbe();
        }
        send(data) {
          if (this.attempt !== 1) return super.send(data);
          if (fault === 'CDP refused') queueMicrotask(() => this.dispatchEvent(new Event('error')));
          // Reproduce a connected endpoint whose protocol dispatcher never answers.
        }
        addEventListener(type, listener, options) {
          if (starts === 1 && fault === 'not connected' && type === 'open') return;
          return super.addEventListener(type, listener, options);
        }
      },
    });
    try {
      await Promise.race([probing, completion]);
      await new Promise(setImmediate);
      if (fault !== 'CDP refused' && fault !== 'forward exited') assert.equal(ready, undefined, 'HTTP discovery alone must not admit a browser');
      t.mock.timers.tick(30_000);
      await new Promise(setImmediate);
      await completion;
      assert.equal(starts, 2);
      assert.deepEqual(events, ['start:1', 'retired:1', 'start:2', 'ready:2', 'retired:2']);
      assert.equal(ready.target, 'absent');
    } finally { signals.emit('SIGINT'); await completion; }
  });
}

for (const cleanupCode of [0, 1]) {
  test(`unresponsive acquisition stops after one replacement; retirement exit ${cleanupCode}`, { timeout: 10_000 }, async t => {
    const signals = new EventEmitter();
    let starts = 0;
    let retired = 0;
    let advertised = false;
    const failure = await runQaBrowserSession({
      target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
      stackName: 'agent-qa-browser', stackBaseDir: '/fixture', sessionName: 'failed-attach',
      url: new URL('fixture', 'http:' + '//localhost').href,
      onReady() { advertised = true; },
    }, {
      signalSource: signals, capture: captureReadyRemote,
      spawnProcess(label, _command, _args, _env, options) {
        if (label.startsWith('browser-forward:')) return { completion: new Promise(() => {}) };
        starts++;
        let finish;
        const child = { stdin: new PassThrough(), completion: new Promise(resolve => { finish = resolve; }) };
        child.stdin.on('data', () => { retired++; finish({ code: cleanupCode }); });
        setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
        return child;
      },
      stopProcess: async () => {},
      fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'fixture' }) }),
      WebSocketImpl: class extends AnsweringCdpSocket {
        send() { queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
      },
    }).then(() => null, error => error);
    assert.equal(advertised, false);
    assert.equal(starts, cleanupCode === 0 ? 2 : 1);
    assert.equal(retired, starts);
    if (cleanupCode === 0) assert.equal(failure?.code, 'qa-browser-cdp-unavailable');
    else assert.match(failure?.message ?? '', /retirement.*unconfirmed/);
  });
}

test('cancelling CDP acquisition retires its worker without replacement', { timeout: 10_000 }, async () => {
  const signals = new EventEmitter();
  let starts = 0;
  let retired = false;
  let socketClosed = false;
  await runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
    stackName: 'agent-qa-browser', stackBaseDir: '/fixture', sessionName: 'cancel-attach',
    url: new URL('fixture', 'http:' + '//localhost').href,
    onReady() { assert.fail('cancelled acquisition must not publish readiness'); },
  }, {
    signalSource: signals, capture: captureReadyRemote,
    spawnProcess(label, _command, _args, _env, options) {
      if (label.startsWith('browser-forward:')) return { completion: new Promise(() => {}) };
      starts++;
      let finish;
      const child = { stdin: new PassThrough(), completion: new Promise(resolve => { finish = resolve; }) };
      child.stdin.on('data', () => { retired = true; finish({ code: 0 }); });
      setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
      return child;
    },
    stopProcess: async () => {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'fixture' }) }),
    WebSocketImpl: class extends AnsweringCdpSocket {
      send() { signals.emit('SIGINT'); }
      close() { socketClosed = true; }
    },
  });
  assert.equal(starts, 1);
  assert.equal(retired, true);
  assert.equal(socketClosed, true);
});

test('managed control EOF retires its browser without requiring a later signal', { timeout: 10_000 }, async t => {
  const port = await fakeChromeCommandLine(t);
  const input = new PassThrough();
  const signals = new EventEmitter();
  let announceReady;
  const ready = new Promise(resolve => { announceReady = resolve; });
  const closed = [];
  const completion = runQaBrowserWorker({ sessionName: 'control-eof', input,
    env: { ...process.env, HAPPIER_REMOTE_EXEC_CONTROL_STDIN: '1' }, writeReady: announceReady,
  }, { signalSource: signals, capture: async (_command, args) => {
    if (args.includes('open')) {
      await writeFile(join(args[args.indexOf('--profile') + 1], 'DevToolsActivePort'), `${port}\n/devtools/browser/fixture-browser\n`);
    } else closed.push(args[args.indexOf('--session') + 1]);
    return { ok: true, exitCode: 0, out: '', err: '' };
  } });
  t.signal.addEventListener('abort', () => signals.emit('SIGINT'), { once: true });
  t.after(async () => { signals.emit('SIGINT'); await completion; });
  const browser = await ready;
  input.end();
  await completion;
  assert.ok(closed.includes(browser.session), 'control loss must close the serving browser');
  await assert.rejects(access(browser.profile), { code: 'ENOENT' });
});

test('browser retirement does not admit or synchronize a source mirror', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-browser-missing-mirror-' });
  const stackName = 'fixture-missing-mirror';
  const sourceDir = join(root, 'source');
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: root,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: stackName, HAPPIER_STACK_ENV_FILE: join(root, stackName, 'env'),
    HAPPIER_STACK_NO_DEV_TARGETS: '' };
  await mkdir(join(root, stackName));
  await writeFile(join(root, stackName, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'self-stale', platform: 'posix', ssh: 'self-stale', repoDir: '/stale/mirror', cliHomeDir: '/fixture' }],
  }));
  let dispatched = false;
  const result = await stopStackQaBrowsers({ stackName, baseDir: join(root, stackName), sourceDir, env }, {
    capture: async (command, args) => {
      if (command === 'ssh') {
        dispatched = true;
        return { ok: true, exitCode: 0, out: JSON.stringify({ stackName, pids: [] }) };
      }
      assert.ok(args.includes('mutagen'));
      assert.equal(args.includes(resolveMutagenSessionName('self-stale', sourceDir)), true);
      return { ok: true, exitCode: 0, out: '[]' };
    },
  });
  assert.equal(dispatched, true, 'browser retirement must contact its host without source admission');
  assert.deepEqual(result.remote, [{ target: 'self-stale', stackName, pids: [] }]);
  assert.deepEqual(result.warnings, []);
});

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

test('remote browser retirement uses authored source without an inherited controller preload', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-qa-browser-source-' });
  const loader = join(root, 'stale-installed-package.mjs');
  await writeFile(loader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@happier-dev/cli-common/')) throw new Error('fixture: stale installed cli-common');
  return nextResolve(specifier, context);
}
`);
  const stackName = `fixture-source-retirement-${process.pid}`;
  const target = { name: 'fixture', platform: 'posix', cliHomeDir: root,
    repoDir: fileURLToPath(new URL('../../../../../', import.meta.url)),
    remotePath: [dirname(process.execPath)] };
  const result = await runCaptureResult('/bin/bash', ['-c', buildRemoteQaBrowserStopCommand(target, { stackName })], {
    env: { ...process.env, NODE_OPTIONS: `--experimental-loader=${loader}` },
  });
  assert.equal(result.ok, true, result.err);
  assert.deepEqual(JSON.parse(result.out), { stackName, pids: [] });
});

test('browser cleanup reuses SSH and recovers a refused channel before dispatching cleanup', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-browser-cleanup-ssh-' });
  const stackName = `fixture-ssh-cleanup-${process.pid}`;
  const env = { ...process.env, HAPPIER_STACK_STORAGE_DIR: root,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer', HAPPIER_STACK_ENV_FILE: join(root, 'qa.env'),
    HAPPIER_STACK_NO_DEV_TARGETS: '' };
  await mkdir(join(root, 'producer'));
  await writeFile(join(root, 'producer', 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'nl1', platform: 'posix', ssh: 'nl1', repoDir: '/mirror', cliHomeDir: '/fixture' }],
  }));
  for (const refuse of [false, true]) {
    const transports = [];
    const result = await stopStackQaBrowsers({ stackName, baseDir: join(root, stackName), sourceDir: '/repo', env }, {
      // The external SSH boundary refuses before dispatch; real cleanup policy,
      // configuration resolution and canonical transport recovery remain active.
      capture: async (command, args) => {
        const sync = captureDevTargetSyncFixture(command, args);
        if (sync) return sync;
        assert.equal(command, 'ssh');
        transports.push(args.includes('ControlPath=none'));
        if (refuse && transports.length === 1) return { ok: false, exitCode: 255,
          err: 'mux_client_request_session: session request failed: Session open refused by peer' };
        return { ok: true, exitCode: 0, out: JSON.stringify({ stackName, pids: [4312] }) };
      },
    });
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.remote, [{ target: 'nl1', stackName, pids: [4312] }]);
    assert.deepEqual(transports, refuse ? [false, true] : [false]);
  }
  const transports = [];
  const unconfirmed = await stopStackQaBrowsers({ stackName, baseDir: join(root, stackName), sourceDir: '/repo', env }, {
    capture: async (command, args) => {
      const sync = captureDevTargetSyncFixture(command, args);
      if (sync) return sync;
      assert.equal(command, 'ssh');
      transports.push(args.includes('ControlPath=none'));
      return { ok: false, exitCode: 255, err: 'Connection to nl1 closed by remote host.' };
    },
  });
  assert.deepEqual(unconfirmed.remote, []);
  assert.equal(unconfirmed.warnings[0]?.code, 'browser_cleanup_unreachable:nl1');
  assert.deepEqual(transports, [false], 'ambiguous loss after dispatch must not replay retirement');
});

for (const ownerSignal of ['SIGINT', 'SIGKILL']) test(`${ownerSignal} owner exit closes detached browser beyond executor cancellation grace`, { skip: process.platform === 'win32' }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-qa-browser-cancel-', registerCleanup: false });
  const { root } = fixture;
  const chromePort = await fakeChromeCommandLine(t);
  const closeMarker = join(root, 'browser-closed');
  const trustCertPath = join(root, 'leaf.crt');
  await writeFile(trustCertPath, rootCertificates[0]);
  const spkiHash = createHash('sha256').update(new X509Certificate(rootCertificates[0]).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const staleInstalledLoader = join(root, 'stale-installed-package.mjs');
  await writeFile(staleInstalledLoader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@happier-dev/cli-common/')) {
    throw new Error('fixture: remote installed cli-common is stale');
  }
  return nextResolve(specifier, context);
}
`);
  const { binDir } = writeFakeBin({ root, name: 'agent-browser', content: `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);
if(a.includes('open')){
require('node:assert/strict').ok(a[a.indexOf('--args')+1].split(',').includes(${JSON.stringify(`--ignore-certificate-errors-spki-list=${spkiHash}`)}),'controller certificate trust must reach Chromium launch');
require('node:assert/strict').ok(a[a.indexOf('--args')+1].split(',').includes('--proxy-bypass-list=<-loopback>;http://127.0.0.1:33807'),'controller worker-loopback intent must reach the real worker launch');
fs.writeFileSync(path.join(a[a.indexOf('--profile')+1],'DevToolsActivePort'),${JSON.stringify(`${chromePort}\n/devtools/browser/fixture-browser\n`)});
}
else setTimeout(()=>fs.writeFileSync(${JSON.stringify(closeMarker)},'closed'),2500);
` });
  const script = `
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { runQaBrowserSession as runRealQaBrowserSession } from ${JSON.stringify(new URL('./qa_browser.mjs', import.meta.url).href)};
${AnsweringCdpSocket.toString()}
${runQaBrowserSession.toString()}
import { runCaptureResult, spawnProc, killProcessTree } from ${JSON.stringify(new URL('../proc/proc.mjs', import.meta.url).href)};
${captureReadyRemote.toString()}
let ready, resolveTunnel;
const tunnel = { completion: new Promise(resolve => { resolveTunnel = resolve; }) };
await runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'fixture',
      repoDir: ${JSON.stringify(fileURLToPath(new URL('../../../../../', import.meta.url)))}, cliHomeDir: ${JSON.stringify(root)},
      remotePath: ${JSON.stringify([binDir, dirname(process.execPath)])} },
    stackName: 'agent-qa-browser', stackBaseDir: ${JSON.stringify(root)}, sessionName: 'graceful-close', url: 'http://localhost:3025',
    trustCertPath: ${JSON.stringify(trustCertPath)}, workerLoopbackUrl: 'http://127.0.0.1:33807/peer-mediation/v2/rpc',
    env: { ...process.env, TMPDIR: ${JSON.stringify(root)} },
    onReady: value => { ready = value; console.log('CONTROLLER_READY='+JSON.stringify(value)); },
  }, {
    capture: (command, args, options) => command === 'ssh' && args.at(-1).includes(' cancel ')
      ? runCaptureResult('/bin/bash', ['-c', args.at(-1)], options) : captureReadyRemote(command, args),
    // Replace SSH transport only: remote command/custody, worker and process
    // cleanup remain real, including the executor's group-cancellation grace.
    spawnProcess: (label, _command, args, env, options) => {
      if (label.startsWith('browser-forward:')) return tunnel;
      // SSH does not inherit the controller's source preload. A stale
      // installed package must not prevent this source-tool worker loading.
      return spawnProc(label, '/bin/bash', ['-c', args.at(-1)],
        { ...env, NODE_OPTIONS: ${JSON.stringify(`--experimental-loader=${staleInstalledLoader}`)} }, options);
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

for (const phase of ['ready', 'cdp-discovery', 'cdp-attach', 'signaled']) {
test(`QA browser terminal retains redacted forward exit evidence during ${phase}`, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-forward-evidence-' });
  const signals = new EventEmitter();
  const sensitive = randomUUID();
  const terminal = [];
  t.mock.method(process.stderr, 'write', chunk => { terminal.push(String(chunk)); return true; });
  let finishWorker;
  const worker = { stdin: new PassThrough(), completion: new Promise(resolve => { finishWorker = resolve; }) };
  worker.stdin.on('data', () => finishWorker({ code: 0 }));
  let forward;
  const failForward = () => forward.stdin.end('fail');
  class PendingCdpSocket extends EventTarget {
    constructor() { super(); failForward(); }
    close() {}
  }
  const completion = runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
    stackName: 'forward-evidence', stackBaseDir: root, sessionName: 'forward-evidence', url: 'http://127.0.0.1:19364',
    env: { ...process.env, QA_BROWSER_TEST_TOKEN: sensitive },
    onReady: failForward,
  }, { signalSource: signals, capture: captureReadyRemote,
    spawnProcess: (label, _command, _args, env, options) => {
      if (!label.startsWith('browser-forward:')) {
        setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
        return worker;
      }
      // Substitute only the SSH executable; exercise real stderr and close events,
      // including the final unterminated diagnostic line.
      forward = spawnProc(label, process.execPath, ['-e', `
        process.stdin.once('data', () => {
          process.stderr.write('Connection reset by peer\\nBearer ' + process.env.QA_BROWSER_TEST_TOKEN);
          process.stdin.destroy();
          ${phase === 'signaled' ? "process.kill(process.pid, 'SIGTERM');" : 'process.exitCode = 255;'}
        });
      `], env, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      void forward.completion.then(() => setImmediate(() => signals.emit('SIGINT')));
      return forward;
    },
    stopProcess: child => child === worker ? finishWorker({ code: 0 }) : killProcessTree(child, 'SIGINT', { graceMs: 2_000 }),
    fetchImpl: async (_url, { signal }) => {
      if (phase !== 'cdp-discovery') return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://fixture' }) };
      failForward();
      return await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    ...(phase === 'cdp-attach' ? { WebSocketImpl: PendingCdpSocket } : {}),
  });
  try {
    await completion.catch(() => {});
    assert.ok(forward, 'the real forward process must have started');
    const prefix = '[dev-targets] QA browser SSH forward failure: ';
    const records = terminal.filter(line => line.startsWith(prefix));
    assert.equal(records.length, 1, 'the existing terminal must retain one forward failure record');
    const record = JSON.parse(records[0].slice(prefix.length));
    assert.equal(record.code, phase === 'signaled' ? 'remote-doctor-failed' : 'ssh-connection-failed');
    assert.equal(record.exitCode, phase === 'signaled' ? null : 255);
    assert.equal(record.signal, phase === 'signaled' ? 'SIGTERM' : null);
    assert.equal(record.phase, phase === 'signaled' ? 'ready' : phase);
    assert.ok(Number.isFinite(Date.parse(record.at)), 'exit evidence has a timestamp');
    assert.match(record.stderrTail, /\[\d{4}-\d{2}-\d{2}T[^\]]+\] Connection reset by peer/);
    assert.ok(record.stderrTail.includes('<redacted>'), 'unterminated stderr is redacted before publication');
    assert.ok(!terminal.join('').includes(sensitive), 'terminal records must not disclose credentials');
  } finally {
    signals.emit('SIGINT');
    if (forward) await killProcessTree(forward, 'SIGINT', { graceMs: 2_000 });
    await completion.catch(() => {});
  }
});
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
  // Inventory retirement can settle the SSH process before the assertions run.
  // Observe its rejection immediately so the ownership assertion decides RED.
  const settled = session.then(() => null, error => error);
  try {
    await ready;
    const producer = await stopQaBrowsers({ stackName: 'producer', envPath: producerEnvPath });
    assert.ok(!producer.pids.includes(tunnel.pid), 'producer browser retirement must not select the QA forward');
    assert.equal(tunnel.exitCode, null, 'the forward must survive producer browser retirement');
    const owning = await stopQaBrowsers({ stackName: 'agent-qa-browser', envPath: qaEnvPath });
    assert.ok(owning.pids.includes(tunnel.pid), 'owning QA browser retirement must select the actual forward');
  } finally {
    signalSource.emit('SIGINT');
    const error = await settled;
    if (error) assert.match(error.message, /QA browser SSH forward exited/);
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

test('QA browser launches under a long remote scratch path without exceeding the Unix socket path boundary', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: `hstack-remote-command-${'x'.repeat(70)}-` });
  const previousTmpdir = process.env.TMPDIR;
  const chromePort = await fakeChromeCommandLine(t);
  const signals = new EventEmitter();
  process.env.TMPDIR = root;
  try {
    await runQaBrowserWorker({ sessionName: 'long-scratch', input: new PassThrough(),
      writeReady: () => signals.emit('SIGINT') }, {
      signalSource: signals,
      // Chromium is the external boundary. Exercise its actual AF_UNIX socket
      // constraint rather than mocking the worker's temp-directory decision.
      capture: async (_command, args, options) => {
        if (!args.includes('open')) return { ok: true, exitCode: 0, out: '', err: '' };
        const ipcRoot = await mkdtemp(join(options.env.TMPDIR ?? tmpdir(), 'org.chromium.Chromium.'));
        const socket = createSocketServer();
        try {
          await new Promise((resolve, reject) => {
            socket.once('error', reject);
            socket.listen(join(ipcRoot, 'SingletonSocket'), resolve);
          });
          await writeFile(join(args[args.indexOf('--profile') + 1], 'DevToolsActivePort'), `${chromePort}\n/devtools/browser/fixture-browser\n`);
          return { ok: true, exitCode: 0, out: '', err: '' };
        } catch (error) {
          return { ok: false, exitCode: 1, out: '', err: `Chromium singleton socket: ${error.code}` };
        } finally {
          if (socket.listening) await new Promise(resolve => socket.close(resolve));
          await rm(ipcRoot, { recursive: true, force: true });
        }
      },
    });
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
});

test('QA browser IPC names fit macOS and Linux for incident and arbitrarily long lane names', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-qa-browser-ipc-', parentDir: '/tmp' });
  const chromePort = await fakeChromeCommandLine(t);
  for (const sessionName of ['runnable-now-1102-recovered', 'lane-'.repeat(300)]) {
    const signals = new EventEmitter();
    const opened = new Set();
    const closed = new Set();
    await runQaBrowserWorker({ sessionName, input: new PassThrough(),
      writeReady: () => signals.emit('SIGINT') }, {
      signalSource: signals,
      // agent-browser is the external process boundary. Apply both native
      // sun_path capacities (including the terminating NUL), then bind for real.
      capture: async (_command, args, options) => {
        const session = args[args.indexOf('--session') + 1];
        assert.equal(options.env.AGENT_BROWSER_SESSION, session);
        const socketPath = join(root, `${session}.sock`);
        for (const capacity of [104, 108]) {
          assert.ok(Buffer.byteLength(socketPath) < capacity, `IPC path must fit sun_path[${capacity}]`);
        }
        if (args.includes('open')) {
          const socket = createSocketServer();
          await new Promise((resolve, reject) => {
            socket.once('error', reject);
            socket.listen(socketPath, resolve);
          });
          await new Promise(resolve => socket.close(resolve));
          opened.add(session);
          await writeFile(join(args[args.indexOf('--profile') + 1], 'DevToolsActivePort'), `${chromePort}\n/devtools/browser/fixture-browser\n`);
        } else closed.add(session);
        return { ok: true, exitCode: 0, out: '', err: '' };
      },
    });
    assert.equal(opened.size, 2, 'discovery and serving browsers retain separate IPC identities');
    assert.deepEqual(closed, opened, 'cleanup must reuse exactly the launched IPC identities');
  }
});

test('QA browser preserves its launch error when cleanup also fails', async () => {
  const signals = new EventEmitter();
  let profile;
  try {
    await assert.rejects(runQaBrowserWorker({ sessionName: 'launch-failure', input: new PassThrough() }, {
      signalSource: signals,
      capture: async (_command, args) => {
        if (args.includes('open')) {
          profile = args[args.indexOf('--profile') + 1];
          return { ok: false, exitCode: 1, err: 'original launch failure' };
        }
        return { ok: false, exitCode: 1, err: 'secondary cleanup failure' };
      },
    }), error => {
      assert.match(error.message, /QA browser launch failed: original launch failure/);
      assert.match(error.cause?.message ?? '', /secondary cleanup failure/);
      return true;
    });
  } finally {
    if (profile) await rm(profile, { recursive: true, force: true });
  }
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

test('healthy browser admission answers CDP without replacing its worker', async () => {
  const signalSource = new EventEmitter();
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
      probes++;
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/fixture' }) };
    },
  });
  assert.equal(ready.localFallback, false);
  assert.equal(ready.target, 'absent');
  assert.equal(probes, 1);
});

for (const recoveryEnd of ['cancellation', 'worker exit']) {
test(`QA browser backs off dropped SSH forwards, restores its bindings, and settles after ${recoveryEnd}`, async t => {
  // Clock and SSH are external boundaries; retry and browser lifetime stay real.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const signalSource = new EventEmitter();
  let finishWorker;
  const worker = { stdin: new PassThrough(), completion: new Promise(resolve => { finishWorker = resolve; }) };
  worker.stdin.on('data', () => finishWorker({ code: 0 }));
  const forwards = [];
  let workerStarts = 0;
  let abortedReadinessProbes = 0;
  let dropForward;
  let ready;
  let resolveReady;
  const readiness = new Promise(resolve => { resolveReady = resolve; });
  let recovered = false;
  const result = runQaBrowserSession({ target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
    stackName: 'agent-qa-browser', sessionName: 'restore-forward', stackBaseDir: '/fixture', url: 'http://localhost:3025',
    onReady: value => { ready = value; resolveReady(); },
  }, { signalSource, capture: captureReadyRemote,
    spawnProcess: (label, _command, args, _env, options) => {
      if (!label.startsWith('browser-forward:')) {
        workerStarts++;
        setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
        return worker;
      }
      const child = { completion: new Promise(resolve => { dropForward = resolve; }) };
      forwards.push({ args, child, startedAt: Date.now() });
      // The old remote SSH peer can still hold its reverse listener after the
      // client loses transport. A replacement can exit before CDP works.
      if (forwards.length === 2) setImmediate(() => dropForward({ code: 255 }));
      return child;
    },
    stopProcess: async () => { dropForward({ code: 0 }); },
    fetchImpl: async (url, { signal }) => {
      if (forwards.length === 2) {
        return await new Promise((_, reject) => signal.addEventListener('abort', () => {
          abortedReadinessProbes++;
          reject(signal.reason);
        }, { once: true }));
      }
      if (forwards.length === 3) {
        assert.equal(url, `${ready.cdpHttpUrl}/json/version`, 'automation retains the same CDP endpoint');
        assert.equal(worker.stdin.readableLength, 0, 'transport recovery must not close the browser worker');
        recovered = true;
      }
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/fixture' }) };
    },
  });
  try {
    await readiness;
    dropForward({ code: 255 });
    await new Promise(setImmediate);
    assert.equal(forwards.length, 1, 'transport failure must not hot-spawn another SSH process');
    t.mock.timers.tick(4_999);
    await new Promise(setImmediate);
    assert.equal(forwards.length, 1);
    t.mock.timers.tick(1);
    await new Promise(setImmediate);
    assert.equal(forwards.length, 2);
    // Let the replacement's SSH-exit event settle before advancing its delay.
    await new Promise(setImmediate);
    t.mock.timers.tick(9_999);
    await new Promise(setImmediate);
    assert.equal(forwards.length, 2, 'a failed replacement grows the existing retry delay');
    t.mock.timers.tick(1);
    await new Promise(setImmediate);
    assert.equal(recovered, true, 'a genuine reconnection restores CDP health');
    assert.deepEqual(forwards.map(forward => forward.startedAt), [0, 5_000, 15_000]);
    dropForward({ code: 255 });
    await new Promise(setImmediate);
    assert.equal(forwards.length, 3);
    t.mock.timers.tick(4_999);
    await new Promise(setImmediate);
    assert.equal(forwards.length, 3);
    t.mock.timers.tick(1);
    await new Promise(setImmediate);
    assert.equal(forwards.length, 4, 'successful readiness resets the recovery delay');
    assert.deepEqual(forwards.map(forward => forward.startedAt), [0, 5_000, 15_000, 20_000]);
    dropForward({ code: 255 });
    await new Promise(setImmediate);
  } finally {
    if (recoveryEnd === 'worker exit') finishWorker({ code: 0 });
    else signalSource.emit('SIGINT');
    await result;
  }
  t.mock.timers.tick(60_000);
  await new Promise(setImmediate);
  assert.equal(forwards.length, 4);
  assert.equal(workerStarts, 1, 'forward recovery must never replay the browser payload');
  assert.equal(abortedReadinessProbes, 1, 'a failed recovery attempt must release its pending HTTP probe');
  for (const forward of forwards.slice(1)) {
    assert.deepEqual(forward.args, forwards[0].args, 'both SOCKS and CDP bindings survive recovery');
  }
});
}

test('admitted browser survives pending recovery beyond acquisition window and settles worker exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = new EventEmitter();
  let finishWorker, dropForward, announceReady, announceProbe;
  let closed = false;
  const worker = { stdin: new PassThrough(), completion: new Promise(resolve => { finishWorker = resolve; }) };
  worker.stdin.on('data', () => { closed = true; finishWorker({ code: 0 }); });
  const ready = new Promise(resolve => { announceReady = resolve; });
  const probing = new Promise(resolve => { announceProbe = resolve; });
  let forwards = 0;
  const result = runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
    stackName: 'fixture', stackBaseDir: '/fixture', sessionName: 'worker-exit', url: 'http://app.localhost:19364',
    onReady: announceReady,
  }, { signalSource: signals, capture: captureReadyRemote,
    spawnProcess: (label, _command, _args, _env, options) => {
      if (!label.startsWith('browser-forward:')) {
        setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
        return worker;
      }
      forwards++;
      return { completion: new Promise(resolve => { dropForward = resolve; }) };
    },
    stopProcess: async () => dropForward({ code: 0 }),
    fetchImpl: async (_url, { signal }) => {
      if (forwards === 1) return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://fixture' }) };
      announceProbe();
      return await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  void result.catch(() => {});
  try {
    await ready;
    dropForward({ code: 255 });
    await new Promise(setImmediate);
    t.mock.timers.tick(5_000);
    await probing;
    t.mock.timers.tick(30_000);
    await new Promise(setImmediate);
    assert.equal(closed, false, 'admission timeout must never retire a browser already held by a lane');
    finishWorker({ code: 0 });
    await assert.doesNotReject(result, 'a successful worker exit must not become an HTTP AbortError');
    assert.equal(forwards, 2);
  } finally {
    signals.emit('SIGINT');
    await result.catch(() => {});
  }
});

test('QA browser reports an unavailable authentication refusal without retrying its forward', async () => {
  const signals = new EventEmitter();
  let finishWorker;
  const worker = { stdin: new PassThrough(), completion: new Promise(resolve => { finishWorker = resolve; }) };
  worker.stdin.on('data', () => finishWorker({ code: 0 }));
  let finishForward, diagnose;
  let forwards = 0;
  const failure = await runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
    stackName: 'fixture', stackBaseDir: '/fixture', sessionName: 'refused', url: 'http://app.localhost:19364',
    onReady: () => {
      diagnose?.({ stream: 'stderr', line: 'Host key verification failed.' });
      finishForward({ code: 255 });
    },
  }, { signalSource: signals, capture: captureReadyRemote,
    spawnProcess: (label, _command, _args, _env, options) => {
      if (!label.startsWith('browser-forward:')) {
        setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
        return worker;
      }
      forwards++;
      diagnose = options.onLine;
      if (forwards > 1) setImmediate(() => signals.emit('SIGINT'));
      return { completion: new Promise(resolve => { finishForward = resolve; }) };
    },
    stopProcess: async () => finishForward({ code: 0 }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://fixture' }) }),
  }).then(() => null, error => error);
  assert.equal(failure?.code, 'ssh-authentication-failed');
  assert.match(failure.message, /unavailable/);
  assert.equal(forwards, 1, 'a classified non-retryable refusal settles without another SSH spawn');
});

test('QA browser exits when its SSH forward dies during a pending CDP health request', async () => {
  const signalSource = new EventEmitter();
  let workers = 0;
  let finishForward;
  const tunnel = { exitCode: null, completion: new Promise(resolve => { finishForward = resolve; }) };
  let requested;
  const healthRequested = new Promise(resolve => { requested = resolve; });
  let ready = false;
  const session = runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
    stackName: 'agent-qa-browser', sessionName: 'health-disconnect', stackBaseDir: '/fixture', url: 'http://localhost:3025',
    onReady: () => { ready = true; },
  }, { signalSource, capture: captureReadyRemote,
    spawnProcess: (label, _command, _args, _env, options) => {
      if (label.startsWith('browser-forward:')) return tunnel;
      workers++;
      let finishWorker;
      const worker = { stdin: new PassThrough(), completion: new Promise(resolve => { finishWorker = resolve; }) };
      worker.stdin.on('data', () => finishWorker({ code: 0 }));
      setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
      return worker;
    },
    stopProcess: async () => finishForward({ code: 0 }),
    // An interrupted SSH stream can leave HTTP awaiting a response. The real
    // lifecycle must react to process exit independently of HTTP completion.
    fetchImpl: async (_url, { signal }) => {
      requested();
      return await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const result = session.then(() => ({ outcome: 'success' }), error => ({ outcome: 'failed', error }));
  await healthRequested;
  tunnel.exitCode = 255;
  finishForward({ code: 255 });
  let timer;
  try {
    const observed = await Promise.race([result,
      new Promise(resolve => { timer = setTimeout(() => resolve({ outcome: 'pending' }), 300); })]);
    assert.equal(observed.outcome, 'failed', 'a dead forward must close its owner without waiting for HTTP');
    assert.equal(observed.error.code, 'qa-browser-cdp-unavailable');
    assert.equal(workers, 2, 'both failed forwards retire their worker, with only one replacement');
    assert.equal(ready, false);
  } finally {
    clearTimeout(timer);
    signalSource.emit('SIGINT');
    await result;
  }
});

// A forward is transport, not the browser's cancellation authority. The
// 20:47Z owner continuation requires the same browser to survive its loss.
for (const ended of [{ code: 0 }, { code: null, signal: 'SIGTERM' }]) {
test(`QA browser retains its worker and restores clean/signaled forward loss (${ended.signal ?? ended.code})`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = new EventEmitter();
  let finishWorker, finishForward, announceReady, announceRecovered;
  const worker = { stdin: new PassThrough(), completion: new Promise(resolve => { finishWorker = resolve; }) };
  worker.stdin.on('data', () => finishWorker({ code: 0 }));
  const ready = new Promise(resolve => { announceReady = resolve; });
  const recovered = new Promise(resolve => { announceRecovered = resolve; });
  const bindings = [];
  let workers = 0;
  const session = runQaBrowserSession({
    stackName: 'agent-qa-browser', stackBaseDir: '/fixture',
    sessionName: 'forward-loss', url: 'http://127.0.0.1:19364/',
    target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
    onReady: announceReady,
  }, {
    signalSource: signals,
    capture: async (command, args) => captureDevTargetSyncFixture(command, args)
      ?? { ok: true, exitCode: 0, out: '', err: '' },
    spawnProcess: (label, _command, args, _env, options) => {
      if (!label.startsWith('browser-forward:')) {
        workers++;
        setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/fixture","pid":12,"proxyPort":40202}' }));
        return worker;
      }
      bindings.push(args);
      const child = { completion: new Promise(resolve => { finishForward = resolve; }) };
      if (bindings.length === 2) setImmediate(() => finishForward(ended));
      return child;
    },
    stopProcess: async () => finishForward({ code: 0 }),
    fetchImpl: async (_url, { signal }) => {
      if (bindings.length === 2) return await new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      if (bindings.length === 3) announceRecovered();
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: 'fixture' }) };
    },
  });
  try {
    await ready;
    finishForward(ended);
    await new Promise(setImmediate);
    t.mock.timers.tick(5_000);
    await new Promise(setImmediate);
    // The replacement exits in its own immediate; let its retry delay settle.
    await new Promise(setImmediate);
    t.mock.timers.tick(10_000);
    await recovered;
    await new Promise(setImmediate);
    assert.equal(workers, 1, 'forward recovery preserves the existing browser worker');
    assert.equal(bindings.length, 3, 'replacement loss before readiness also restores the route');
    for (const args of bindings.slice(1)) assert.deepEqual(args, bindings[0]);
  } finally {
    signals.emit('SIGINT');
    await session;
  }
});
}

test('GPU QA browser uses headed Chromium in the existing profile and SIGINT cleanup lifecycle', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-qa-gpu-' });
  const { binDir } = writeFakeBin({ root, name: 'chromium', content: `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n` });
  const port = await fakeChromeCommandLine(t, join(binDir, 'chromium'));
  const signals = new EventEmitter();
  const input = new PassThrough();
  const launches = [];
  let profile;
  const completion = runQaBrowserWorker({ sessionName: 'gpu', gpu: true, proxy: true, input,
    writeReady: value => { profile = value.profile; signals.emit('SIGINT'); } }, {
    signalSource: signals,
    // Only the external agent-browser process is replaced; launch adaptation and custody stay real.
    capture: async (_command, args) => {
      if (args.at(-1) === 'about:blank') {
        launches.push(args);
        const directory = args[args.indexOf('--profile') + 1];
        await writeFile(join(directory, 'DevToolsActivePort'), `${port}\n/devtools/browser/fixture-browser\n`);
      }
      return { ok: true, exitCode: 0, out: '', err: '' };
    },
  });
  await completion;
  assert.equal(launches.length, 2);
  for (const args of launches) {
    assert.ok(args.includes('--headed'), 'GPU launches must use the real display compositor');
    assert.ok(args[args.indexOf('--args') + 1].includes('--disable-software-rasterizer'), 'GPU mode must not substitute SwiftShader');
  }
  await assert.rejects(access(profile), { code: 'ENOENT' });
});

test('each QA browser lifetime preserves canonical Home origins through its own SOCKS route and cleans only its profile', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-qa-browser-pointer-' });
  const { binDir } = writeFakeBin({ root, name: 'chromium', content: `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n` });
  const chromePort = await fakeChromeCommandLine(t, join(binDir, 'chromium'));
  const instances = [];
  const closed = [];
  const retiringSessions = new Set();
  // agent-browser is an external process boundary; profiles and lifecycle logic
  // remain real. Its DevToolsActivePort is the Chromium-owned wire contract.
  const capture = async (command, args) => {
    assert.equal(command, 'agent-browser');
    const session = args[args.indexOf('--session') + 1];
    if (args.at(-1) === 'about:blank') {
      // agent-browser v0.34.0 daemon.rs acknowledges close before notifying
      // daemon shutdown. A reopened session can reach that retiring daemon.
      if (retiringSessions.has(session)) return { ok: false, exitCode: 1, out: '',
        err: 'Could not configure browser: session daemon is still shutting down after acknowledged close' };
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
        assert.ok(!JSON.parse(launched.out).some(arg => arg.includes('fake-') || arg.includes('fake_audio')),
          'ordinary QA browsers must retain real devices and permission prompts');
        instances.push({ launchArgs, proxyPort: proxy ? Number(proxy.split(':').at(-1)) : null });
      }
      const profile = args[args.indexOf('--profile') + 1];
      await writeFile(join(profile, 'DevToolsActivePort'), `${chromePort}\n/devtools/browser/fixture-browser\n`);
    } else {
      assert.equal(args.at(-1), 'close');
      retiringSessions.add(session);
      closed.push(session);
    }
    return { ok: true, exitCode: 0, out: '', err: '' };
  };
  const start = (workerLoopbackUrl) => {
    const input = new PassThrough();
    const signals = new EventEmitter();
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const completion = runQaBrowserWorker({ sessionName: 'same-lane-name', input, proxy: true, workerLoopbackUrl,
      writeReady: value => { resolveReady(value); } }, { capture, signalSource: signals });
    completion.catch(rejectReady);
    t.after(async () => { signals.emit('SIGINT'); await completion; });
    return { input, ready, completion, signals };
  };
  const first = start();
  const second = start('http://127.0.0.1:33807/peer-mediation/v2/rpc');
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
  assert.deepEqual(instances.map(instance => instance.launchArgs.find(arg => arg.startsWith('--proxy-bypass-list='))).sort(),
    ['--proxy-bypass-list=<-loopback>', '--proxy-bypass-list=<-loopback>;http://127.0.0.1:33807'],
    'only the explicitly selected worker listener bypasses the controller route; Home origins still use SOCKS');
  for (const instance of instances) {
    assert.ok(instance.proxyPort, 'use native origin-preserving transport rather than rewriting the Home URL');
  }
  assert.deepEqual(instances.map(instance => instance.proxyPort).sort(), [a.proxyPort, b.proxyPort].sort());
  assert.notEqual(a.proxyPort, b.proxyPort);
});

test('worker loopback routing rejects remote endpoints and controller Home collisions before launching SSH', async () => {
  for (const workerLoopbackUrl of ['http://example.com:33807', 'http://user@127.0.0.1:33807', 'http://127.0.0.1:3025']) {
    await assert.rejects(runQaBrowserSession({
      target: { name: 'absent', platform: 'posix', ssh: 'absent', repoDir: '/mirror', cliHomeDir: '/fixture' },
      stackName: 'agent-qa-browser', sessionName: 'loopback-validation', stackBaseDir: '/fixture',
      url: 'http://localhost:19364/?server=http%3A%2F%2F127.0.0.1%3A3025', workerLoopbackUrl,
    }, {
      capture: async () => { assert.fail('invalid worker routing must fail before SSH'); },
    }), /loopback/);
  }
});

for (const fileBacked of [false, true]) test(`opt-in fake audio ${fileBacked ? 'copies speech into the worker profile' : 'uses Chromium devices'} without granting permission`, { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: "hstack-audio, quote'-" });
  const wav = await readFile(new URL('../../../../../packages/tests/fixtures/voice/phrases/short-command.24k.wav', import.meta.url));
  const { binDir } = writeFakeBin({ root, name: 'chromium', content: `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n` });
  const chromePort = await fakeChromeCommandLine(t, join(binDir, 'chromium'));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const input = new PassThrough();
  const signals = new EventEmitter();
  let profile, launchedArgs;
  try {
    // The existing lifetime control pipe carries bytes, not a controller path.
    if (fileBacked) input.write(`fake-audio:${wav.toString('base64')}\n`);
    await runQaBrowserWorker({ sessionName: 'fake-audio', fakeAudio: fileBacked ? 'file' : 'device', input,
      writeReady: value => { profile = value.profile; signals.emit('SIGINT'); } }, {
      signalSource: signals,
      capture: async (_command, args) => {
        if (args.includes('open')) {
          profile = args[args.indexOf('--profile') + 1];
          const splitArgs = args[args.indexOf('--args') + 1].split(',');
          if (args.includes('--executable-path')) {
            const launched = await runCaptureResult(args[args.indexOf('--executable-path') + 1], splitArgs);
            assert.equal(launched.ok, true, launched.err);
            launchedArgs = JSON.parse(launched.out);
            assert.ok(launchedArgs.includes('--use-fake-device-for-media-stream'));
            assert.ok(!launchedArgs.includes('--use-fake-ui-for-media-stream'));
            const audioArg = launchedArgs.find(arg => arg.startsWith('--use-file-for-fake-audio-capture='));
            if (fileBacked) {
              assert.equal(audioArg, `--use-file-for-fake-audio-capture=${join(profile, 'fake-audio.wav')}`);
              assert.deepEqual(await readFile(audioArg.slice('--use-file-for-fake-audio-capture='.length)), wav);
            } else assert.equal(audioArg, undefined);
          }
          await writeFile(join(profile, 'DevToolsActivePort'), `${chromePort}\n/devtools/browser/fixture-browser\n`);
        }
        return { ok: true, exitCode: 0, out: '', err: '' };
      },
    });
    assert.ok(launchedArgs);
    await assert.rejects(access(profile), { code: 'ENOENT' });
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
});

test('file-backed fake audio reaches the remote worker through existing custody and cleans with its profile', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: "hstack-audio, controller'-" });
  const source = join(root, "speech, ' $(false).wav");
  const wav = await readFile(new URL('../../../../../packages/tests/fixtures/voice/phrases/short-command.24k.wav', import.meta.url));
  assert.ok(parseVoiceWavContainer(wav).dataBytes.some(byte => byte !== 0), 'the QA speech fixture must contain nonzero PCM energy');
  await writeFile(source, wav);
  const chromePort = await fakeChromeCommandLine(t);
  const observed = join(root, 'observed.json');
  const { binDir } = writeFakeBin({ root, name: 'agent-browser', content: `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);
if(a.includes('open')){
if(a.includes('--executable-path')){
const script=fs.readFileSync(a[a.indexOf('--executable-path')+1],'utf8');
const profile=a[a.indexOf('--profile')+1];
fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({script,profile,audio:fs.readFileSync(path.join(profile,'fake-audio.wav')).toString('base64')}));
}
fs.writeFileSync(path.join(a[a.indexOf('--profile')+1],'DevToolsActivePort'),${JSON.stringify(`${chromePort}\n/devtools/browser/fixture-browser\n`)});
}
` });
  const signals = new EventEmitter();
  let resolveTunnel, ready;
  const tunnel = { completion: new Promise(resolve => { resolveTunnel = resolve; }) };
  await runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'fixture',
      repoDir: fileURLToPath(new URL('../../../../../', import.meta.url)), cliHomeDir: root,
      remotePath: [binDir, dirname(process.execPath)] },
    stackName: 'agent-qa-browser', stackBaseDir: root, sessionName: 'file-audio',
    url: 'http://localhost:3025', fakeAudio: source, env: { ...process.env, TMPDIR: root },
    onReady: value => { ready = value; signals.emit('SIGINT'); },
  }, {
    signalSource: signals, capture: captureReadyRemote,
    spawnProcess: (label, _command, args, env, options) => label.startsWith('browser-forward:')
      ? tunnel : spawnProc(label, '/bin/bash', ['-c', args.at(-1)], env, options),
    stopProcess: async child => {
      assert.equal(child, tunnel);
      resolveTunnel({ code: 0 });
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://localhost/devtools/browser/fixture-browser' }) }),
  });
  const result = JSON.parse(await readFile(observed, 'utf8'));
  assert.equal(result.audio, wav.toString('base64'));
  assert.ok(result.script.includes('--use-file-for-fake-audio-capture='));
  assert.equal(result.profile, ready.profile);
  await assert.rejects(access(ready.profile), { code: 'ENOENT' });
  assert.deepEqual(await readFile(source), wav);
});

test('unreadable fake-audio file fails before any remote browser allocation', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-audio-missing-' });
  let remoteCalls = 0;
  await assert.rejects(runQaBrowserSession({
    target: { name: 'absent', platform: 'posix', ssh: 'fixture' },
    stackName: 'agent-qa-browser', stackBaseDir: root, sessionName: 'missing-audio',
    url: 'http://localhost:3025', fakeAudio: join(root, 'missing.wav'),
  }, { capture: async () => { remoteCalls++; return { ok: false, exitCode: 255 }; } }), /fake-audio requires a readable WAV file/);
  assert.equal(remoteCalls, 0);
});

test('closing while awaiting fake audio cleans the owned profile without launching Chromium', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-audio-cancel-' });
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const input = new PassThrough();
  input.write('close\n');
  try {
    await runQaBrowserWorker({ sessionName: 'cancel-audio', fakeAudio: 'file', input,
      writeReady: () => assert.fail('cancelled audio transfer cannot publish readiness'),
    }, { signalSource: new EventEmitter(), capture: async () => assert.fail('cancelled audio transfer cannot launch Chromium') });
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
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

test('browser signin reads the named Stack canonical address rather than the transport or ambient Home', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-signin-home-' });
  const stackName = 'signin-home';
  const stackDir = join(fixture.root, stackName);
  await mkdir(stackDir);
  const canonical = new URL('https:' + '//qa-home.invalid').origin;
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.root,
    HAPPIER_CANONICAL_SERVER_URL: new URL('https:' + '//other-home.invalid').origin });
  await writeFile(join(stackDir, 'env'), [
    `HAPPIER_CANONICAL_SERVER_URL=${canonical}`,
    'HAPPIER_STACK_SERVER_PORT=14311',
    'HAPPIER_STACK_DAEMON=0', 'HAPPIER_STACK_SERVE_UI=0', '',
  ].join('\n'));
  const info = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName,
    synchronizeDaemonState: false, observeRemoteSourceRuntime: false });
  assert.equal(info.urls.canonicalServerUrl, canonical);
  assert.equal(info.urls.internalServerUrl, null);
});

test('browser signin excludes an ambient canonical Home when the named Stack has no override', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-signin-ambient-' });
  const stackName = 'signin-home';
  const stackDir = join(fixture.root, stackName);
  await mkdir(stackDir);
  withPatchedProcessEnv(t, { HAPPIER_STACK_STORAGE_DIR: fixture.root,
    HAPPIER_CANONICAL_SERVER_URL: new URL('https:' + '//other-home.invalid').origin });
  await writeFile(join(stackDir, 'env'), [
    'HAPPIER_STACK_SERVER_PORT=14311', 'HAPPIER_STACK_DAEMON=0', 'HAPPIER_STACK_SERVE_UI=0',
    'HAPPIER_STACK_BIND_MODE=loopback', 'HAPPIER_STACK_LOCALHOST_SUBDOMAINS=1',
    'HAPPIER_STACK_LOCALHOST_SUBDOMAIN_PREFIX=happier', '',
  ].join('\n'));
  const info = await readStackInfoSnapshot({ rootDir: process.cwd(), stackName,
    synchronizeDaemonState: false, observeRemoteSourceRuntime: false });
  assert.equal(info.urls.canonicalServerUrl, new URL('http:' + '//happier-signin-home.localhost:14311').origin);
});

test('browser signin rejects malformed stdin with a typed, sanitized result before browser access', async () => {
  const input = randomBytes(7).toString('hex');
  const result = await runCaptureResult(process.execPath, [
    '--import=./apps/stack/bin/localSourceRuntimeBootstrap.mjs',
    './apps/stack/scripts/dev_targets.mjs', 'browser', 'signin', 'absent', '--stack=qa-signin-test',
  ], { input, cwd: fileURLToPath(new URL('../../../../..', import.meta.url)) });
  assert.equal(result.exitCode, 1);
  assert.equal(result.out.trim(), JSON.stringify({ ok: false, reason: 'invalid_key' }));
  assert.equal((result.out + result.err).includes(input), false);
});

for (const outcome of ['home', 'restore_failed', 'restore_entry_unavailable', 'disconnect']) {
  test(`browser signin settles ${outcome} without exporting credentials or closing the browser`, async () => {
    const input = randomBytes(32).toString('base64url');
    const origin = new URL('http:' + '//127.0.0.1:1234');
    const canonicalHomeUrl = new URL('http:' + '//qa-home.localhost:5678').href;
    let socketClosed = false;
    // CDP is an external browser boundary. The fixture implements its protocol,
    // while endpoint selection, transport and page-result handling stay real.
    class BrowserSocket extends EventTarget {
      evaluated = 0;
      navigations = 0;
      loaded = false;
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
      send(raw) {
        const { id, method, params } = JSON.parse(raw);
        queueMicrotask(() => {
          if (method === 'Runtime.callFunctionOn' && outcome === 'disconnect') {
            this.dispatchEvent(new Event('close'));
            return;
          }
          if (method === 'Runtime.evaluate') assert.fail('use the main-frame context admitted by this navigation');
          if (method === 'Runtime.callFunctionOn') {
            assert.equal(this.loaded, true, 'an unrelated load event must not admit the restore form');
            assert.equal(params.executionContextId, 42);
            assert.equal(params.functionDeclaration.includes(input), false);
            this.evaluated++;
          }
          this.message({ id, result: method === 'Page.navigate' ? { frameId: 'main', loaderId: `document-${++this.navigations}` }
            : method === 'Runtime.callFunctionOn' ? { result: { value: this.evaluated === 2 ? 'account' : outcome } }
            : method === 'Network.getResponseBody' ? { body: JSON.stringify({ id: params.requestId === 'profile' ? 'account-owner-id' : 'wrong-account' }) } : {} });
          if (method === 'Page.navigate') {
            this.loaded = false;
            const url = new URL(params.url);
            assert.equal(url.searchParams.get('server'), url.pathname === '/restore/manual' ? canonicalHomeUrl : null,
              'restore must select the Stack Home through the app gate before accepting stdin');
            this.message({ method: 'Network.responseReceived', params: {
              requestId: 'previous', frameId: 'main', loaderId: 'previous',
              response: { url: new URL('/v1/account/profile', origin).href, status: 200 },
            } });
            this.message({ method: 'Network.loadingFinished', params: { requestId: 'previous' } });
            this.message({ method: 'Page.loadEventFired', params: {} });
            this.message({ method: 'Page.lifecycleEvent', params: { frameId: 'main', loaderId: 'previous', name: 'load' } });
            setImmediate(() => {
              this.loaded = true;
              this.message({ method: 'Runtime.executionContextCreated', params: {
                context: { id: 42, auxData: { isDefault: true, frameId: 'main' } },
              } });
              this.message({ method: 'Page.lifecycleEvent', params: { frameId: 'main', loaderId: `document-${this.navigations}`, name: 'load' } });
            });
          }
          if (method === 'Runtime.callFunctionOn' && outcome === 'home') {
            this.message({ method: 'Runtime.bindingCalled', params: { name: 'hstackRestoreSubmitted', payload: '' } });
            this.message({ method: 'Network.requestWillBeSent', params: {
              requestId: 'foreign', request: { url: new URL('/v1/account/profile', 'https:' + '//other.invalid').href },
            } });
            this.message({ method: 'Network.responseReceived', params: {
              requestId: 'foreign', frameId: 'main', loaderId: `document-${this.navigations}`,
              response: { url: new URL('/v1/account/profile', 'https:' + '//other.invalid').href, status: 200 },
            } });
            this.message({ method: 'Network.loadingFinished', params: { requestId: 'foreign' } });
            this.message({ method: 'Network.requestWillBeSent', params: {
              requestId: 'profile', request: { url: new URL('/v1/account/profile', origin).href },
            } });
            this.message({ method: 'Network.responseReceived', params: {
              requestId: 'profile', frameId: 'main', loaderId: `document-${this.navigations}`,
              response: { url: new URL('/v1/account/profile', canonicalHomeUrl).href, status: 200 },
            } });
            this.message({ method: 'Network.loadingFinished', params: { requestId: 'profile' } });
          }
        });
      }
      close() { socketClosed = true; }
    }
    const result = await runQaBrowserSigninPage({
      urls: { uiUrl: origin.href, canonicalServerUrl: canonicalHomeUrl }, cdpHttpUrl: origin.href, key: input,
    }, {
      WebSocketImpl: BrowserSocket,
      fetchImpl: async () => ({ ok: true, json: async () => [
        { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws:' + '//127.0.0.1:9999/devtools/page/fixture' },
      ] }),
    });
    assert.deepEqual(result, outcome === 'home' ? { ok: true, accountIdPrefix: 'account-' }
      : { ok: false, reason: outcome === 'disconnect' ? 'browser_unavailable' : outcome });
    assert.equal(JSON.stringify(result).includes(input), false);
    assert.equal(socketClosed, true);
  });
}

test('an explicit CDP endpoint is required without starting a browser', async () => {
  const result = await runQaBrowserSignin({ sessionName: 'missing', stackName: 'qa',
    input: Readable.from([randomBytes(32).toString('base64url')]),
  }, {
    fetchImpl: async () => { assert.fail('must not reach a browser'); },
  });
  assert.deepEqual(result, { ok: false, reason: 'cdp_required' });
});
