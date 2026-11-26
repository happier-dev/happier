import { randomUUID } from 'node:crypto';

import { readPendingQueueV2ActivationEligibilityFromServer } from '@/api/session/pendingQueueV2Transport';

type Launch = Readonly<{
  sessionId: string;
  agentId: string;
  localId: string;
  metadataVersion: number;
  pendingVersion: number;
}>;

// The transition coordinator supplies this evidence only on the original
// cutover. A reconciled cutover cannot reconstruct the original launch facts.
type LaunchAttempt = {
  launch: Launch;
  nonce: string;
  state: 'expected' | 'preparing' | 'credential_refused';
};
const attempts = new Map<string, LaunchAttempt>();

export async function runFirstTransitionLaunch<T>(
  launch: Launch,
  start: (spawnNonce: string) => Promise<T>,
): Promise<T> {
  const attempt: LaunchAttempt = { launch, nonce: randomUUID(), state: 'expected' };
  attempts.set(launch.sessionId, attempt);
  try {
    return await start(attempt.nonce);
  } finally {
    const current = attempts.get(launch.sessionId);
    if (current === attempt && current.state !== 'credential_refused') attempts.delete(launch.sessionId);
  }
}

/** Every later launch invalidates recovery for this refusal, even before it opens a provider. */
export function observeTransitionTargetSpawn(sessionId: string, spawnNonce: string | undefined): (() => void) | undefined {
  const attempt = attempts.get(sessionId);
  if (!attempt || attempt.nonce !== spawnNonce || attempt.state !== 'expected') {
    attempts.delete(sessionId);
    return undefined;
  }
  attempt.state = 'preparing';
  return () => {
    if (attempts.get(sessionId) === attempt) attempt.state = 'credential_refused';
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
