import { existsSync, readFileSync } from 'node:fs';

import { getStackName, resolveStackEnvPath } from '../paths/paths.mjs';
import { preferStackLocalhostUrl } from '../paths/localhost_host.mjs';
import { resolvePublicServerUrl } from '../../tailscale.mjs';
import { resolveServerPortFromEnv } from './port.mjs';
import { normalizeUrlNoTrailingSlash } from '../net/url.mjs';

function readStackEnvRaw({ env, stackName }) {
  try {
    const envPath =
      (env.HAPPIER_STACK_ENV_FILE ?? '').toString().trim() ||
      resolveStackEnvPath(stackName, env).envPath;
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

export async function resolveServerUrls({ env = process.env, serverPort, allowEnable = true } = {}) {
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
  return {
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    publicServerUrl,
    publicServerUrlSource: resolved.source,
  };
}

export function getInternalServerUrl({ env = process.env, defaultPort = 3005 } = {}) {
  const port = resolveServerPortFromEnv({ env, defaultPort });
  return { port, internalServerUrl: `http://127.0.0.1:${port}` };
}

export { resolveServerPortFromEnv };
