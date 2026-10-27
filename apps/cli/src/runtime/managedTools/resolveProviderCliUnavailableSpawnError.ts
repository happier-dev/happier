import type { BackendTargetRefV1, SpawnSessionErrorCode } from '@happier-dev/protocol';
import { AGENT_IDS, type AgentId } from '@happier-dev/agents';
import { resolveProviderCliCommand } from '@happier-dev/cli-common/providers';

import { buildProviderCliUnavailableMessage } from './buildProviderCliUnavailableMessage';

function isKnownAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export type ProviderCliUnavailableSpawnError = Readonly<{
  type: 'error';
  errorCode: SpawnSessionErrorCode;
  errorMessage: string;
}>;

/**
 * Spawn-admission availability gate for built-in agent backends: returns a structured
 * PROVIDER_UNAVAILABLE spawn error with install guidance when the provider CLI cannot be
 * resolved in the environment the runner would see (daemon env merged with the spawn's
 * own environment overrides), or null when the spawn may proceed. Existing-session
 * requests (resume/attach) and configured ACP backends are exempt — the latter resolve
 * through their own launch path.
 */
export function resolveProviderCliUnavailableSpawnError(params: Readonly<{
  backendTarget: BackendTargetRefV1 | undefined;
  existingSessionId?: string | undefined;
  spawnEnvironmentVariables?: Readonly<Record<string, string>> | undefined;
  processEnv?: NodeJS.ProcessEnv;
}>): ProviderCliUnavailableSpawnError | null {
  const backendTarget = params.backendTarget;
  if (!backendTarget || backendTarget.kind !== 'builtInAgent') return null;
  const agentId = backendTarget.agentId;
  if (!isKnownAgentId(agentId)) return null;
  if (params.existingSessionId) return null;
  const processEnv = params.processEnv ?? process.env;
  const probeEnv = params.spawnEnvironmentVariables
    ? { ...processEnv, ...params.spawnEnvironmentVariables }
    : processEnv;
  if (resolveProviderCliCommand(agentId, { processEnv: probeEnv })) return null;
  return {
    type: 'error',
    errorCode: 'PROVIDER_UNAVAILABLE',
    errorMessage: buildProviderCliUnavailableMessage({ agentId }),
  };
}
