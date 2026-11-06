import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';

import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { resolveSessionMachineWorkspacePath } from '@/session/machineControlLocality';
import { resolveInactiveSessionUsageLimitRecoveryControls } from '@/session/usageLimitRecoveryControls/catalogHooks';
import { normalizeUsageLimitRecoveryOperationResult } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryOperationResult';
import type { SessionUsageLimitRecoveryReadinessProbeResult } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import { tryReadSessionMetadataRecord } from '../sessionAuthSwitch/persistedState';

/** Reuse the native quota check without admitting a user turn or starting a second recovery owner. */
export async function readTemporaryThrottleUsageLimitReadiness(input: Readonly<{
  sessionId: string;
  credentials: StoredCredentials;
  currentMachineId: string;
}>): Promise<SessionUsageLimitRecoveryReadinessProbeResult> {
  const transport = await resolveSessionTransportContext({ ...input, reason: 'session-control',
    idOrPrefix: input.sessionId, exact: true });
  if (!transport.ok) return { status: 'unavailable', errorCode: transport.code };
  const metadata = tryReadSessionMetadataRecord({ rawSession: transport.rawSession,
    credentials: input.credentials, accountEncryptionMode: transport.accountEncryptionCurrentness.mode });
  if (!metadata) return { status: 'unavailable', errorCode: 'usage_limit_recovery_session_unavailable' };
  const adapter = await resolveInactiveSessionUsageLimitRecoveryControls(resolveAgentIdFromSessionMetadata(metadata));
  // Agents without a quota probe retain their existing reported-reset/backoff contract.
  if (!adapter?.checkNow) return { status: 'ready' };
  const raw = await adapter.checkNow({ ...transport, ...input, token: input.credentials.token, metadata,
    sessionMachineId: typeof transport.rawSession.machineId === 'string' ? transport.rawSession.machineId : null,
    cwd: resolveSessionMachineWorkspacePath({ metadata, currentMachineId: input.currentMachineId, candidatePath: metadata.path }),
  });
  const result = normalizeUsageLimitRecoveryOperationResult(raw, { sessionId: input.sessionId });
  if (!result.ok) return { status: 'unavailable', errorCode: result.errorCode };
  if (result.status === 'ready') return { status: 'ready' };
  const recovery = SessionUsageLimitRecoveryV1Schema.safeParse(result.metadata?.[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
  const nowMs = Date.now();
  const nextCheckAtMs = recovery.success ? recovery.data.nextCheckAtMs : null;
  return { status: 'waiting', ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs }
    : typeof nextCheckAtMs === 'number' && nextCheckAtMs > nowMs ? { retryAfterMs: nextCheckAtMs - nowMs } : {}) };
}
