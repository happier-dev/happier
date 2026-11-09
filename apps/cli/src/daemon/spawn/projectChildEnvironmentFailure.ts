import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';

import { buildProviderSpawnErrorResult } from './buildProviderSpawnErrorResult';
import type { ResolveSpawnChildEnvironmentResult } from './resolveSpawnChildEnvironment';

/** Both prerequisite and final-environment preparation retain the same refusal. */
export function projectChildEnvironmentFailure(
  failure: Extract<ResolveSpawnChildEnvironmentResult, { ok: false }>,
): Extract<SpawnSessionResult, { type: 'error' }> {
  return failure.providerError ? buildProviderSpawnErrorResult(failure.providerError) : {
    type: 'error',
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
    ...(failure.agentId !== undefined ? { agentId: failure.agentId } : {}),
  };
}
