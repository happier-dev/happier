import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { run, runCapture } from '../proc/proc.mjs';
import { preferStackLocalhostUrl } from '../paths/localhost_host.mjs';
import { guidedStackWebSignupThenLogin } from './guided_stack_web_login.mjs';
import { getComponentDir, resolveStackEnvPath } from '../paths/paths.mjs';
import { getExpoStatePaths, isStateProcessRunning, looksLikeExpoMetro } from '../expo/expo.mjs';
import { resolveLocalhostHost } from '../paths/localhost_host.mjs';
import { getStackRuntimeStatePath, isPidAlive, readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { readEnvObjectFromFile } from '../env/read.mjs';
import { resolveServerUrls } from '../server/urls.mjs';

function extractEnvVar(cmd, key) {
  const re = new RegExp(`${key}="([^"]+)"`);
  const m = String(cmd ?? '').match(re);
  return m?.[1] ? String(m[1]) : '';
}

async function resolveRuntimeExpoWebappUrlForAuth({ stackName }) {
  try {
    const runtimeStatePath = getStackRuntimeStatePath(stackName);
    const st = await readStackRuntimeStateFile(runtimeStatePath);
    const ownerPid = Number(st?.ownerPid);
    if (!isPidAlive(ownerPid)) return '';
    const expoPid = Number(st?.processes?.expoPid);
    if (Number.isFinite(expoPid) && expoPid > 1 && !isPidAlive(expoPid)) return '';
    const port = Number(st?.expo?.port ?? st?.expo?.webPort ?? st?.expo?.mobilePort);
    if (!Number.isFinite(port) || port <= 0) return '';
    const live = await looksLikeExpoMetro({ port, timeoutMs: 900 });
    if (!live) return '';
    const host = resolveLocalhostHost({ stackMode: true, stackName });
    return `http://${host}:${port}`;
  } catch {
    return '';
  }
}

async function resolveExpoWebappUrlForAuth({ rootDir, stackName, timeoutMs }) {
  const baseDir = resolveStackEnvPath(stackName).baseDir;
  void rootDir; // kept for API stability; url resolution is stack-dir based

  // IMPORTANT:
  // In PR stacks (and especially in sandbox), the UI directory is typically a worktree path.
  // Expo state paths include a hash derived from projectDir, so we cannot assume a stable uiDir
  // here (e.g. the default checkout). Instead, scan the stack's expo-dev state directory and pick
  // the running Expo instance.
  const expoDevRoot = join(baseDir, 'expo-dev');

  async function resolveExpectedUiDir() {
    try {
      const { envPath } = resolveStackEnvPath(stackName);
      const stackEnv = await readEnvObjectFromFile(envPath);
      const merged = { ...process.env, ...stackEnv };
      return resolve(getComponentDir(rootDir, 'happier-ui', merged));
    } catch {
      return '';
    }
  }

  async function findRunningExpoStateUrl() {
    if (!existsSync(expoDevRoot)) return '';
    let entries = [];
    try {
      entries = await readdir(expoDevRoot, { withFileTypes: true });
    } catch {
      return '';
    }

    const expectedUiDir = await resolveExpectedUiDir();
    const expectedUiDirResolved = expectedUiDir ? resolve(expectedUiDir) : '';

    let best = null;
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const statePath = join(expoDevRoot, ent.name, 'expo.state.json');
      if (!existsSync(statePath)) continue;
      // eslint-disable-next-line no-await-in-loop
      const running = await isStateProcessRunning(statePath);
      if (!running.running) continue;

      // If the state includes capabilities, require web for auth (dev-client-only isn't enough).
      const hasCaps = running.state && typeof running.state === 'object' && 'webEnabled' in running.state;
      const webEnabled = hasCaps ? Boolean(running.state?.webEnabled) : true;
      if (!webEnabled) continue;

      // Tighten: if the stack env specifies an explicit UI directory, only accept Expo state that
      // matches it. This avoids accidentally selecting stale Expo state left under this stack dir.
      if (expectedUiDirResolved) {
        const uiDirRaw = String(running.state?.uiDir ?? '').trim();
        if (!uiDirRaw) continue;
        if (resolve(uiDirRaw) !== expectedUiDirResolved) continue;
      }

      const port = Number(running.state?.port);
      if (!Number.isFinite(port) || port <= 0) continue;

      // If we're only considering this "running" because the port is occupied (pid not alive),
      // do a quick Metro probe so we don't accept an unrelated process reusing the port.
      // Note: `isStateProcessRunning` already verifies Metro /status for port-only cases.

      // Prefer newest (startedAt) and prefer real pid-verified instances.
      const startedAtMs = Date.parse(String(running.state?.startedAt ?? '')) || 0;
      const score = (running.reason === 'pid' ? 1_000_000_000 : 0) + startedAtMs;
      if (!best || score > best.score) {
        best = { port, score };
      }
    }

    if (!best) return '';
    const host = resolveLocalhostHost({ stackMode: stackName !== 'main', stackName });
    return `http://${host}:${best.port}`;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const url = await findRunningExpoStateUrl();
    if (url) return url;
    // eslint-disable-next-line no-await-in-loop
    await delay(200);
  }
  return '';
}

async function fetchText(url, { timeoutMs = 2000 } = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller?.signal });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text, headers: res.headers };
  } catch (e) {
    return { ok: false, status: 0, text: String(e?.message ?? e), headers: null };
  } finally {
    clearTimeout(timeout);
  }
}

function pickHtmlBundlePath(html) {
  const m = String(html ?? '').match(/<script[^>]+src="([^"]+)"[^>]*><\/script>/i);
  return m?.[1] ? String(m[1]) : '';
}

export function parseExpoBundleErrorPayload(payload) {
  try {
    const parsed = JSON.parse(String(payload ?? ''));
    const type = String(parsed?.type ?? '').trim();
    const message = String(parsed?.message ?? '').trim();
    if (!type && !message) return null;
    const isResolverError = type === 'UnableToResolveError' || message.includes('Unable to resolve module');
    return { type, message, isResolverError };
  } catch {
    return null;
  }
}

async function detectSymlinkedNodeModules({ worktreeDir }) {
  try {
    const p = join(worktreeDir, 'node_modules');
    const st = await stat(p);
    return Boolean(st.isSymbolicLink && st.isSymbolicLink());
  } catch {
    return false;
  }
}

export async function assertExpoWebappBundlesOrThrow({ rootDir, stackName, webappUrl }) {
  const u = new URL(webappUrl);
  const port = u.port ? Number(u.port) : null;
  const probeHost = Number.isFinite(port) ? '127.0.0.1' : u.hostname;
  const base = `${u.protocol}//${probeHost}${u.port ? `:${u.port}` : ''}`;

  // Retry briefly: Metro can be up while the first bundle compile is still warming.
  const deadline = Date.now() + 60_000;
  let lastError = '';
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const htmlRes = await fetchText(`${base}/`, { timeoutMs: 2500 });
    if (!htmlRes.ok) {
      lastError = `HTTP ${htmlRes.status} loading ${base}/`;
      // eslint-disable-next-line no-await-in-loop
      await delay(500);
      continue;
    }

    const bundlePath = pickHtmlBundlePath(htmlRes.text);
    if (!bundlePath) {
      lastError = `could not find bundle <script src> in ${base}/`;
      // eslint-disable-next-line no-await-in-loop
      await delay(500);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const bundleRes = await fetchText(`${base}${bundlePath.startsWith('/') ? '' : '/'}${bundlePath}`, { timeoutMs: 8000 });
    if (bundleRes.ok) {
      return;
    }

    // Metro resolver errors are deterministic: surface immediately with actionable hints.
    const bundleError = parseExpoBundleErrorPayload(bundleRes.text);
    if (bundleError?.isResolverError) {
      let hint = '';
      try {
        const { envPath } = resolveStackEnvPath(stackName);
        const stackEnv = await readEnvObjectFromFile(envPath);
        const uiDir = getComponentDir(rootDir, 'happier-ui', { ...process.env, ...stackEnv });
        const symlinked = uiDir ? await detectSymlinkedNodeModules({ worktreeDir: uiDir }) : false;
        if (symlinked) {
          hint =
            '\n' +
            '[auth] Hint: this looks like an Expo/Metro resolution failure with symlinked node_modules.\n' +
            '[auth] Fix: re-run review-pr/setup-pr with `--deps=install` (avoid linking node_modules for happy).\n';
        }
      } catch {
        // ignore
      }
      throw new Error(
        '[auth] Expo web UI is running, but the web bundle failed to build.\n' +
          `[auth] URL: ${webappUrl}\n` +
          `[auth] Error: ${bundleError.message || bundleError.type || `HTTP ${bundleRes.status}`}\n` +
          hint
      );
    }

    lastError = `HTTP ${bundleRes.status} loading bundle ${bundlePath}`;
    // eslint-disable-next-line no-await-in-loop
    await delay(500);
  }

  if (lastError) {
    throw new Error(
      '[auth] Expo web UI did not become ready for guided login (bundle not loadable).\n' +
        `[auth] URL: ${webappUrl}\n` +
        `[auth] Last error: ${lastError}\n` +
        '[auth] Tip: re-run with --verbose to see Expo logs (or open the stack runner log file).'
    );
  }
}

export async function resolveStackWebappUrlForAuth({ rootDir, stackName, env = process.env }) {
  // Fast path: runtime Expo metadata is a hint, but only accepted when liveness checks pass.
  const runtimeExpoUrl = await resolveRuntimeExpoWebappUrlForAuth({ stackName });
  if (runtimeExpoUrl) {
    return await preferStackLocalhostUrl(runtimeExpoUrl, { stackName });
  }

  const authFlow =
    (env.HAPPIER_STACK_AUTH_FLOW ?? '').toString().trim() === '1' ||
    (env.HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH ?? '').toString().trim() === '1';

  // Prefer the Expo web UI URL when running in dev mode.
  // This is crucial for guided login: the browser needs the UI origin, not the server port.
  const timeoutMsRaw =
    (env.HAPPIER_STACK_AUTH_UI_READY_TIMEOUT_MS ?? '180000').toString().trim();
  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 180_000;
  const expoUrl = await resolveExpoWebappUrlForAuth({
    rootDir,
    stackName,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000,
  });
  if (expoUrl) {
    return await preferStackLocalhostUrl(expoUrl, { stackName });
  }

  // Fail closed for guided auth flows: falling back to server URLs opens the wrong origin.
  if (authFlow) {
    throw new Error(
      `[auth] failed to resolve Expo web UI URL for guided login.\n` +
        `[auth] Reason: Expo web UI did not become ready within ${Number.isFinite(timeoutMs) ? timeoutMs : 180_000}ms.\n` +
        `[auth] Fix: re-run and wait for Expo to start, or run in prod mode (--start) if you want server-served UI.`
    );
  }

  try {
    const raw = await runCapture(
      process.execPath,
      [join(rootDir, 'scripts', 'stack.mjs'), 'auth', stackName, '--', 'login', '--print', '--json'],
      {
        cwd: rootDir,
        env,
      }
    );
    const parsed = JSON.parse(String(raw ?? '').trim());
    const cmd = typeof parsed?.cmd === 'string' ? parsed.cmd : '';
    const url = extractEnvVar(cmd, 'HAPPIER_WEBAPP_URL');
    return url ? await preferStackLocalhostUrl(url, { stackName }) : '';
  } catch {
    return '';
  }
}

function resolvePortFromUrl(urlRaw) {
  const raw = String(urlRaw ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!parsed.port) return null;
    const n = Number(parsed.port);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function resolveServerPortForCoreAuth({ stackName, env = process.env }) {
  const direct = Number((env.HAPPIER_STACK_SERVER_PORT ?? '').toString().trim());
  if (Number.isFinite(direct) && direct > 0) return direct;

  const fromInternal = resolvePortFromUrl(env.HAPPIER_SERVER_URL);
  if (fromInternal) return fromInternal;

  const fromPublic = resolvePortFromUrl(env.HAPPIER_PUBLIC_SERVER_URL);
  if (fromPublic) return fromPublic;

  try {
    const runtimeStatePath = getStackRuntimeStatePath(stackName);
    const st = await readStackRuntimeStateFile(runtimeStatePath);
    const runtimePort = Number(st?.ports?.server);
    if (Number.isFinite(runtimePort) && runtimePort > 0) return runtimePort;
  } catch {
    // ignore
  }

  return null;
}

async function prepareCoreAuthEnv({ stackName, webappUrl, env = process.env } = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const merged = { ...process.env, ...(env ?? {}) };
  const { baseDir } = resolveStackEnvPath(name, merged);

  const serverPort = await resolveServerPortForCoreAuth({ stackName: name, env: merged });
  if (!serverPort) {
    throw new Error('[auth] cannot run stack login: unable to resolve stack server port');
  }

  const internalServerUrl = String(merged.HAPPIER_SERVER_URL ?? '').trim() || `http://127.0.0.1:${serverPort}`;
  const resolvedPublic = await resolveServerUrls({
    env: merged,
    serverPort,
    allowEnable: false,
  });
  const publicServerUrl =
    String(merged.HAPPIER_PUBLIC_SERVER_URL ?? '').trim() || String(resolvedPublic.publicServerUrl ?? '').trim();
  if (!publicServerUrl) {
    throw new Error('[auth] cannot run stack login: unable to resolve public server URL');
  }

  const cliHomeDir =
    String(merged.HAPPIER_HOME_DIR ?? '').trim() ||
    String(merged.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim() ||
    join(baseDir, 'cli');

  return {
    ...merged,
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_SERVER_URL: internalServerUrl,
    HAPPIER_PUBLIC_SERVER_URL: publicServerUrl,
    HAPPIER_WEBAPP_URL: webappUrl,
  };
}

export function buildStackAuthLoginInvocation({ rootDir, stackName, webappUrl, env = process.env } = {}) {
  const root = String(rootDir ?? '').trim();
  if (!root) {
    throw new Error('[auth] buildStackAuthLoginInvocation requires rootDir');
  }
  const url = String(webappUrl ?? '').trim();
  if (!url) {
    throw new Error('[auth] buildStackAuthLoginInvocation requires a webappUrl');
  }
  const cliBin = join(getComponentDir(root, 'happier-cli', env), 'bin', 'happier.mjs');
  const merged = { ...(env ?? process.env), HAPPIER_WEBAPP_URL: url };
  const method = String(merged.HAPPIER_AUTH_METHOD ?? '').trim().toLowerCase();
  if (method && method !== 'web' && method !== 'browser' && method !== 'mobile') {
    throw new Error(`[auth] invalid HAPPIER_AUTH_METHOD=${method} (expected: web|browser|mobile)`);
  }
  const normalizedMethod = method === 'browser' ? 'web' : method;

  const args = [cliBin, 'auth', 'login'];
  if (String(merged.HAPPIER_AUTH_FORCE ?? '').trim() === '1') {
    args.push('--force');
  }
  if (String(merged.HAPPIER_NO_BROWSER_OPEN ?? '').trim() === '1') {
    args.push('--no-open');
  }
  if (normalizedMethod) {
    args.push('--method', normalizedMethod);
  }

  return {
    args,
    env: merged,
  };
}

export async function guidedStackAuthLoginNow({ rootDir, stackName, env = process.env, webappUrl = null }) {
  const name = String(stackName ?? '').trim() || 'main';
  const resolved = (webappUrl ?? '').toString().trim() || (await resolveStackWebappUrlForAuth({ rootDir, stackName: name, env }));
  if (!resolved) {
    throw new Error('[auth] cannot start guided login: web UI URL is empty');
  }

  const skipBundleCheck = (env.HAPPIER_STACK_AUTH_SKIP_BUNDLE_CHECK ?? '').toString().trim() === '1';
  // Surface common "blank page" issues (Metro resolver errors) even in quiet mode.
  if (!skipBundleCheck) {
    await assertExpoWebappBundlesOrThrow({ rootDir, stackName: name, webappUrl: resolved });
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (interactive) {
    await guidedStackWebSignupThenLogin({ webappUrl: resolved, stackName: name });
  }

  const preparedEnv = await prepareCoreAuthEnv({ stackName: name, webappUrl: resolved, env });
  const inv = buildStackAuthLoginInvocation({ rootDir, stackName: name, webappUrl: resolved, env: preparedEnv });
  await run(process.execPath, inv.args, { cwd: rootDir, env: inv.env });
}

export async function stackAuthCopyFrom({ rootDir, stackName, fromStackName, env = process.env, link = true }) {
  await run(
    process.execPath,
    [
      join(rootDir, 'scripts', 'stack.mjs'),
      'auth',
      stackName,
      '--',
      'copy-from',
      fromStackName,
      ...(link ? ['--link'] : []),
    ],
    { cwd: rootDir, env }
  );
}
