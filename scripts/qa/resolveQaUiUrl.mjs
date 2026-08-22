// @ts-check

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveLocalhostHost } from '../../apps/stack/scripts/utils/paths/localhost_host.mjs';
import { buildBorrowedExpoUiUrl, isBorrowedExpoConsumer } from '../../apps/stack/scripts/runtime/shared/borrowed_expo.mjs';

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

function readEnvValue(path, key) {
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith(`${key}=`)) continue;
      let value = trimmed.slice(key.length + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value.trim();
    }
  } catch {}
  return '';
}

function resolveQaStackName({ env, json, runtimePath }) {
  return String(
    env.HAPPIER_QA_STACK_NAME
    ?? json?.stackName
    ?? runtimePath.split(/[\\/]/).at(-2)
    ?? '',
  ).trim();
}

export function resolveQaUiUrl(env = process.env) {
  const runtimePath = resolveRuntimeJsonPathFromEnv(env);
  const json = runtimePath ? readJsonFileBestEffort(runtimePath) : null;
  if (!json) {
    throw new Error('[qa-ui-url] Unable to resolve stack.runtime.json (set HAPPIER_QA_STACK_RUNTIME_JSON_PATH or HAPPIER_QA_STACKS_DIR)');
  }

  const serverPort = readPortFromRuntimeJson(json, 'server');
  if (!serverPort) {
    throw new Error(`[qa-ui-url] stack.runtime.json missing server port (server=${String(serverPort)})`);
  }

  const stackName = resolveQaStackName({ env, json, runtimePath });
  const host = stackName
    ? resolveLocalhostHost({ stackMode: true, stackName })
    : '127.0.0.1';
  const uiMode = String(env.HAPPIER_QA_UI_MODE ?? '').trim().toLowerCase();
  if (uiMode === 'snapshot') {
    return new URL(`http://${host}:${serverPort}/`).toString();
  }

  const consumerStackDir = dirname(runtimePath);
  const stacksDir = String(env.HAPPIER_QA_STACKS_DIR ?? '').trim() || dirname(consumerStackDir);
  const borrowedExpoStackName = String(
    env.HAPPIER_QA_EXPO_SOURCE_STACK
    ?? readEnvValue(join(consumerStackDir, 'env'), 'HAPPIER_STACK_EXPO_SOURCE_STACK')
    ?? '',
  ).trim();
  const borrowedExpo = isBorrowedExpoConsumer({
    consumerStackName: stackName,
    producerStackName: borrowedExpoStackName,
  });
  const expoRuntime = borrowedExpo
    ? readJsonFileBestEffort(join(stacksDir, borrowedExpoStackName, 'stack.runtime.json'))
    : json;
  const webPort = readPortFromRuntimeJson(expoRuntime, 'web');
  if (!webPort) {
    throw new Error(
      `[qa-ui-url] ${borrowedExpo ? `borrowed Expo stack ${borrowedExpoStackName}` : 'stack.runtime.json'} missing web port`,
    );
  }

  if (borrowedExpo) {
    return buildBorrowedExpoUiUrl({ consumerHost: host, expoPort: webPort, serverPort });
  }

  const out = new URL(`http://${host}:${webPort}/`);
  out.searchParams.set('server', `http://${host}:${serverPort}`);
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
