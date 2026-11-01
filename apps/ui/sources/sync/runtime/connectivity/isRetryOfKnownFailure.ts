import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

/**
 * A supervisor's own retry timer re-enters `connecting` with a non-zero attempt; a start or an explicit
 * retry begins again at attempt zero. When the target is already presented as failed, the timer-driven
 * re-entry is not news: presenting it would cycle the shell through loading and error on every backoff
 * tick. The attempt's outcome (`online`, or the next `offline`) is the next thing worth publishing.
 */
export function isRetryOfKnownFailure(
    state: Pick<ManagedConnectionState, 'phase' | 'attempt'>,
    failureIsPresented: boolean,
): boolean {
    return failureIsPresented && state.phase === 'connecting' && state.attempt > 0;
}
