import type { GuardCandidate } from '../guardPlanner';
import type { SessionEligibility } from '../sessionEligibility';
import type { TrackedSession } from '../../types';
import { readTrackedSessionProcessIdentity } from '../../processes/roots/listHappierProcessRoots';

export type SessionStopInput = Readonly<{
  candidate: Pick<GuardCandidate, 'kind' | 'target' | 'root' | 'settledAt'>;
  signal: AbortSignal;
  readCurrentTracked(sessionId: string): TrackedSession | undefined;
  readCurrentEligibility(tracked: TrackedSession, signal: AbortSignal): Promise<SessionEligibility>;
  /** Composition delegates to canonical stopSession with its exact-runner witness, never raw signals. */
  stopSession(sessionId: string, expectedTrackedRunner: TrackedSession): Promise<boolean>;
}>;

export async function sessionStop(input: SessionStopInput): Promise<
  Readonly<{ status: 'stopped' } | { status: 'failed'; reason: string }>> {
  const { candidate, signal } = input;
  const failed = async (reason: string) => {
    if (candidate.target.kind === 'session') await candidate.target.tracked.guardStopReceipt?.settle(
      reason === 'stop_incomplete' || reason === 'native_stop_failed' ? 'failed' : 'cancelled');
    return { status: 'failed' as const, reason };
  };
  if (signal.aborted) return failed('cancelled');
  if (candidate.kind !== 'session' || candidate.target.kind !== 'session' || candidate.root.owner.kind !== 'session')
    return { status: 'failed', reason: 'unsupported_target' };
  const tracked = candidate.target.tracked;
  const id = tracked.happySessionId;
  if (!id || candidate.root.owner.sessionId !== id || input.readCurrentTracked(id) !== tracked)
    return failed('identity_changed');
  // The notice captured this native root, not whichever runner the same
  // mutable tracked object might name when its acknowledgement arrives.
  const identity = readTrackedSessionProcessIdentity(tracked);
  if (identity.pid !== candidate.root.pid || identity.processStartTimeMs !== undefined
    && identity.processStartTimeMs !== candidate.root.start.startTimeMs) return failed('identity_changed');
  const witness = { pid: tracked.pid, sessionRunnerPid: tracked.sessionRunnerPid,
    processStartTimeMs: tracked.processStartTimeMs, processCommandHash: tracked.processCommandHash,
    runnerIdentity: tracked.runnerProcessIdentity };
  let eligibility: SessionEligibility;
  try { eligibility = await input.readCurrentEligibility(tracked, signal); }
  catch { return failed('activity_unknown'); }
  if (signal.aborted) return failed('cancelled');
  if (input.readCurrentTracked(id) !== tracked || tracked.pid !== witness.pid
    || tracked.sessionRunnerPid !== witness.sessionRunnerPid || tracked.processStartTimeMs !== witness.processStartTimeMs
    || tracked.processCommandHash !== witness.processCommandHash || tracked.runnerProcessIdentity !== witness.runnerIdentity) return failed('identity_changed');
  if (!eligibility.eligible) return failed(eligibility.reasons[0]?.kind ?? 'activity_unknown');
  if (eligibility.settledAt !== candidate.settledAt) return failed('activity_changed');
  try {
    return await input.stopSession(id, tracked) ? { status: 'stopped' } : await failed('stop_incomplete');
  } catch { return failed('native_stop_failed'); }
}
