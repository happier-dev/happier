import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { run, runCapture } from '../proc/proc.mjs';
import { preferStackLocalhostUrl } from '../paths/localhost_host.mjs';
import { guidedStackWebSignupThenLogin } from './guided_stack_web_login.mjs';
import { resolveStackEnvPath, getWorkspaceDir } from '../paths/paths.mjs';
import { getExpoStatePaths, isStateProcessRunning } from '../expo/expo.mjs';
import { resolveLocalhostHost } from '../paths/localhost_host.mjs';
import { getStackRuntimeStatePath, isPidAlive, readStackRuntimeStateFile } from '../stack/runtime_state.mjs';
import { readEnvObjectFromFile } from '../env/read.mjs';
import { expandHome } from '../paths/canonical_home.mjs';

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
    const port = Number(st?.expo?.port ?? st?.expo?.webPort ?? st?.expo?.mobilePort);
    if (!Number.isFinite(port) || port <= 0) return '';
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
  // here (e.g. `components/happy`). Instead, scan the stack's expo-dev state directory and pick
  // the running Expo instance.
  const expoDevRoot = join(baseDir, 'expo-dev');

  async function resolveExpectedUiDir() {
    try {
      const { envPath } = resolveStackEnvPath(stackName);
      const stackEnv = await readEnvObjectFromFile(envPath);
      const raw = (stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY ?? stackEnv.HAPPY_LOCAL_COMPONENT_DIR_HAPPY ?? '').trim();
      if (!raw) return '';

      const expanded = expandHome(raw);
      if (expanded.startsWith('/')) return resolve(expanded);

      const wsRaw = (stackEnv.HAPPY_STACKS_WORKSPACE_DIR ?? stackEnv.HAPPY_LOCAL_WORKSPACE_DIR ?? '').trim();
      const wsExpanded = wsRaw ? expandHome(wsRaw) : '';
      const workspaceDir = wsExpanded ? (wsExpanded.startsWith('/') ? wsExpanded : resolve(getWorkspaceDir(rootDir), wsExpanded)) : getWorkspaceDir(rootDir);
      return resolve(workspaceDir, expanded);
    } catch {
      return '';
    }
  }

  async function looksLikeExpoMetro({ port }) {
    const p = Number(port);
    if (!Number.isFinite(p) || p <= 0) return false;

    // Metro exposes `/status` which returns "packager-status:running".
    const url = `http://127.0.0.1:${p}/status`;
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeout = setTimeout(() => controller?.abort(), 800);
      try {
        const res = await fetch(url, { signal: controller?.signal });
        const txt = await res.text().catch(() => '');
        return res.ok && String(txt).toLowerCase().includes('packager-status:running');
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
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
      if (running.reason === 'port') {
        // eslint-disable-next-line no-await-in-loop
        const ok = await looksLikeExpoMetro({ port });
        if (!ok) continue;
      }

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
    try {
      const parsed = JSON.parse(String(bundleRes.text ?? ''));
      const type = String(parsed?.type ?? '').trim();
      const msg = String(parsed?.message ?? '').trim();
      if (type === 'UnableToResolveError' || msg.includes('Unable to resolve module')) {
        let hint = '';
        try {
          const { envPath } = resolveStackEnvPath(stackName);
          const stackEnv = await readEnvObjectFromFile(envPath);
          const uiDir = (stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY ?? stackEnv.HAPPY_LOCAL_COMPONENT_DIR_HAPPY ?? '').trim();
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
            `[auth] Error: ${msg || type || `HTTP ${bundleRes.status}`}\n` +
            hint
        );
      }
    } catch {
      // not JSON / not a known error
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
  // Fast path: if the stack runner already recorded Expo webPort in stack.runtime.json,
  // use it immediately (runtime state is authoritative).
  const runtimeExpoUrl = await resolveRuntimeExpoWebappUrlForAuth({ stackName });
  if (runtimeExpoUrl) {
    return await preferStackLocalhostUrl(runtimeExpoUrl, { stackName });
  }

  const authFlow =
    (env.HAPPY_STACKS_AUTH_FLOW ?? env.HAPPY_LOCAL_AUTH_FLOW ?? '').toString().trim() === '1' ||
    (env.HAPPY_STACKS_DAEMON_WAIT_FOR_AUTH ?? env.HAPPY_LOCAL_DAEMON_WAIT_FOR_AUTH ?? '').toString().trim() === '1';

  // Prefer the Expo web UI URL when running in dev mode.
  // This is crucial for guided login: the browser needs the UI origin, not the server port.
  const timeoutMsRaw =
    (env.HAPPY_STACKS_AUTH_UI_READY_TIMEOUT_MS ?? env.HAPPY_LOCAL_AUTH_UI_READY_TIMEOUT_MS ?? '180000').toString().trim();
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
    const url = extractEnvVar(cmd, 'HAPPY_WEBAPP_URL');
    return url ? await preferStackLocalhostUrl(url, { stackName }) : '';
  } catch {
    return '';
  }
}

export async function guidedStackAuthLoginNow({ rootDir, stackName, env = process.env, webappUrl = null }) {
  const resolved = (webappUrl ?? '').toString().trim() || (await resolveStackWebappUrlForAuth({ rootDir, stackName, env }));
  if (!resolved) {
    throw new Error('[auth] cannot start guided login: web UI URL is empty');
  }

  const skipBundleCheck = (env.HAPPY_STACKS_AUTH_SKIP_BUNDLE_CHECK ?? env.HAPPY_LOCAL_AUTH_SKIP_BUNDLE_CHECK ?? '').toString().trim() === '1';
  // Surface common "blank page" issues (Metro resolver errors) even in quiet mode.
  if (!skipBundleCheck) {
    await assertExpoWebappBundlesOrThrow({ rootDir, stackName, webappUrl: resolved });
  }

  await guidedStackWebSignupThenLogin({ webappUrl: resolved, stackName });
  await run(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), 'auth', stackName, '--', 'login'], {
    cwd: rootDir,
    env,
  });
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

