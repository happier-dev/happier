import { join } from 'node:path';
import { ensureEnvFileUpdated } from './env_file.mjs';
import { getHappyStacksHomeDir, resolveStackEnvPath } from '../paths/paths.mjs';
import { getCanonicalHomeDirFromEnv } from '../paths/canonical_home.mjs';

export function getHomeEnvPath() {
  return join(getHappyStacksHomeDir(), '.env');
}

export function getCanonicalHomeDir() {
  return getCanonicalHomeDirFromEnv(process.env);
}

export function getCanonicalHomeEnvPath() {
  return join(getCanonicalHomeDir(), '.env');
}

export function getHomeEnvLocalPath() {
  return join(getHappyStacksHomeDir(), 'env.local');
}

export function resolveUserConfigEnvPath({ cliRootDir }) {
  const explicit = (process.env.HAPPIER_STACK_ENV_FILE ?? '').trim();
  if (explicit) {
    return explicit;
  }

  // By default, persist configuration to the main stack env file so config is
  // outside the repo and consistent across install modes.
  //
  // This also matches the stack env precedence in scripts/utils/env.mjs.
  void cliRootDir;
  return resolveStackEnvPath('main').envPath;
}

export async function ensureHomeEnvUpdated({ updates }) {
  await ensureEnvFileUpdated({ envPath: getHomeEnvPath(), updates });
}

export async function ensureCanonicalHomeEnvUpdated({ updates }) {
  await ensureEnvFileUpdated({ envPath: getCanonicalHomeEnvPath(), updates });
}

export async function ensureHomeEnvLocalUpdated({ updates }) {
  await ensureEnvFileUpdated({ envPath: getHomeEnvLocalPath(), updates });
}

export async function ensureUserConfigEnvUpdated({ cliRootDir, updates }) {
  const envPath = resolveUserConfigEnvPath({ cliRootDir });
  await ensureEnvFileUpdated({ envPath, updates });
  return envPath;
}
