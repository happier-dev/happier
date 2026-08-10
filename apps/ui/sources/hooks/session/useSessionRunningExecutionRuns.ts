import * as React from 'react';
import type { ExecutionRunPublicState } from '@happier-dev/protocol';

import {
    EMPTY_RUNNING_EXECUTION_RUNS,
    readRunningExecutionRuns,
    requestRunningExecutionRunsRefresh,
    subscribeToRunningExecutionRuns,
} from './sessionRunningExecutionRunsStore';

export { resolveRunningExecutionRunsFromListResult } from './sessionRunningExecutionRunsStore';

/**
 * Read the session's running execution runs.
 *
 * The poll itself belongs to `sessionRunningExecutionRunsStore`, shared by every surface watching
 * the same session; this hook is only the React adapter over it. Mounting it a second time for a
 * session that is already being polled costs one listener, not a second interval.
 */
export function useSessionRunningExecutionRuns(params: Readonly<{
    sessionId: string;
    enabled: boolean;
    refreshKey?: unknown;
}>): readonly ExecutionRunPublicState[] {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
    const active = params.enabled && sessionId.length > 0;

    const subscribe = React.useCallback((listener: () => void) => {
        if (!active) return () => {};
        return subscribeToRunningExecutionRuns(sessionId, listener);
    }, [active, sessionId]);

    const getSnapshot = React.useCallback(() => (
        active ? readRunningExecutionRuns(sessionId) : EMPTY_RUNNING_EXECUTION_RUNS
    ), [active, sessionId]);

    const runningRuns = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    // Transcript evidence that run state may have moved. `useSyncExternalStore` subscribes above in
    // hook order, so on mount the shared loop is already fetching and this is a no-op; it only bites
    // when the refresh key changes later against an idle loop.
    const { refreshKey } = params;
    React.useEffect(() => {
        if (!active) return;
        requestRunningExecutionRunsRefresh(sessionId);
    }, [active, refreshKey, sessionId]);

    return runningRuns;
}
