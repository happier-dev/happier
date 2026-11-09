import type { GuardCandidate } from '../guardPlanner';

/** The launch owner settles Chromium while retaining the Session workspace; never signal a PID here. */
export async function browserClose(candidate: GuardCandidate, signal: AbortSignal): Promise<
  Readonly<{ status: 'stopped' } | { status: 'failed'; reason: string }>> {
  if (signal.aborted) return { status: 'failed', reason: 'cancelled' };
  if (candidate.kind !== 'browser' || candidate.root.owner.kind !== 'browser_sidecar'
    || !candidate.root.live || !candidate.root.stop) return { status: 'failed', reason: 'unsupported_target' };
  try { await candidate.root.stop(); return { status: 'stopped' }; }
  catch { return { status: 'failed', reason: 'native_stop_failed' }; }
}
