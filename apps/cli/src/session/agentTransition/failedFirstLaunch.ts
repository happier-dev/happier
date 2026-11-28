import { randomUUID } from 'node:crypto';

import type { ConnectedServiceSpawnAdmission } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';

import { readPendingQueueV2ActivationEligibilityFromServer } from '@/api/session/pendingQueueV2Transport';

type Launch = Readonly<{
  sessionId: string;
  agentId: string;
  localId: string;
  metadataVersion: number;
  pendingVersion: number;
  allowCredentialRecovery?: boolean;
}>;

// The transition coordinator supplies this evidence only on the original
// cutover. A reconciled cutover cannot reconstruct the original launch facts.
type LaunchAttempt = {
  launch: Launch;
  nonce: string;
  state: 'expected' | 'preparing' | 'credential_refused';
  admittedAuth?: Readonly<{ materializationId: string; credentials: ConnectedServiceSpawnAdmission }>;
};
const attempts = new Map<string, LaunchAttempt>();

export async function runFirstTransitionLaunch<T>(
  launch: Launch,
  start: (spawnNonce: string) => Promise<T>,
  admittedAuth?: LaunchAttempt['admittedAuth'],
): Promise<T> {
  const attempt: LaunchAttempt = { launch, nonce: randomUUID(), state: 'expected', admittedAuth };
  attempts.set(launch.sessionId, attempt);
  try {
    return await start(attempt.nonce);
  } finally {
    const current = attempts.get(launch.sessionId);
    if (current === attempt && current.state !== 'credential_refused') attempts.delete(launch.sessionId);
  }
}

export function observeTransitionTargetSpawn(
  sessionId: string,
  spawnNonce: string | undefined,
  pendingRequestId?: string,
): Readonly<{ admittedAuth?: LaunchAttempt['admittedAuth']; credentialRefused: () => void; finish: () => void }> | undefined {
  const previous = attempts.get(sessionId);
  if (!previous) return;
  const originalLaunch = previous.state === 'expected' && previous.nonce === spawnNonce;
  // A Pending wake has no transition nonce. It may carry the same admitted
  // input, but it must prove its own preflight refusal before recovery resumes.
  const samePendingRetry = previous.state === 'credential_refused'
    && !spawnNonce && previous.launch.localId === pendingRequestId;
  if (!originalLaunch && !samePendingRetry) {
    attempts.delete(sessionId);
    return;
  }
  const attempt: LaunchAttempt = originalLaunch ? previous : { ...previous };
  attempt.state = 'preparing';
  attempts.set(sessionId, attempt);
  const admittedAuth = attempt.admittedAuth;
  delete attempt.admittedAuth;
  return {
    admittedAuth,
    credentialRefused: () => {
      if (attempt.launch.allowCredentialRecovery !== false && attempts.get(sessionId) === attempt) attempt.state = 'credential_refused';
    },
    finish: () => {
      if (attempts.get(sessionId) === attempt && attempt.state !== 'credential_refused') attempts.delete(sessionId);
    },
  };
}

export async function resolveFailedFirstLaunchAccountSwitch(input: Readonly<{
  token: string;
  sessionId: string;
  agentId: string;
  active: unknown;
  metadataVersion: unknown;
  pendingVersion: unknown;
}>): Promise<'retry_original_transition' | undefined> {
  const attempt = attempts.get(input.sessionId);
  if (!attempt || attempt.state !== 'credential_refused' || input.active !== false) return;
  const { launch } = attempt;
  if (launch.agentId !== input.agentId || launch.metadataVersion !== input.metadataVersion
    || launch.pendingVersion !== input.pendingVersion) return;
  const pending = await readPendingQueueV2ActivationEligibilityFromServer({
    token: input.token,
    sessionId: input.sessionId,
    requestId: launch.localId,
  }).catch(() => null);
  return pending === 'eligible' && attempts.get(input.sessionId) === attempt
    ? 'retry_original_transition'
    : undefined;
}
