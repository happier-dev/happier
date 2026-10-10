import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { runCaptureResult, spawnProc, killProcessTree } from '../proc/proc.mjs';
import { runDevTargetCommand } from './executor.mjs';
import { resolveDevTargetSshConfigFile } from './mutagen_runtime.mjs';
import { buildRemoteQaBrowserStopCommand, buildSshForwardArgs, buildSshWorkerArgs, resolveRemoteStackStatePaths } from './remote_commands.mjs';
import { loadControlledRuntimeConfig } from './service_placement.mjs';
import { killPidOwnedByStack, listPsPidsForEnvQueries, observePsEnvLine } from '../proc/ownership.mjs';
import { resolveExplicitStackEnvFilePath } from '../paths/paths.mjs';

const READY_MARKER = 'HSTACK_QA_BROWSER=';
// Chromium's PointerType::kPointerFineType=4 and HoverType::kHoverHoverType=2:
// third_party/blink/public/mojom/webpreferences/web_preferences.mojom.
const DESKTOP_BLINK_SETTINGS = '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';

async function readQaBrowserEndpoint(profile) {
  const [portText, debuggerPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !debuggerPath?.startsWith('/devtools/browser/')) {
    throw new Error('[dev-targets] browser did not expose a valid loopback CDP endpoint');
  }
  return { port, debuggerPath };
}

async function readQaBrowserExecutable(profile, signal) {
  const { port, debuggerPath } = await readQaBrowserEndpoint(profile);
  const socket = new WebSocket(`ws://127.0.0.1:${port}${debuggerPath}`);
  let abort;
  try {
    return await new Promise((resolveExecutable, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.getBrowserCommandLine' })), { once: true });
      socket.addEventListener('error', () => reject(new Error('[dev-targets] browser executable discovery CDP connection failed')), { once: true });
      socket.addEventListener('close', () => reject(new Error('[dev-targets] browser executable discovery CDP connection closed')), { once: true });
      socket.addEventListener('message', event => {
        try {
          const response = JSON.parse(event.data);
          if (response.id !== 1) return;
          const executable = response.result?.arguments?.[0];
          if (response.error || typeof executable !== 'string' || !isAbsolute(executable)) {
            throw new Error('[dev-targets] browser did not report its executable through CDP');
          }
          resolveExecutable(executable);
        } catch (error) { reject(error); }
      });
    });
  } finally {
    signal.removeEventListener('abort', abort);
    socket.close();
  }
}

async function cleanupQaBrowserProfile({ session, profile, env = process.env }, { capture = runCaptureResult } = {}) {
  const profilePath = resolve(profile);
  if (dirname(profilePath) !== resolve(tmpdir()) || !/^hstack-qa-browser-[a-zA-Z0-9]+$/.test(basename(profilePath))) {
    throw new Error('[dev-targets] browser cleanup requires its named temporary QA profile');
  }
  if (session) {
    requireSessionName(session);
    const result = await capture('agent-browser', ['--session', session, 'close'], {
      env: { ...env, AGENT_BROWSER_SESSION: session, AGENT_BROWSER_RESTORE_SAVE: 'never' },
    });
    if (!result.ok) throw new Error(`[dev-targets] QA browser cleanup failed; profile retained at ${profilePath}: ${result.err || result.exitCode}`);
  }
  await rm(profilePath, { recursive: true, force: true });
}

function requireSessionName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name ?? '')) throw new Error('[dev-targets] browser requires a simple lane session name');
  return name;
}

async function unusedPort() {
  return (await unusedPorts(1))[0];
}

async function unusedPorts(count) {
  const listeners = [];
  try {
    for (let index = 0; index < count; index++) {
      const listener = net.createServer();
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
      listeners.push(listener);
    }
    return listeners.map(listener => listener.address().port);
  } finally {
    await Promise.all(listeners.map(listener => new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))));
  }
}

// Home authentication adopts the canonical address advertised by the server.
// Preserve addresses, not just hostnames: temporary-port aliases stop working
// as soon as the authenticated Home descriptor replaces the entered address.
export function resolveQaBrowserUrl(url, extraUrls = []) {
  const page = new URL(url);
  const urls = [page, ...extraUrls.map(value => new URL(value))];
  for (const key of ['server', 'serverUrl']) {
    const value = page.searchParams.get(key);
    if (value) urls.push(new URL(value));
  }
  for (const endpoint of urls) {
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error('[dev-targets] browser routes require HTTP(S) URLs without credentials');
    }
  }
  return url;
}

export async function runQaBrowserWorker({ sessionName, proxy = false, trustSpki = '', input = process.stdin, env = process.env,
  writeReady = value => process.stdout.write(`${READY_MARKER}${JSON.stringify(value)}\n`),
}, { capture = runCaptureResult, signalSource = process } = {}) {
  requireSessionName(sessionName);
  const profile = await mkdtemp(join(tmpdir(), 'hstack-qa-browser-'));
  const session = `hstack-${sessionName}-${randomUUID()}`;
  const browserEnv = { ...env, AGENT_BROWSER_SESSION: session, AGENT_BROWSER_RESTORE_SAVE: 'never',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' };
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  // agent-browser detaches Chromium; signal listeners and an unresolved Promise
  // alone do not keep Node alive. This timer only holds the worker event loop;
  // it is neither a browser timeout nor a polling policy.
  const lifetime = setInterval(() => {}, 2_147_483_647);
  const lifetimeAbort = new AbortController();
  const close = () => { resolveClosed(); lifetimeAbort.abort(); };
  const control = createInterface({ input });
  control.on('line', line => { if (line === 'close') close(); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signalSource.on(signal, close);
  let opened = false;
  try {
    const proxyPort = proxy ? await unusedPort() : null;
    // OpenSSH's reverse SOCKS route resolves destinations on the controller,
    // where the canonical Stack/Expo ingress already lives. Chromium must also
    // proxy loopback addresses; its default bypass would reach the worker instead.
    const launchArgs = ['--remote-debugging-port=0', '--no-sandbox',
      ...(trustSpki ? [`--ignore-certificate-errors-spki-list=${trustSpki}`] : []), ...(proxy ? [
      `--proxy-server=socks5://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>',
    ] : [])];
    opened = true; // A failed open can still have created its own daemon.
    // agent-browser 0.34's --args parser splits commas even inside a switch.
    // Let its canonical detector select Chromium, observe that executable via
    // public CDP, then append the intact Blink switch at the executable boundary.
    // Both launches stay in this worker's owned profile and cleanup lifecycle.
    const discovery = await capture('agent-browser', ['--session', session, '--profile', profile,
      '--args', [...launchArgs, '--enable-automation'].join(','), 'open', 'about:blank'], { env: browserEnv });
    if (!discovery.ok) throw new Error(`[dev-targets] QA browser launch failed: ${discovery.err || discovery.error?.message || discovery.exitCode}`);
    if (lifetimeAbort.signal.aborted) return;
    let executable;
    try { executable = await readQaBrowserExecutable(profile, lifetimeAbort.signal); }
    catch (error) { if (lifetimeAbort.signal.aborted) return; throw error; }
    const discoveryClose = await capture('agent-browser', ['--session', session, 'close'], { env: browserEnv });
    if (!discoveryClose.ok) throw new Error(`[dev-targets] QA browser executable discovery cleanup failed: ${discoveryClose.err || discoveryClose.exitCode}`);
    opened = false;
    if (lifetimeAbort.signal.aborted) return;
    const wrapper = join(profile, 'chromium-desktop');
    const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
    await writeFile(wrapper, `#!/bin/sh\nexec ${quote(executable)} "$@" ${quote(DESKTOP_BLINK_SETTINGS)}\n`, { mode: 0o700 });
    if (lifetimeAbort.signal.aborted) return;
    opened = true;
    const launch = await capture('agent-browser', ['--session', session, '--profile', profile,
      '--executable-path', wrapper, '--args', launchArgs.join(','), 'open', 'about:blank'], { env: browserEnv });
    if (!launch.ok) throw new Error(`[dev-targets] QA browser launch failed: ${launch.err || launch.error?.message || launch.exitCode}`);
    const { port, debuggerPath } = await readQaBrowserEndpoint(profile);
    writeReady({ port, debuggerPath, profile, session, pid: process.pid, proxyPort });
    await closed;
  } finally {
    clearInterval(lifetime);
    control.close();
    input.pause();
    try {
      await cleanupQaBrowserProfile({ session: opened ? session : null, profile, env: browserEnv }, { capture });
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) signalSource.off(signal, close);
    }
  }
}

/** Retire only browsers carrying this Stack's exact existing ownership bindings. */
export async function stopQaBrowsers({ stackName, envPath }) {
  requireSessionName(stackName);
  if (!envPath) throw new Error('[dev-targets] browser retirement requires the Stack env path');
  const inventory = async () => (await listPsPidsForEnvQueries([{ needles: [
    `HAPPIER_STACK_STACK=${stackName}`, `HAPPIER_STACK_ENV_FILE=${envPath}`, 'HAPPIER_STACK_PROCESS_KIND=browser',
  ] }]))[0].filter(pid => pid !== process.pid);
  const pids = [];
  const stop = async (pid, worker) => {
    const result = await killPidOwnedByStack(pid, { stackName, envPath, json: true,
      signal: 'SIGTERM', ...(worker ? { graceMs: Infinity } : {}) });
    if (!result.killed) throw new Error(`[dev-targets] browser pid ${pid} cleanup unconfirmed: ${result.reason}`);
    pids.push(pid);
  };
  // The worker must close detached Chromium before any sweep can signal its
  // close subprocess. Wait for that lifecycle rather than adding a deadline.
  for (const pid of await inventory()) {
    const observed = await observePsEnvLine(pid);
    if (observed.status === 'ok' && /qa_browser\.mjs\s+--worker(?:\s|$)/.test(observed.line)) await stop(pid, true);
  }
  // Older orphaned browser/agent-browser processes can have lost their worker.
  // Re-enumerate after graceful close and use the same ownership/identity owner.
  for (const pid of await inventory()) await stop(pid, false);
  if ((await inventory()).length) throw new Error('[dev-targets] Stack browser cleanup is incomplete');
  return { stackName, pids };
}

export async function stopStackQaBrowsers({ stackName, baseDir, sourceDir, env }, { capture = runCaptureResult } = {}) {
  const local = await stopQaBrowsers({ stackName, envPath: resolveExplicitStackEnvFilePath(env) });
  if (env.HAPPIER_STACK_NO_DEV_TARGETS === '1') return { local, remote: [], warnings: [] };
  const loaded = await loadControlledRuntimeConfig({ stackName, sourceDir, initializeQaDaemonPlacement: false, env });
  // Browser placement is independent of service pins; a stopped Stack may
  // have browsers on any configured POSIX target and no runtime state at all.
  const targets = loaded.config.targets.filter(target => target.platform === 'posix');
  const results = await Promise.allSettled(targets.map(async target => {
    const sshConfig = resolveDevTargetSshConfigFile(target, { stackBaseDir: loaded.authority.producerStackBaseDir ?? baseDir, env });
    let result;
    try {
      result = await capture('ssh', buildSshWorkerArgs(target, { tty: false,
        sshArgs: [...(sshConfig ? ['-F', sshConfig] : []), '-o', 'ControlMaster=no', '-o', 'ControlPath=none'],
        remoteCommand: buildRemoteQaBrowserStopCommand(target, { stackName }),
      }), { env });
    } catch (error) {
      return { warning: { code: `browser_cleanup_unconfirmed:${target.name}`,
        error: error instanceof Error ? error.message : String(error) } };
    }
    // SSH transport loss cannot confirm disposable browser retirement, but it
    // must not prevent the reachable Stack resources from stopping.
    if (!result.ok && (result.exitCode === 255 || result.exitCode == null)) {
      return { warning: { code: `browser_cleanup_unconfirmed:${target.name}`,
        error: result.err || result.error?.message || 'browser cleanup transport unavailable' } };
    }
    if (!result.ok) throw new Error(`[dev-targets] ${target.name} browser cleanup failed: ${result.err || result.exitCode}`);
    let observed;
    try { observed = JSON.parse(result.out.trim()); } catch { /* Missing confirmation is not retirement. */ }
    if (observed?.stackName !== stackName || !Array.isArray(observed.pids)
      || !observed.pids.every(pid => Number.isSafeInteger(pid) && pid > 1)) {
      return { warning: { code: `browser_cleanup_unconfirmed:${target.name}`, error: 'invalid browser cleanup confirmation' } };
    }
    return { target: target.name, ...observed };
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason),
    failures.map(result => result.reason.message).join('; '));
  return { local, remote: results.filter(result => !result.value.warning).map(result => result.value),
    warnings: results.filter(result => result.value.warning).map(result => result.value.warning) };
}

export async function runQaBrowserSession({ target, stackName, stackBaseDir, sessionName, url, extraUrls = [], trustCertPath,
  env = process.env, onReady = value => process.stdout.write(`${JSON.stringify(value)}\n`),
}, { signalSource = process, capture = runCaptureResult, spawnProcess = spawnProc,
  stopProcess = child => killProcessTree(child, 'SIGINT', { graceMs: 2_000 }),
  fetchImpl = fetch,
} = {}) {
  requireSessionName(sessionName);
  if (!target || target.platform !== 'posix') throw new Error('[dev-targets] QA browser requires a selected remote POSIX host');
  url = resolveQaBrowserUrl(url, extraUrls);
  let trustSpki = '';
  if (trustCertPath !== undefined) {
    try {
      const certificate = new X509Certificate(await readFile(trustCertPath));
      trustSpki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    } catch {
      throw new Error('[dev-targets] browser --trust-cert requires a readable certificate file');
    }
  }
  const sshConfigFile = resolveDevTargetSshConfigFile(target, { stackBaseDir, env });
  const sshArgs = sshConfigFile ? ['-F', sshConfigFile] : [];
  const probe = await capture('ssh', buildSshWorkerArgs(target, { remoteCommand: 'true', tty: false,
    sshArgs }), { env });
  if (!probe.ok) throw new Error(`[dev-targets] QA browser host ${target.name} is unavailable; controller-local browser fallback is disabled`);
  const signalBus = new EventEmitter();
  const abort = new AbortController();
  const executionAbort = new AbortController();
  let worker;
  let closeRequested = false;
  let failure;
  const closeWorker = () => {
    if (!worker || closeRequested) return;
    closeRequested = true;
    // Keep custody's lifetime pipe open until the worker confirms cleanup by
    // exiting. Group cancellation would also kill agent-browser's close call.
    worker.stdin.write('close\n', error => {
      if (!error) return;
      failure ??= new Error(`[dev-targets] QA browser close request failed: ${error.message}`);
      executionAbort.abort();
    });
  };
  let cancelled = false;
  const signalListeners = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
    cancelled = true; abort.abort(); closeWorker();
  }]));
  for (const [signal, listener] of signalListeners) signalSource.on(signal, listener);
  let tunnel;
  let readiness;
  let readyTask;
  let lifecycleFinished = false;
  const paths = resolveRemoteStackStatePaths(target, { stackName, runtimeMode: 'controlled' });
  const workerEnv = { HAPPIER_STACK_STACK: stackName, HAPPIER_STACK_ENV_FILE: paths.stackEnvPath,
    HAPPIER_STACK_PROCESS_KIND: 'browser' };
  const onLine = ({ line }) => {
    if (!line.startsWith(READY_MARKER)) { process.stderr.write(`${line}\n`); return; }
    if (readyTask) return;
    readyTask = (async () => {
      const ready = JSON.parse(line.slice(READY_MARKER.length));
      if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535
        || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(ready.debuggerPath)) throw new Error('[dev-targets] malformed browser readiness');
      const localPort = await unusedPort();
      // This forward belongs to the lane browser, like its remote worker.
      // Inherited producer Stack markers must not make a Stack infra sweep
      // terminate an independently controlled QA browser session.
      tunnel = spawnProcess(`browser-forward:${sessionName}`, 'ssh', buildSshForwardArgs(target, {
        sshArgs,
        forwards: [{ direction: 'reverse-dynamic', listenHost: '127.0.0.1', listenPort: ready.proxyPort },
          { direction: 'local', listenPort: localPort, targetPort: ready.port }],
      }), { ...env, HAPPIER_STACK_PROCESS_KIND: 'browser' }, { silent: true, persistOutput: false });
      void tunnel.completion.then(() => {
        if (lifecycleFinished || cancelled) return;
        failure = new Error('[dev-targets] QA browser SSH forward exited');
        abort.abort(); closeWorker();
      });
      const signal = abort.signal;
      while (true) {
        signal.throwIfAborted();
        if (tunnel?.exitCode != null || tunnel?.signalCode != null) throw new Error('[dev-targets] QA browser SSH forward exited before readiness');
        try {
          const response = await fetchImpl(`http://127.0.0.1:${localPort}/json/version`, { signal });
          if (response.ok && (await response.json()).webSocketDebuggerUrl) break;
        } catch { /* Forward establishment is observed before declaring readiness. */ }
        await delay(100, undefined, { signal });
      }
      readiness = { stackName, sessionName, target: target.name, localFallback: false,
        cdpUrl: `ws://127.0.0.1:${localPort}${ready.debuggerPath}`, cdpHttpUrl: `http://127.0.0.1:${localPort}`,
        remotePid: ready.pid, profile: ready.profile,
        url };
      onReady(readiness);
    })().catch(error => { if (!cancelled) failure = error; closeWorker(); });
  };
  try {
    const args = ['./apps/stack/scripts/utils/dev_targets/qa_browser.mjs', '--worker', sessionName, 'remote'];
    if (trustSpki) args.push(trustSpki);
    if (cancelled) return;
    const result = await runDevTargetCommand({ target, stackBaseDir, commandArgs: ['node', ...args],
      environment: workerEnv, env, onLine, silent: true, controlStdin: true, signal: executionAbort.signal, workspacePreparation: 'skip', dependencyAdmission: 'skip', provenance: 'skip',
    }, { signalSource: signalBus,
      // Keep the remote executor real while sharing this owner's OS boundaries.
      runCaptureResult: ({ command, args, ...options }) => capture(command, args, options),
      spawnProcess: ({ label, command, args, env, tty, lifetimeStdin, onLine, silent }) => {
        worker = spawnProcess(label, command, args, env,
          { onLine, silent, ...(tty ? { stdio: 'inherit' } : lifetimeStdin
            // spawnProc already detaches this transport group. Its stdin
            // lifeline owns parent loss; foreground signal forwarding would
            // interrupt the graceful close request owned here.
            ? { stdio: ['pipe', 'pipe', 'pipe'] } : {}) });
        worker.stdin.on('error', error => {
          failure ??= new Error(`[dev-targets] QA browser control channel failed: ${error.message}`);
          executionAbort.abort();
        });
        if (cancelled || failure) closeWorker();
        return worker;
      },
      stopProcess,
    });
    if (failure) throw failure;
    if (result.code !== 0) throw new Error(`[dev-targets] remote QA browser worker failed (${result.code ?? result.signal})`);
    await readyTask;
    if (failure) throw failure;
    if (!cancelled && !readiness) throw new Error('[dev-targets] QA browser exited before CDP readiness');
  } finally {
    lifecycleFinished = true;
    abort.abort();
    for (const [signal, listener] of signalListeners) signalSource.off(signal, listener);
    if (tunnel) await stopProcess(tunnel);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--worker') {
  await runQaBrowserWorker({ sessionName: process.argv[3], proxy: process.argv[4] === 'remote', trustSpki: process.argv[5] });
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--cleanup') {
  requireSessionName(process.argv[3]);
  await cleanupQaBrowserProfile({ session: process.argv[3], profile: process.argv[4] });
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--stop-stack') {
  process.stdout.write(JSON.stringify(await stopQaBrowsers({ stackName: process.argv[3], envPath: process.argv[4] })) + '\n');
}
