import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseDotenv } from './env/dotenv.mjs';
import { resolveStackEnvPath } from './paths/paths.mjs';
import { getLegacyHappyBaseDir, isLegacyAuthSourceName } from './auth_sources.mjs';

async function readTextIfExists(path) {
  try {
    if (!path || !existsSync(path)) return null;
    const raw = await readFile(path, 'utf-8');
    const t = raw.trim();
    return t ? t : null;
  } catch {
    return null;
  }
}

function parseEnvToObject(raw) {
  const parsed = parseDotenv(raw ?? '');
  return Object.fromEntries(parsed.entries());
}

function getEnvValue(env, key) {
  const v = (env?.[key] ?? '').toString().trim();
  return v || '';
}

function stackExistsSync(stackName) {
  if (stackName === 'main') return true;
  const envPath = resolveStackEnvPath(stackName).envPath;
  return existsSync(envPath);
}

export async function resolveHandyMasterSecretFromStack({
  stackName,
  requireStackExists = false,
  allowLegacyAuthSource = true,
  allowLegacyMainFallback = true,
} = {}) {
  const name = String(stackName ?? '').trim() || 'main';

  if (isLegacyAuthSourceName(name)) {
    if (!allowLegacyAuthSource) {
      throw new Error(
        '[auth] legacy auth source is disabled in sandbox mode.\n' +
          'Reason: it reads from ~/.happy (global user state).\n' +
          'If you really want this, set: HAPPY_STACKS_SANDBOX_ALLOW_GLOBAL=1'
      );
    }
    const baseDir = getLegacyHappyBaseDir();
    const legacySecretPath = join(baseDir, 'server-light', 'handy-master-secret.txt');
    const secret = await readTextIfExists(legacySecretPath);
    return secret ? { secret, source: legacySecretPath } : { secret: null, source: null };
  }

  if (requireStackExists && !stackExistsSync(name)) {
    throw new Error(`[auth] cannot copy auth: source stack "${name}" does not exist`);
  }

  const resolved = resolveStackEnvPath(name);
  const sourceBaseDir = resolved.baseDir;
  const sourceEnvPath = resolved.envPath;
  const raw = await readTextIfExists(sourceEnvPath);
  const env = raw ? parseEnvToObject(raw) : {};

  const inline = getEnvValue(env, 'HANDY_MASTER_SECRET');
  if (inline) {
    return { secret: inline, source: `${sourceEnvPath} (HANDY_MASTER_SECRET)` };
  }

  const secretFile = getEnvValue(env, 'HAPPY_STACKS_HANDY_MASTER_SECRET_FILE');
  if (secretFile) {
    const secret = await readTextIfExists(secretFile);
    if (secret) return { secret, source: secretFile };
  }

  const dataDir = getEnvValue(env, 'HAPPY_SERVER_LIGHT_DATA_DIR') || join(sourceBaseDir, 'server-light');
  const secretPath = join(dataDir, 'handy-master-secret.txt');
  const secret = await readTextIfExists(secretPath);
  if (secret) return { secret, source: secretPath };

  // Last-resort legacy: if main has never been migrated to stack dirs.
  if (name === 'main' && allowLegacyMainFallback) {
    const legacy = join(homedir(), '.happy', 'server-light', 'handy-master-secret.txt');
    const legacySecret = await readTextIfExists(legacy);
    if (legacySecret) return { secret: legacySecret, source: legacy };
  }

  return { secret: null, source: null };
}

