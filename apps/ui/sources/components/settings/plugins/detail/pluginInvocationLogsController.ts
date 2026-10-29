import * as React from 'react';
import type {
    DaemonPluginInvocationLogReadResponseV1,
    PluginInvocationLogReadQueryV1,
    PluginInvocationLogRecordV1,
} from '@happier-dev/protocol';

import type { PluginInvocationLogMachineReadTarget } from '@/sync/ops/pluginInvocationLogs';

/** One screen's bounded presentation window; this is not a second log sink. */
export const PLUGIN_INVOCATION_LOG_VIEW_LIMIT = 100;

export type PluginInvocationLogsPhase = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
export type PluginInvocationLogsUnavailableReason = 'machineUnavailable' | 'readerUnavailable';

export type PluginInvocationLogsControllerState = Readonly<{
    phase: PluginInvocationLogsPhase;
    unavailableReason: PluginInvocationLogsUnavailableReason | null;
    correlationId: string;
    records: readonly PluginInvocationLogRecordV1[];
    cursor: number | null;
    hasMore: boolean;
    following: boolean;
}>;

type PluginInvocationLogRead = (params: Readonly<{
    target: PluginInvocationLogMachineReadTarget;
    query: PluginInvocationLogReadQueryV1;
    signal: AbortSignal;
    waitForChanges?: true;
}>) => Promise<DaemonPluginInvocationLogReadResponseV1>;

export type PluginInvocationLogsController = Readonly<{
    state: PluginInvocationLogsControllerState;
    refresh(): Promise<void>;
    loadMore(): Promise<void>;
    startFollowing(): Promise<void>;
    stopFollowing(): void;
    setCorrelationId(value: string): void;
}>;

function initialState(correlationId = ''): PluginInvocationLogsControllerState {
    return {
        phase: 'idle',
        unavailableReason: null,
        correlationId,
        records: [],
        cursor: null,
        hasMore: false,
        following: false,
    };
}

function isAbortError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

function queryFor(params: Readonly<{
    pluginId: string;
    correlationId: string;
    cursor?: number;
    logId?: string;
}>): PluginInvocationLogReadQueryV1 {
    return {
        pluginId: params.pluginId,
        ...(params.correlationId.length > 0 ? { correlationId: params.correlationId } : {}),
        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
        ...(params.logId === undefined ? {} : { logId: params.logId }),
        limit: PLUGIN_INVOCATION_LOG_VIEW_LIMIT,
    };
}

function appendBoundedRecords(
    existing: readonly PluginInvocationLogRecordV1[],
    next: readonly PluginInvocationLogRecordV1[],
): readonly PluginInvocationLogRecordV1[] {
    return [...existing, ...next].slice(-PLUGIN_INVOCATION_LOG_VIEW_LIMIT);
}

/**
 * Presentation controller for one selected plugin's bounded daemon-log view.
 * Every read re-resolves the current exact target, delegates filtering/cursors
 * to the daemon, forwards cancellation to the transport, and retains only the
 * visible screen window. It neither persists nor redacts log records.
 */
export function usePluginInvocationLogsController(params: Readonly<{
    pluginId: string;
    /** Changes when the selected portable origin changes; it is never a routing target. */
    targetKey: string | null;
    resolveTarget: () => PluginInvocationLogMachineReadTarget | null;
    /** The one daemon-RPC boundary is supplied by the owning screen. */
    read: PluginInvocationLogRead;
    subscribeToRecovery?: (target: PluginInvocationLogMachineReadTarget, recover: () => void) => () => void;
    autoLoad?: boolean;
}>): PluginInvocationLogsController {
    const [state, setState] = React.useState<PluginInvocationLogsControllerState>(() => initialState());
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const resolveTargetRef = React.useRef(params.resolveTarget);
    resolveTargetRef.current = params.resolveTarget;
    const readRef = React.useRef<PluginInvocationLogRead>(params.read);
    readRef.current = params.read;
    const pluginIdRef = React.useRef(params.pluginId);
    pluginIdRef.current = params.pluginId;
    const activeRequestRef = React.useRef<Readonly<{
        id: number;
        controller: AbortController;
    }> | null>(null);
    const nextRequestIdRef = React.useRef(0);
    const observedOwnerKeyRef = React.useRef<string | null>(null);
    const logIdRef = React.useRef<string | null>(null);
    const followRequestedRef = React.useRef(false);
    const autoLoad = params.autoLoad !== false;
    const ownerKey = params.targetKey === null
        ? null
        : `${params.pluginId}\u0000${params.targetKey}`;

    const commit = React.useCallback((next: PluginInvocationLogsControllerState) => {
        if (next.cursor === null) logIdRef.current = null;
        stateRef.current = next;
        setState(next);
    }, []);

    const abortActive = React.useCallback(() => {
        nextRequestIdRef.current += 1;
        const active = activeRequestRef.current;
        activeRequestRef.current = null;
        active?.controller.abort();
    }, []);

    const beginRequest = React.useCallback(() => {
        abortActive();
        const controller = new AbortController();
        const request = Object.freeze({ id: nextRequestIdRef.current, controller });
        activeRequestRef.current = request;
        return request;
    }, [abortActive]);

    const isCurrent = React.useCallback((request: Readonly<{ id: number; controller: AbortController }>) => (
        activeRequestRef.current?.id === request.id && !request.controller.signal.aborted
    ), []);

    const completeRequest = React.useCallback((request: Readonly<{ id: number }>) => {
        if (activeRequestRef.current?.id === request.id) activeRequestRef.current = null;
    }, []);

    const publishUnavailable = React.useCallback((
        request?: Readonly<{ id: number; controller: AbortController }>,
        unavailableReason: PluginInvocationLogsUnavailableReason = 'machineUnavailable',
    ) => {
        if (request && !isCurrent(request)) return;
        const current = stateRef.current;
        commit({
            ...initialState(current.correlationId),
            phase: 'unavailable',
            unavailableReason,
        });
    }, [commit, isCurrent]);

    const publishError = React.useCallback((request: Readonly<{ id: number; controller: AbortController }>) => {
        if (!isCurrent(request)) return;
        const current = stateRef.current;
        commit({
            ...current,
            phase: 'error',
            unavailableReason: null,
            following: false,
        });
    }, [commit, isCurrent]);

    const applyAvailablePage = React.useCallback((params: Readonly<{
        request: Readonly<{ id: number; controller: AbortController }>;
        result: Extract<DaemonPluginInvocationLogReadResponseV1, { kind: 'available' }>;
        append: boolean;
        following: boolean;
        requestedCursor?: number;
    }>) => {
        if (!isCurrent(params.request)) return;
        const current = stateRef.current;
        const cursorAdvanced = params.requestedCursor === undefined || params.result.cursor !== params.requestedCursor;
        logIdRef.current = params.result.logId;
        const records = params.result.cursorReset
            ? params.result.records.slice(-PLUGIN_INVOCATION_LOG_VIEW_LIMIT)
            : params.append && cursorAdvanced
            ? appendBoundedRecords(current.records, params.result.records)
            : params.append
                ? current.records
                : params.result.records.slice(-PLUGIN_INVOCATION_LOG_VIEW_LIMIT);
        commit({
            phase: 'ready',
            unavailableReason: null,
            correlationId: current.correlationId,
            records,
            cursor: params.result.cursor,
            hasMore: params.result.hasMore,
            following: params.following,
        });
    }, [commit, isCurrent]);

    const refresh = React.useCallback(async (): Promise<void> => {
        followRequestedRef.current = false;
        const request = beginRequest();
        const current = stateRef.current;
        const target = resolveTargetRef.current();
        if (!target) {
            publishUnavailable(request);
            completeRequest(request);
            return;
        }
        commit({
            ...current,
            phase: 'loading',
            unavailableReason: null,
            following: false,
        });
        try {
            const result = await readRef.current({
                target,
                query: queryFor({
                    pluginId: pluginIdRef.current,
                    correlationId: current.correlationId,
                }),
                signal: request.controller.signal,
            });
            if (!isCurrent(request)) return;
            if (result.kind === 'unavailable') {
                publishUnavailable(
                    request,
                    result.code === 'plugin_log_reader_unavailable' ? 'readerUnavailable' : 'machineUnavailable',
                );
                return;
            }
            applyAvailablePage({ request, result, append: false, following: false });
        } catch (error) {
            if (!isAbortError(error)) publishError(request);
        } finally {
            completeRequest(request);
        }
    }, [applyAvailablePage, beginRequest, commit, completeRequest, isCurrent, publishError, publishUnavailable]);

    const loadMore = React.useCallback(async (): Promise<void> => {
        const current = stateRef.current;
        if (!current.hasMore || current.cursor === null) return;
        followRequestedRef.current = false;
        const request = beginRequest();
        const target = resolveTargetRef.current();
        if (!target) {
            publishUnavailable(request);
            completeRequest(request);
            return;
        }
        commit({ ...current, phase: 'loading', unavailableReason: null, following: false });
        try {
            const result = await readRef.current({
                target,
                query: queryFor({
                    pluginId: pluginIdRef.current,
                    correlationId: current.correlationId,
                    cursor: current.cursor,
                    ...(logIdRef.current === null ? {} : { logId: logIdRef.current }),
                }),
                signal: request.controller.signal,
            });
            if (!isCurrent(request)) return;
            if (result.kind === 'unavailable') {
                publishUnavailable(
                    request,
                    result.code === 'plugin_log_reader_unavailable' ? 'readerUnavailable' : 'machineUnavailable',
                );
                return;
            }
            applyAvailablePage({
                request,
                result,
                append: true,
                following: false,
                requestedCursor: current.cursor,
            });
        } catch (error) {
            if (!isAbortError(error)) publishError(request);
        } finally {
            completeRequest(request);
        }
    }, [applyAvailablePage, beginRequest, commit, completeRequest, isCurrent, publishError, publishUnavailable]);

    const startFollowing = React.useCallback(async (): Promise<void> => {
        followRequestedRef.current = true;
        const request = beginRequest();
        const initial = stateRef.current;
        let cursor = initial.cursor ?? undefined;
        let append = cursor !== undefined;
        let waitForChanges = cursor !== undefined && !initial.hasMore;
        commit({
            ...initial,
            phase: cursor === undefined ? 'loading' : 'ready',
            unavailableReason: null,
            following: true,
        });
        try {
            while (isCurrent(request)) {
                const target = resolveTargetRef.current();
                if (!target) {
                    publishUnavailable(request);
                    return;
                }
                const result = await readRef.current({
                    target,
                    query: queryFor({
                        pluginId: pluginIdRef.current,
                        correlationId: stateRef.current.correlationId,
                        ...(cursor === undefined ? {} : { cursor }),
                        ...(logIdRef.current === null ? {} : { logId: logIdRef.current }),
                    }),
                    signal: request.controller.signal,
                    ...(waitForChanges ? { waitForChanges: true } : {}),
                });
                if (!isCurrent(request)) return;
                if (result.kind === 'unavailable') {
                    followRequestedRef.current = false;
                    publishUnavailable(
                        request,
                        result.code === 'plugin_log_reader_unavailable' ? 'readerUnavailable' : 'machineUnavailable',
                    );
                    return;
                }
                const requestedCursor = cursor;
                applyAvailablePage({
                    request,
                    result,
                    append,
                    following: true,
                    ...(requestedCursor === undefined ? {} : { requestedCursor }),
                });
                const madeProgress = requestedCursor === undefined || result.cursor !== requestedCursor;
                cursor = result.cursor;
                append = true;
                waitForChanges = !(result.hasMore && madeProgress);
            }
        } catch (error) {
            if (!isAbortError(error)) publishError(request);
        } finally {
            const stillCurrent = isCurrent(request);
            completeRequest(request);
            if (stillCurrent) {
                const current = stateRef.current;
                commit({ ...current, following: false });
            }
        }
    }, [applyAvailablePage, beginRequest, commit, completeRequest, isCurrent, publishError, publishUnavailable]);

    const stopFollowing = React.useCallback(() => {
        followRequestedRef.current = false;
        abortActive();
        const current = stateRef.current;
        commit({
            ...current,
            phase: current.phase === 'loading' && current.records.length === 0 ? 'idle' : current.phase,
            following: false,
        });
    }, [abortActive, commit]);

    const setCorrelationId = React.useCallback((value: string) => {
        const correlationId = value.trim();
        if (correlationId === stateRef.current.correlationId) return;
        followRequestedRef.current = false;
        abortActive();
        commit(initialState(correlationId));
    }, [abortActive, commit]);

    React.useEffect(() => {
        const ownerChanged = observedOwnerKeyRef.current !== ownerKey;
        observedOwnerKeyRef.current = ownerKey;
        if (!params.targetKey) {
            followRequestedRef.current = false;
            abortActive();
            if (ownerChanged) commit(initialState(stateRef.current.correlationId));
            return undefined;
        }
        if (ownerChanged) {
            followRequestedRef.current = false;
            // A machine/materialization change is a new authority. Never retain
            // a prior origin's records while its exact replacement is loading.
            abortActive();
            commit(initialState(stateRef.current.correlationId));
        }
        if (autoLoad) void refresh();
        return () => {
            abortActive();
        };
    }, [abortActive, autoLoad, commit, ownerKey, params.targetKey, refresh, state.correlationId]);

    React.useEffect(() => {
        const target = resolveTargetRef.current();
        if (!target || !params.subscribeToRecovery) return;
        return params.subscribeToRecovery(target, () => {
            if (followRequestedRef.current) void startFollowing();
        });
    }, [ownerKey, params.subscribeToRecovery, startFollowing]);

    // The owner transition is retired in a passive effect, but rendering the
    // replacement target must never expose the previous machine's window.
    const renderedState: PluginInvocationLogsControllerState = observedOwnerKeyRef.current !== ownerKey
        ? {
            ...initialState(state.correlationId),
            phase: ownerKey === null || !autoLoad ? 'idle' : 'loading',
        }
        : state;

    return React.useMemo(() => ({
        state: renderedState,
        refresh,
        loadMore,
        startFollowing,
        stopFollowing,
        setCorrelationId,
    }), [loadMore, refresh, renderedState, setCorrelationId, startFollowing, stopFollowing]);
}
