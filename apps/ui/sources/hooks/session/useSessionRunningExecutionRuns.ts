import * as React from 'react';
import type { ExecutionRunPublicState } from '@happier-dev/protocol';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { sessionExecutionRunList, type SessionExecutionRunListResult } from '@/sync/ops/sessionExecutionRuns';
import { subscribeExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';

const SESSION_RUNNING_EXECUTION_RUNS_POLL_INTERVAL_MS = 5_000;
const SESSION_RUNNING_EXECUTION_RUNS_EMPTY_CONFIRM_DELAY_MS = 1_000;
const SESSION_RUNNING_EXECUTION_RUNS_IDLE_ERROR_RETRY_LIMIT = 2;
const EMPTY_RUNNING_EXECUTION_RUNS: readonly ExecutionRunPublicState[] = Object.freeze([]);

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

function areRunningExecutionRunsEqual(
    a: readonly ExecutionRunPublicState[],
    b: readonly ExecutionRunPublicState[],
): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (JSON.stringify(a[i] ?? null) !== JSON.stringify(b[i] ?? null)) return false;
    }
    return true;
}

export function useSessionRunningExecutionRuns(params: Readonly<{
    sessionId: string;
    enabled: boolean;
    refreshKey?: unknown;
}>): readonly ExecutionRunPublicState[] {
    const [runningRuns, setRunningRuns] = React.useState<readonly ExecutionRunPublicState[]>(EMPTY_RUNNING_EXECUTION_RUNS);
    const normalizedSessionId = React.useMemo(() => normalizeSessionId(params.sessionId), [params.sessionId]);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const generationRef = React.useRef(0);
    const inFlightRef = React.useRef(false);
    const pendingRepollRef = React.useRef(false);
    const hadRunningRunRef = React.useRef(false);
    const pendingEmptyConfirmRef = React.useRef(false);
    const idleErrorRetriesRef = React.useRef(0);

    const clearTimer = React.useCallback(() => {
        if (!timerRef.current) return;
        clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    const clearRunningRuns = React.useCallback(() => {
        setRunningRuns((current) => (
            current.length === 0 ? current : EMPTY_RUNNING_EXECUTION_RUNS
        ));
    }, []);

    const pollOnce = React.useCallback(async (gen: number): Promise<void> => {
        if (!params.enabled) return;
        if (!normalizedSessionId) return;
        if (generationRef.current !== gen) return;
        if (inFlightRef.current) return;

        const scheduleNext = (delayMs: number) => {
            if (generationRef.current !== gen) return;
            clearTimer();
            timerRef.current = setTimeout(() => {
                void pollOnce(gen);
            }, delayMs);
        };

        inFlightRef.current = true;
        try {
            let response: SessionExecutionRunListResult = await sessionExecutionRunList(normalizedSessionId, {});
            if ((response as any)?.ok === false && isRpcMethodNotAvailableError(response)) {
                response = await sessionExecutionRunList(normalizedSessionId, {});
            }

            if (generationRef.current !== gen) return;

            if ((response as any)?.ok === false) {
                if (hadRunningRunRef.current) {
                    scheduleNext(SESSION_RUNNING_EXECUTION_RUNS_POLL_INTERVAL_MS);
                    return;
                }

                if (idleErrorRetriesRef.current < SESSION_RUNNING_EXECUTION_RUNS_IDLE_ERROR_RETRY_LIMIT) {
                    idleErrorRetriesRef.current += 1;
                    scheduleNext(SESSION_RUNNING_EXECUTION_RUNS_POLL_INTERVAL_MS);
                    return;
                }

                clearTimer();
                clearRunningRuns();
                return;
            }

            idleErrorRetriesRef.current = 0;
            const nextRunning = resolveRunningExecutionRunsFromListResult(response);
            if (nextRunning.length > 0) {
                hadRunningRunRef.current = true;
                pendingEmptyConfirmRef.current = false;
                setRunningRuns((current) => (
                    areRunningExecutionRunsEqual(current, nextRunning) ? current : nextRunning
                ));
                scheduleNext(SESSION_RUNNING_EXECUTION_RUNS_POLL_INTERVAL_MS);
                return;
            }

            if (hadRunningRunRef.current && !pendingEmptyConfirmRef.current) {
                pendingEmptyConfirmRef.current = true;
                scheduleNext(SESSION_RUNNING_EXECUTION_RUNS_EMPTY_CONFIRM_DELAY_MS);
                return;
            }

            hadRunningRunRef.current = false;
            pendingEmptyConfirmRef.current = false;
            clearTimer();
            clearRunningRuns();
        } finally {
            inFlightRef.current = false;
            if (pendingRepollRef.current && generationRef.current === gen) {
                pendingRepollRef.current = false;
                void pollOnce(gen);
            }
        }
    }, [clearRunningRuns, clearTimer, normalizedSessionId, params.enabled]);

    React.useEffect(() => {
        generationRef.current += 1;
        const gen = generationRef.current;

        // Clear state immediately when sessionId changes to prevent stale state from previous session
        clearRunningRuns();
        clearTimer();
        pendingRepollRef.current = false;
        hadRunningRunRef.current = false;
        pendingEmptyConfirmRef.current = false;
        idleErrorRetriesRef.current = 0;

        if (!params.enabled || !normalizedSessionId) {
            return () => {};
        }

        void pollOnce(gen);

        return () => {
            generationRef.current += 1;
            clearTimer();
            pendingRepollRef.current = false;
        };
    }, [clearRunningRuns, clearTimer, normalizedSessionId, params.enabled, pollOnce]);

    React.useEffect(() => {
        if (!normalizedSessionId) return;
        return subscribeExecutionRunActivity(normalizedSessionId, () => {
            if (!params.enabled) return;
            clearTimer();
            pendingEmptyConfirmRef.current = false;
            if (inFlightRef.current) {
                pendingRepollRef.current = true;
                return;
            }
            void pollOnce(generationRef.current);
        });
    }, [clearTimer, normalizedSessionId, params.enabled, pollOnce]);

    React.useEffect(() => {
        if (!params.enabled || !normalizedSessionId) return;
        if (inFlightRef.current) return;
        if (timerRef.current) return;

        clearTimer();
        pendingEmptyConfirmRef.current = false;
        void pollOnce(generationRef.current);
    }, [clearTimer, normalizedSessionId, params.enabled, params.refreshKey, pollOnce]);

    return runningRuns;
}
