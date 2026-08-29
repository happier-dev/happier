import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol';

import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';

import { buildInactiveUsageLimitResumeSpawnOptions } from './runtimeSnapshot/buildInactiveUsageLimitResumeSpawnOptions';

export type ActivateInactiveUsageLimitResumeParams = Readonly<{
  fallbackMachineId: string;
  sessionId: string;
  rawSession: unknown;
  metadata: Record<string, unknown>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
}>;

/**
 * The ONE automatic resume for inactive-session usage-limit recovery: spawn the
 * hosted runtime only when this machine still owns the Session's runtime.
 *
 * A Session whose transcript lives with an external Agent — or whose external
 * link exists but is unresolved — is owned by External Sessions takeover, so
 * recovery fails closed here instead of spawning it. Plain unlinked sessions
 * keep the canonical auto-resume behavior.
 */
export async function activateInactiveUsageLimitResume(
  params: ActivateInactiveUsageLimitResumeParams,
): Promise<boolean> {
  const linkAuthority = resolveLinkedExternalSessionAuthorityV1(params.metadata);
  if (!linkAuthority.ok || linkAuthority.transcriptStorage === 'direct') {
    return false;
  }
  const options = buildInactiveUsageLimitResumeSpawnOptions({
    sessionId: params.sessionId,
    fallbackMachineId: params.fallbackMachineId,
    rawSession: params.rawSession,
    metadata: params.metadata,
  });
  if (!options) return false;
  const result = await params.spawnSession(options);
  return result.type === 'success';
}
