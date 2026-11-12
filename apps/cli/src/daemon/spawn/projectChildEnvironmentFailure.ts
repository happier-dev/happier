import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { SessionSpawnLaunchErrorV1 } from '@happier-dev/protocol/spawnSession';
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

/** Foreground admission uses the existing launch-error envelope for native causes. */
export function projectChildEnvironmentLaunchError(
  failure: Extract<ResolveSpawnChildEnvironmentResult, { ok: false }>,
): ProviderErrorV1 | SessionSpawnLaunchErrorV1 {
  return failure.providerError ?? {
    kind: 'launch_error',
    code: failure.errorCode,
    message: failure.errorMessage,
  };
}
