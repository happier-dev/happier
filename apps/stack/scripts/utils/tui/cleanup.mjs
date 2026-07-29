import { readFile } from 'node:fs/promises';

import { parseEnvToObject } from '../env/dotenv.mjs';
import { resolveStackEnvPath } from '../paths/paths.mjs';
import { stopStackWithEnv } from '../stack/stop.mjs';

async function readEnvObject(envPath) {
  try {
    const raw = await readFile(envPath, 'utf-8');
    return parseEnvToObject(raw);
  } catch {
    return {};
  }
}

export async function stopStackForTuiExit({
  rootDir,
  stackName,
  json = false,
  noDocker = false,
  env: outerEnv = process.env,
  expectedRuntimeOwner = null,
}) {
  const { envPath, baseDir } = resolveStackEnvPath(stackName, outerEnv);
  const stackEnv = await readEnvObject(envPath);
  const expectedOwnerPid = Number(expectedRuntimeOwner?.ownerPid);
  const expectedOwnerStartedAt = String(expectedRuntimeOwner?.startedAt ?? '').trim();
  const hasExpectedRuntimeOwner = Number.isInteger(expectedOwnerPid)
    && expectedOwnerPid > 1
    && expectedOwnerStartedAt;

  const env = {
    ...(outerEnv ?? process.env),
    ...stackEnv,
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_ENV_FILE: envPath,
  };

  return await stopStackWithEnv({
    rootDir,
    stackName,
    baseDir,
    env,
    json,
    noDocker,
    aggressive: false,
    sweepOwned: false,
    autoSweep: true,
    ...(hasExpectedRuntimeOwner
      ? { expectedOwnerPid, expectedOwnerStartedAt }
      : {}),
  });
}
