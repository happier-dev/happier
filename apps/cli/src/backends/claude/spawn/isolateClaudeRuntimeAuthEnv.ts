import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  findConnectedServiceChildSelection,
  readConnectedServiceMaterializedEnvKeysFromEnv,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { isAllowedExactEnvKey } from '@/utils/env/isAllowedExactEnvKey';

import {
  CLAUDE_AUTH_ENV_KEYS,
  CLAUDE_RUNTIME_REFRESH_SECRET_ENV_KEYS,
  type ClaudeAuthEnvKey,
} from '../auth/claudeAuthEnvKeys';

const AUTH_ENV_KEYS = new Set<string>(CLAUDE_AUTH_ENV_KEYS);
const REFRESH_ENV_KEYS = new Set<string>(CLAUDE_RUNTIME_REFRESH_SECRET_ENV_KEYS);

function toMaterializedKeySet(env: Pick<NodeJS.ProcessEnv, string>): Set<string> {
  return new Set(readConnectedServiceMaterializedEnvKeysFromEnv(env));
}

function resolveAllowedConnectedAuthEnvKeys(
  env: Pick<NodeJS.ProcessEnv, string>,
): Set<ClaudeAuthEnvKey> | null {
  const selection =
    findConnectedServiceChildSelection(env, 'claude-subscription')
    ?? findConnectedServiceChildSelection(env, 'anthropic');
  if (!selection) return null;

  const serviceAllowedKeys: readonly ClaudeAuthEnvKey[] = selection.serviceId === 'anthropic'
    ? ['ANTHROPIC_API_KEY']
    : [];
  const materializedKeys = toMaterializedKeySet(env);
  if (materializedKeys.size === 0) return new Set(serviceAllowedKeys);

  return new Set(serviceAllowedKeys.filter((key) => materializedKeys.has(key)));
}

function stripInternalConnectedServiceEnv(env: NodeJS.ProcessEnv): void {
  delete env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  delete env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY];
}

export function isolateClaudeRuntimeAuthEnv<T extends NodeJS.ProcessEnv>(env: T): T {
  const allowedConnectedAuthKeys = resolveAllowedConnectedAuthEnvKeys(env);
  for (const key of Object.keys(env)) {
    const shouldStrip = allowedConnectedAuthKeys
      ? isAllowedExactEnvKey(key, AUTH_ENV_KEYS) && !isAllowedExactEnvKey(key, allowedConnectedAuthKeys)
      : isAllowedExactEnvKey(key, REFRESH_ENV_KEYS);
    if (shouldStrip) delete env[key];
  }
  stripInternalConnectedServiceEnv(env);
  return env;
}
