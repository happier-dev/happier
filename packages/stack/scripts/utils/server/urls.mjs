import { existsSync, readFileSync } from 'node:fs';

import { getStackName, resolveStackEnvPath } from '../paths/paths.mjs';
import { preferStackLocalhostUrl } from '../paths/localhost_host.mjs';
import { resolvePublicServerUrl } from '../../tailscale.mjs';
import { resolveServerPortFromEnv } from './port.mjs';
import { normalizeUrlNoTrailingSlash } from '../net/url.mjs';

function stackEnvExplicitlySetsPublicUrl({ env, stackName }) {
  try {
    const envPath =
      (env.HAPPY_STACKS_ENV_FILE ?? env.HAPPY_LOCAL_ENV_FILE ?? '').toString().trim() ||
      resolveStackEnvPath(stackName).envPath;
    if (!envPath || !existsSync(envPath)) return false;
    const raw = readFileSync(envPath, 'utf-8');
    return /^(HAPPY_STACKS_SERVER_URL|HAPPY_LOCAL_SERVER_URL)=/m.test(raw);
  } catch {
    return false;
  }
}

function stackEnvExplicitlySetsWebappUrl({ env, stackName }) {
  try {
    const envPath =
      (env.HAPPY_STACKS_ENV_FILE ?? env.HAPPY_LOCAL_ENV_FILE ?? '').toString().trim() ||
      resolveStackEnvPath(stackName).envPath;
    if (!envPath || !existsSync(envPath)) return false;
    const raw = readFileSync(envPath, 'utf-8');
    return /^HAPPY_WEBAPP_URL=/m.test(raw);
  } catch {
    return false;
  }
}

export function getPublicServerUrlEnvOverride({ env = process.env, serverPort, stackName = null } = {}) {
  const name =
    (stackName ?? '').toString().trim() ||
    (env.HAPPY_STACKS_STACK ?? env.HAPPY_LOCAL_STACK ?? '').toString().trim() ||
    getStackName(env);
  const defaultPublicUrl = `http://localhost:${serverPort}`;

  let envPublicUrl =
    (env.HAPPY_STACKS_SERVER_URL ?? env.HAPPY_LOCAL_SERVER_URL ?? '').toString().trim() || '';
  envPublicUrl = normalizeUrlNoTrailingSlash(envPublicUrl);

  // Safety: for non-main stacks, ignore a global SERVER_URL unless it was explicitly set in the stack env file.
  if (name !== 'main' && envPublicUrl && !stackEnvExplicitlySetsPublicUrl({ env, stackName: name })) {
    envPublicUrl = '';
  }

  return { defaultPublicUrl, envPublicUrl, publicServerUrl: envPublicUrl || defaultPublicUrl };
}

export function getWebappUrlEnvOverride({ env = process.env, stackName = null } = {}) {
  const name =
    (stackName ?? '').toString().trim() ||
    (env.HAPPY_STACKS_STACK ?? env.HAPPY_LOCAL_STACK ?? '').toString().trim() ||
    getStackName(env);

  let envWebappUrl = (env.HAPPY_WEBAPP_URL ?? '').toString().trim() || '';

  // Safety: for non-main stacks, ignore a global HAPPY_WEBAPP_URL unless it was explicitly set in the stack env file.
  if (name !== 'main' && envWebappUrl && !stackEnvExplicitlySetsWebappUrl({ env, stackName: name })) {
    envWebappUrl = '';
  }

  return { envWebappUrl };
}

export async function resolveServerUrls({ env = process.env, serverPort, allowEnable = true } = {}) {
  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const stackName =
    (env.HAPPY_STACKS_STACK ?? env.HAPPY_LOCAL_STACK ?? '').toString().trim() ||
    getStackName(env);
  const { defaultPublicUrl, envPublicUrl } = getPublicServerUrlEnvOverride({ env, serverPort });
  const resolved = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable,
    stackName,
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

