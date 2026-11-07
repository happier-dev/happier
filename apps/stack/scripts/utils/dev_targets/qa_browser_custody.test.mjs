import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { runQaBrowserSigninPage } from './qa_browser_signin_page.mjs';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { captureDevTargetSyncFixture } from '../../testkit/core/dev_target_sync.mjs';
import { runQaBrowserSession } from './qa_browser.mjs';

// Only SSH/process, Chromium's CDP response and the retry clock are replaced.
test('a dropped forward cannot recover through a port reused by another browser', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = new EventEmitter();
  let finishWorker, dropForward, resolveReady, resolveReused;
  const worker = { stdin: new PassThrough(), completion: new Promise(resolve => { finishWorker = resolve; }) };
  worker.stdin.on('data', () => finishWorker({ code: 0 }));
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const reused = new Promise(resolve => { resolveReused = resolve; });
  let forwards = 0;
  const result = runQaBrowserSession({
    target: { name: 'fixture', platform: 'posix', ssh: 'fixture', repoDir: '/mirror', cliHomeDir: '/fixture' },
    stackName: 'fixture', stackBaseDir: '/fixture', sessionName: 'custody', url: 'http://localhost:3025',
    onReady: resolveReady,
  }, {
    signalSource: signals,
    capture: async (command, args) => captureDevTargetSyncFixture(command, args)
      ?? { ok: true, exitCode: 0, out: '', err: '' },
    spawnProcess(label, _command, _args, _env, options) {
      if (!label.startsWith('browser-forward:')) {
        setImmediate(() => options.onLine({ stream: 'stdout', line: 'HSTACK_QA_BROWSER={"port":40201,"debuggerPath":"/devtools/browser/owned","pid":12,"proxyPort":40202}' }));
        return worker;
      }
      forwards++;
      return { completion: new Promise(resolve => { dropForward = resolve; }) };
    },
    stopProcess: async () => dropForward({ code: 0 }),
    fetchImpl: async () => {
      if (forwards > 1) resolveReused();
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: `ws://localhost/devtools/browser/${forwards === 1 ? 'owned' : 'foreign'}` }) };
    },
    WebSocketImpl: class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: '{"id":1,"result":{"product":"fixture"}}' }))); }
      close() {}
    },
  }).then(() => null, error => error);
  try {
    await ready;
    dropForward({ code: 255 });
    await new Promise(setImmediate);
    t.mock.timers.tick(5_000);
    await reused;
    await new Promise(setImmediate);
  } finally {
    signals.emit('SIGINT');
  }
  assert.equal((await result)?.code, 'qa-browser-custody-lost');
});

test('a terminated launcher suspends cleanup and refuses a stale attach after its public port is reused', async t => {
  let reusePort;
  let beginCleanup, finishCleanup;
  const cleanupStarted = new Promise(resolve => { beginCleanup = resolve; });
  const cleanupAllowed = new Promise(resolve => { finishCleanup = resolve; });
  const listen = net.Server.prototype.listen;
  // The OS may hand the released ephemeral port to the next launcher.
  t.mock.method(net.Server.prototype, 'listen', function (...args) {
    if (args[0] === 0 && reusePort) {
      args[0] = reusePort;
      reusePort = undefined;
    }
    return listen.apply(this, args);
  });
  async function launch(browserId, holdCleanup = false) {
    const signals = new EventEmitter();
    let finishWorker, finishForward, resolveReady, forwardServer;
    const worker = { stdin: new PassThrough(), completion: new Promise(resolve => { finishWorker = resolve; }) };
    worker.stdin.on('data', () => finishWorker({ code: 0 }));
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const result = runQaBrowserSession({
      target: { name: 'fixture', platform: 'posix', ssh: 'fixture', repoDir: '/mirror', cliHomeDir: '/fixture' },
      stackName: 'fixture', stackBaseDir: '/fixture', sessionName: `custody-${browserId}`, url: 'http://localhost:3025',
      onReady: resolveReady,
    }, {
      signalSource: signals,
      capture: async (command, args) => captureDevTargetSyncFixture(command, args)
        ?? { ok: true, exitCode: 0, out: '', err: '' },
      spawnProcess(label, _command, args, _env, options) {
        if (!label.startsWith('browser-forward:')) {
          setImmediate(() => options.onLine({ stream: 'stdout', line: `HSTACK_QA_BROWSER=${JSON.stringify({ port: 40201, debuggerPath: `/devtools/browser/${browserId}`, pid: 12, proxyPort: 40202 })}` }));
          return worker;
        }
        const binding = args[args.indexOf('-L') + 1];
        const port = Number(binding.split(':')[1]);
        forwardServer = createServer((request, response) => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(request.url === '/json/list' ? [] : { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${browserId}` }));
        });
        forwardServer.listen(port, '127.0.0.1');
        return { completion: new Promise(resolve => { finishForward = resolve; }) };
      },
      stopProcess: async () => {
        if (holdCleanup) { beginCleanup(); await cleanupAllowed; }
        if (forwardServer) await new Promise(resolve => forwardServer.close(resolve));
        finishForward?.({ code: 0 });
      },
      WebSocketImpl: class extends EventTarget {
        constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        send() { queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: '{"id":1,"result":{"product":"fixture"}}' }))); }
        close() {}
      },
    }).then(() => null, error => error);
    t.after(async () => { finishCleanup(); signals.emit('SIGINT'); await result; });
    return { ready: await ready, terminate: () => finishWorker({ code: 0 }), result };
  }
  const first = await launch('first', true);
  assert.ok(new URL(first.ready.cdpHttpUrl).pathname.startsWith('/browser/'));
  const signin = await runQaBrowserSigninPage({ cdpHttpUrl: first.ready.cdpHttpUrl, key: randomBytes(32).toString('base64url'),
    urls: { uiUrl: 'http://127.0.0.1:3025', canonicalServerUrl: 'http://127.0.0.1:3005' } });
  assert.deepEqual(signin, { ok: false, reason: 'session_unavailable' }, 'fresh start handle must reach sign-in page selection');
  first.terminate();
  await cleanupStarted;
  try {
    assert.equal((await fetch(`${first.ready.cdpHttpUrl}/json/version`)).status, 503,
      'worker termination must suspend discovery before process cleanup finishes');
  } finally { finishCleanup(); }
  assert.equal((await first.result)?.code, 'qa-browser-worker-exited');
  reusePort = Number(new URL(first.ready.cdpHttpUrl).port);
  const second = await launch('second');
  assert.equal(new URL(second.ready.cdpHttpUrl).port, new URL(first.ready.cdpHttpUrl).port);
  const stale = await fetch(`${first.ready.cdpHttpUrl}/json/version`);
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { ok: false, reason: 'qa-browser-custody-lost' });
  const version = await (await fetch(`${second.ready.cdpHttpUrl}/json/version`)).json();
  assert.equal(version.webSocketDebuggerUrl, second.ready.cdpUrl);
});
