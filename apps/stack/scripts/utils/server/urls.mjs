import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getStackName, resolveActiveStackEnvFilePath, resolveStackEnvPath } from '../paths/paths.mjs';
import { preferStackLocalhostHost, preferStackLocalhostUrl } from '../paths/localhost_host.mjs';
import { resolvePublicServerUrl } from '../../tailscale.mjs';
import { readPinnedServerPortFromEnvFile, resolveServerPortFromEnv } from './port.mjs';
import { normalizeUrlNoTrailingSlash } from '../net/url.mjs';
import { readStackRuntimeStateFile, resolveTrustedStackRuntimeServerPort } from '../stack/runtime_state.mjs';

/** Runtime ingress wins over a retained port; only the process owner can attest it. */
export async function resolveStackServerEndpoint({
  env = process.env,
  stackName = getStackName(env),
  runtimeState,
  defaultPort = 3005,
  trustOptions = {},
} = {}) {
  const { baseDir, envPath: retainedEnvPath } = resolveStackEnvPath(stackName, env);
  const isForeignStackEnv = Boolean(env.HAPPIER_STACK_STACK && env.HAPPIER_STACK_STACK !== stackName);
  const envPath = isForeignStackEnv ? retainedEnvPath : resolveActiveStackEnvFilePath(stackName, env);
  const runtimePath = env.HAPPIER_STACK_STACK === stackName && env.HAPPIER_STACK_RUNTIME_STATE_PATH
    ? env.HAPPIER_STACK_RUNTIME_STATE_PATH : join(baseDir, 'stack.runtime.json');
  const state = runtimeState === undefined ? await readStackRuntimeStateFile(runtimePath) : runtimeState;
  const runtimePort = await resolveTrustedStackRuntimeServerPort(state, {
    stackName, envPath, cliHomeDir: !isForeignStackEnv && env.HAPPIER_STACK_CLI_HOME_DIR || join(baseDir, 'cli'),
  }, trustOptions);
  const configuredPort = resolveServerPortFromEnv({ env, defaultPort: null });
  const port = runtimePort ?? configuredPort ?? await readPinnedServerPortFromEnvFile(envPath) ?? defaultPort;
  return { port, runtimePort, internalServerUrl: port ? `http://127.0.0.1:${port}` : null };
}

function readStackEnvRaw({ env, stackName }) {
  try {
    const envPath = resolveActiveStackEnvFilePath(stackName, env);
    if (!envPath || !existsSync(envPath)) return null;
    return readFileSync(envPath, 'utf-8');
  } catch {
    return null;
  }
}

function stackEnvExplicitlySetsPublicUrl(stackEnvRaw) {
  try {
    return typeof stackEnvRaw === 'string' &&
      (/^HAPPIER_PUBLIC_SERVER_URL=/m.test(stackEnvRaw) || /^HAPPIER_STACK_SERVER_URL=/m.test(stackEnvRaw));
  } catch {
    return false;
  }
}

function stackEnvExplicitlySetsWebappUrl(stackEnvRaw) {
  try {
    return typeof stackEnvRaw === 'string' && /^HAPPIER_WEBAPP_URL=/m.test(stackEnvRaw);
  } catch {
    return false;
  }
}

export function getPublicServerUrlEnvOverride({ env = process.env, serverPort, stackName = null } = {}) {
  const name =
    (stackName ?? '').toString().trim() ||
    (env.HAPPIER_STACK_STACK ?? '').toString().trim() ||
    getStackName(env);
  const defaultPublicUrl = `http://localhost:${serverPort}`;
  const stackEnvRaw = readStackEnvRaw({ env, stackName: name });

  let envPublicUrl =
    (env.HAPPIER_PUBLIC_SERVER_URL ?? '').toString().trim() ||
    (env.HAPPIER_STACK_SERVER_URL ?? '').toString().trim() ||
    '';
  envPublicUrl = normalizeUrlNoTrailingSlash(envPublicUrl);

  // Safety: when a stack env file is in play, it is authoritative for public URL overrides.
  // This prevents a stale machine-level HAPPIER_PUBLIC_SERVER_URL from leaking a different stack's
  // share URL into localhost-oriented auth/dev flows.
  if (envPublicUrl && !stackEnvExplicitlySetsPublicUrl(stackEnvRaw)) {
    envPublicUrl = '';
  }

  return { defaultPublicUrl, envPublicUrl, publicServerUrl: envPublicUrl || defaultPublicUrl };
}

export function getWebappUrlEnvOverride({ env = process.env, stackName = null } = {}) {
  const name =
    (stackName ?? '').toString().trim() ||
    (env.HAPPIER_STACK_STACK ?? '').toString().trim() ||
    getStackName(env);
  const stackEnvRaw = readStackEnvRaw({ env, stackName: name });

  let envWebappUrl = (env.HAPPIER_WEBAPP_URL ?? '').toString().trim() || '';

  // Safety: ignore a global HAPPIER_WEBAPP_URL unless it was explicitly set in the stack env file.
  // This prevents surprising launches of the hosted app due to shell env leakage.
  if (envWebappUrl && !stackEnvExplicitlySetsWebappUrl(stackEnvRaw)) {
    envWebappUrl = '';
  }

  return { envWebappUrl };
}

// The stack-owned canonical server origin: the stable identity a stack's server signs and verifies
// auth audiences against. It is deliberately distinct from the public ingress URL, which is inferred
// per start (Tailscale/relay/LAN) and therefore mutable. Only an explicit operator public URL from the
// stack env file, or the stack's own stable `<prefix>-<stack>.localhost` origin, can define it.
export async function resolveStackCanonicalServerUrl({
  env = process.env,
  serverPort,
  stackName = null,
  envPublicUrl = null,
} = {}) {
  const name =
    (stackName ?? '').toString().trim() ||
    (env.HAPPIER_STACK_STACK ?? '').toString().trim() ||
    getStackName(env);
  const explicitPublicUrl = normalizeUrlNoTrailingSlash(
    String(
      envPublicUrl ?? getPublicServerUrlEnvOverride({ env, serverPort, stackName: name }).envPublicUrl ?? '',
    ).trim(),
  );
  if (explicitPublicUrl) return explicitPublicUrl;

  const host = await preferStackLocalhostHost({ stackName: name, env });
  return normalizeUrlNoTrailingSlash(`http://${host || 'localhost'}:${serverPort}`);
}

export async function resolveServerUrls({ env = process.env, serverPort, allowEnable = true } = {}) {
  serverPort ??= (await resolveStackServerEndpoint({ env })).port;
  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const stackName =
    (env.HAPPIER_STACK_STACK ?? '').toString().trim() ||
    getStackName(env);
  const { defaultPublicUrl, envPublicUrl } = getPublicServerUrlEnvOverride({ env, serverPort });
  const resolved = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable,
    stackName,
    env,
  });
  const publicServerUrl = normalizeUrlNoTrailingSlash(
    await preferStackLocalhostUrl(resolved.publicServerUrl, { stackName })
  );
  const canonicalServerUrl = await resolveStackCanonicalServerUrl({
    env,
    serverPort,
    stackName,
    envPublicUrl,
  });
  return {
    serverPort,
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    publicServerUrl,
    publicServerUrlSource: resolved.source,
    canonicalServerUrl,
  };
}

export { resolveServerPortFromEnv };
