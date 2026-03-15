import * as React from 'react';
import type { ExecutionRunPublicState } from '@happier-dev/protocol';

import { sessionExecutionRunList, type SessionExecutionRunListResult } from '@/sync/ops/sessionExecutionRuns';

const SESSION_RUNNING_EXECUTION_RUNS_POLL_INTERVAL_MS = 5_000;

function isRpcMethodNotAvailableError(input: unknown): boolean {
    if (!input || typeof input !== 'object') return false;
    const code = typeof (input as any).errorCode === 'string' ? String((input as any).errorCode) : '';
    if (code === 'RPC_METHOD_NOT_AVAILABLE') return true;
    const message = typeof (input as any).error === 'string' ? String((input as any).error) : '';
    return /rpc method not available/i.test(message);
}

export function resolveRunningExecutionRunsFromListResult(
    result: SessionExecutionRunListResult,
): readonly ExecutionRunPublicState[] {
    if ((result as any)?.ok === false) return [];
    const runs = Array.isArray((result as any)?.runs) ? ((result as any).runs as ExecutionRunPublicState[]) : [];
    return runs.filter((run) => {
        const status = typeof (run as any)?.status === 'string' ? String((run as any).status).trim().toLowerCase() : '';
        return status === 'running';
    });
}

export function useSessionRunningExecutionRuns(params: Readonly<{
    sessionId: string;
    enabled: boolean;
}>): readonly ExecutionRunPublicState[] {
    const [runningRuns, setRunningRuns] = React.useState<readonly ExecutionRunPublicState[]>([]);

    const loadRuns = React.useCallback(async () => {
        if (!params.enabled || !params.sessionId) {
            setRunningRuns([]);
            return;
        }

        const first = await sessionExecutionRunList(params.sessionId, {});
        if ((first as any)?.ok === false && isRpcMethodNotAvailableError(first)) {
            const retry = await sessionExecutionRunList(params.sessionId, {});
            setRunningRuns(resolveRunningExecutionRunsFromListResult(retry));
            return;
        }

        setRunningRuns(resolveRunningExecutionRunsFromListResult(first));
    }, [params.enabled, params.sessionId]);

    React.useEffect(() => {
        if (!params.enabled || !params.sessionId) {
            setRunningRuns([]);
            return;
        }

        void loadRuns();
        const interval = setInterval(() => {
            void loadRuns();
        }, SESSION_RUNNING_EXECUTION_RUNS_POLL_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [loadRuns, params.enabled, params.sessionId]);

    return runningRuns;
}
