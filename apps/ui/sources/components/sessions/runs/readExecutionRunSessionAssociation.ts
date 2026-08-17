import type { DaemonExecutionRunEntry } from '@happier-dev/protocol';

/**
 * A daemon execution run can exist without a Session association. Keep that
 * absence explicit at UI consumers instead of turning it into a route target.
 */
export function readExecutionRunSessionAssociation(
    run: Pick<DaemonExecutionRunEntry, 'happySessionId'>,
): string | null {
    const sessionId = run.happySessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}
