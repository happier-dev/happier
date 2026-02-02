import { join } from 'node:path';

import { parseEnvToObject } from '../env/dotenv.mjs';
import { resolveStackEnvPath } from '../paths/paths.mjs';
import { getEnvValue } from '../env/values.mjs';
import { readTextIfExists } from '../fs/ops.mjs';
import { stackExistsSync } from '../stack/stacks.mjs';

export async function resolveHandyMasterSecretFromStack({
  stackName,
  requireStackExists = false,
} = {}) {
  const name = String(stackName ?? '').trim() || 'main';

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

  const secretFile = getEnvValue(env, 'HAPPIER_STACK_HANDY_MASTER_SECRET_FILE');
  if (secretFile) {
    const secret = await readTextIfExists(secretFile);
    if (secret) return { secret, source: secretFile };
  }

  const dataDir = getEnvValue(env, 'HAPPIER_SERVER_LIGHT_DATA_DIR') || join(sourceBaseDir, 'server-light');
  const secretPath = join(dataDir, 'handy-master-secret.txt');
  const secret = await readTextIfExists(secretPath);
  if (secret) return { secret, source: secretPath };

  return { secret: null, source: null };
}
