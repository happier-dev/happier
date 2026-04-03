// @ts-check

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJsonFileBestEffort(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveRuntimeJsonPathFromEnv(env) {
  const explicitRuntimePath = String(env.HAPPIER_QA_STACK_RUNTIME_JSON_PATH ?? '').trim();
  if (explicitRuntimePath) return explicitRuntimePath;

  const stacksDir = String(env.HAPPIER_QA_STACKS_DIR ?? '').trim();
  const stackName = String(env.HAPPIER_QA_STACK_NAME ?? '').trim();
  if (stacksDir && stackName) {
    return join(stacksDir, stackName, 'stack.runtime.json');
  }

  if (!stacksDir) return '';

  // Auto-detect: pick the newest `stack.runtime.json` under the immediate stack folders.
  try {
    const dirents = readdirSync(stacksDir, { withFileTypes: true });
    let best = { path: '', updatedAtMs: 0 };
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const candidatePath = join(stacksDir, dirent.name, 'stack.runtime.json');
      const json = readJsonFileBestEffort(candidatePath);
      if (!json || typeof json !== 'object') continue;
      const updatedAtRaw = /** @type {any} */ (json).updatedAt;
      const updatedAtMs = typeof updatedAtRaw === 'string' ? Date.parse(updatedAtRaw) : 0;
      if (updatedAtMs > best.updatedAtMs) {
        best = { path: candidatePath, updatedAtMs };
      }
    }
    return best.path;
  } catch {
    return '';
  }
}

function readPortFromRuntimeJson(json, path) {
  // Supports both:
  // - { ports: { server }, expo: { webPort } }
  // - { runtime: { ports: { server }, expo: { webPort } } }
  const root = json && typeof json === 'object' ? /** @type {any} */ (json) : {};
  const fromRuntime = root.runtime && typeof root.runtime === 'object' ? root.runtime : null;
  const ports = (fromRuntime?.ports ?? root.ports) && typeof (fromRuntime?.ports ?? root.ports) === 'object'
    ? (fromRuntime?.ports ?? root.ports)
    : {};
  const expo = (fromRuntime?.expo ?? root.expo) && typeof (fromRuntime?.expo ?? root.expo) === 'object'
    ? (fromRuntime?.expo ?? root.expo)
    : {};
  const value = path === 'server' ? ports.server : expo.webPort;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function resolveQaUiUrl(env = process.env) {
  const runtimePath = resolveRuntimeJsonPathFromEnv(env);
  const json = runtimePath ? readJsonFileBestEffort(runtimePath) : null;
  if (!json) {
    throw new Error('[qa-ui-url] Unable to resolve stack.runtime.json (set HAPPIER_QA_STACK_RUNTIME_JSON_PATH or HAPPIER_QA_STACKS_DIR)');
  }

  const serverPort = readPortFromRuntimeJson(json, 'server');
  const webPort = readPortFromRuntimeJson(json, 'web');
  if (!serverPort || !webPort) {
    throw new Error(`[qa-ui-url] stack.runtime.json missing ports (server=${String(serverPort)} web=${String(webPort)})`);
  }

  // Use loopback IPv4 to avoid IPv6/localhost resolution differences across hosts.
  const out = new URL(`http://127.0.0.1:${webPort}/`);
  out.searchParams.set('server', `http://127.0.0.1:${serverPort}`);
  return out.toString();
}

export function withQaUiBase(baseUrl, pathname, opts = {}) {
  const next = new URL(String(baseUrl));
  next.pathname = String(pathname ?? '/');
  if (opts && opts.stripServerParam === true) {
    next.searchParams.delete('server');
  }
  return next.toString();
}

export function ensureQaUiUrlHasHmrDisabled(url) {
  const next = new URL(String(url));
  next.searchParams.set('happier_hmr', '0');
  return next.toString();
}

export function isQaUiUrlPathSuffix(url, suffix) {
  try {
    const parsed = new URL(String(url));
    return parsed.pathname.endsWith(String(suffix ?? ''));
  } catch {
    return false;
  }
}

