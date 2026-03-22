import { delimiter } from 'node:path';

import { sanitizeDefinedEnv } from '../../utils/test/test_env.mjs';

export function buildStackFixtureEnv({
  baseEnv = process.env,
  homeDir,
  storageDir,
  workspaceDir,
  sandboxDir,
  stackName,
  envPath,
  stripStackEnv = false,
  extraEnv = {},
} = {}) {
  const seed = stripStackEnv
    ? Object.fromEntries(Object.entries(baseEnv ?? {}).filter(([key]) => !key.startsWith('HAPPIER_STACK_')))
    : { ...(baseEnv ?? {}) };

  return sanitizeDefinedEnv({
    ...seed,
    ...(homeDir ? { HAPPIER_STACK_HOME_DIR: homeDir } : {}),
    ...(storageDir ? { HAPPIER_STACK_STORAGE_DIR: storageDir } : {}),
    ...(workspaceDir ? { HAPPIER_STACK_WORKSPACE_DIR: workspaceDir } : {}),
    ...(sandboxDir ? { HAPPIER_STACK_SANDBOX_DIR: sandboxDir } : {}),
    ...(stackName ? { HAPPIER_STACK_STACK: stackName } : {}),
    ...(envPath ? { HAPPIER_STACK_ENV_FILE: envPath } : {}),
    ...extraEnv,
  });
}

export function buildGitIdentityEnv({ baseEnv = process.env, stripStackEnv = true, extraEnv = {} } = {}) {
  return buildStackFixtureEnv({
    baseEnv,
    stripStackEnv,
    extraEnv: {
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      ...extraEnv,
    },
  });
}

export function prependPathEntries(env = process.env, entries = []) {
  const cleanEnv = sanitizeDefinedEnv(env);
  const currentEntries = (cleanEnv.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const nextEntries = [...entries, ...currentEntries].map((entry) => String(entry ?? '').trim()).filter(Boolean);
  cleanEnv.PATH = [...new Set(nextEntries)].join(delimiter);
  return cleanEnv;
}

export function filterEnvForSpawn(env = process.env, { keepKeys = [], keepPrefixes = [] } = {}) {
  const cleanEnv = {};
  for (const key of keepKeys) {
    const value = env?.[key];
    if (value == null) continue;
    cleanEnv[key] = String(value);
  }
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key in cleanEnv) continue;
    if (value == null) continue;
    if (!keepPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    cleanEnv[key] = String(value);
  }
  return cleanEnv;
}

export function withPatchedProcessEnv(t, overrides = {}) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };
  if (t?.after) t.after(restore);
  return restore;
}
