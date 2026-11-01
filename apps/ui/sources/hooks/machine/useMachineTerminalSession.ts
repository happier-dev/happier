import * as React from 'react';
import type { DaemonTerminalLaunchIntent } from '@happier-dev/protocol';

import { createEmptyTerminalSurfaceState, readTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';
import {
    isRecoverableTerminalRpcError,
    isRecoverableTerminalSessionErrorCode,
    resolveTerminalAutoRetryDelayMs,
    safeTimeoutClear,
    safeTimeoutSet,
    TERMINAL_AUTO_RETRY_MAX_ATTEMPTS,
} from '@/components/sessions/terminal/terminalRpcRecovery';
import {
    claimTerminalReaderLease,
    hasTerminalReaderLease,
    publishTerminalReaderConnection,
    readTerminalReaderConnection,
    reconnectTerminalReader,
    subscribeTerminalReaderConnection,
    releaseTerminalReaderLease,
    subscribeTerminalReaderLeaseAvailability,
} from '@/components/sessions/terminal/terminalReaderLeaseRegistry';
import { useEmbeddedTerminalTransportHandlers } from '@/components/sessions/terminal/useEmbeddedTerminalTransportHandlers';
import { useTerminalSurfaceState } from '@/components/sessions/terminal/useTerminalSurfaceState';
import type { EmbeddedTerminalRendererHandle } from '@/components/sessions/terminal/embeddedTerminalRendererHandle';
import {
    machineTerminalClose,
    machineTerminalEnsure,
    machineTerminalRestart,
    machineTerminalStreamRead,
} from '@/sync/ops/machineTerminal';
import { delay } from '@/utils/timing/time';

import type { EmbeddedTerminalPaneStatus as TerminalStatus } from '@/components/terminal/embedded/types';
export type { EmbeddedTerminalPaneStatus as TerminalStatus } from '@/components/terminal/embedded/types';

export function useMachineTerminalSession(params: Readonly<{
    active?: boolean;
    machineId: string | null;
    cwd: string | null;
    launch?: DaemonTerminalLaunchIntent | null;
    machineReachable?: boolean;
    machineRpcTargetAvailable?: boolean;
    terminalKey: string;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    initialCommand?: string | null;
    closeOnUnmount?: boolean;
}>) {
    const initialSurfaceState = React.useMemo(
        () => readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState(),
        [params.terminalKey],
    );

    const active = params.active !== false;
    const ownerToken = React.useMemo(() => Symbol(params.terminalKey), [params.terminalKey]);
    const subscribeConnection = React.useCallback(
        (listener: () => void) => subscribeTerminalReaderConnection(params.terminalKey, listener),
        [params.terminalKey],
    );
    const readConnection = React.useCallback(() => readTerminalReaderConnection(params.terminalKey), [params.terminalKey]);
    const { status, error } = React.useSyncExternalStore(subscribeConnection, readConnection, readConnection);
    const publishConnection = React.useCallback((status: TerminalStatus, error: string | null = null) => {
        publishTerminalReaderConnection(params.terminalKey, ownerToken, { status, error });
    }, [ownerToken, params.terminalKey]);

    const [connectionNonce, bumpConnectionNonce] = React.useReducer((x: number) => x + 1, 0);
    const restartRequestedRef = React.useRef(false);
    const autoRetryAttemptRef = React.useRef(0);
    const autoRetryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearNonceRef = React.useRef(0);

    const terminalIdRef = React.useRef<string | null>(initialSurfaceState.terminalId);
    const cursorRef = React.useRef(initialSurfaceState.cursor);
    const terminalRendererHandleRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const {
        detectedUrl,
        clearTerminalOutput,
        hydrateTerminalRendererIfNeeded,
        replaceSurfaceState,
        setDetectedUrl,
        syncDetectedUrl,
        updateSurfaceState,
        writeTerminalOutput,
    } = useTerminalSurfaceState({
        terminalKey: params.terminalKey,
        terminalRef: params.terminalRef,
        terminalIdRef,
        cursorRef,
        terminalRendererHandleRef,
        clearNonceRef,
    });
    const { initialTerminalSize, latestTerminalSizeRef, onInput, onResize, onReady } = useEmbeddedTerminalTransportHandlers({
        machineId: params.machineId,
        terminalIdRef,
    });

    const clearTerminal = React.useCallback(() => {
        clearTerminalOutput();
    }, [clearTerminalOutput]);

    const resetAutoRetryState = React.useCallback(() => {
        autoRetryAttemptRef.current = 0;
        safeTimeoutClear(autoRetryTimeoutRef.current);
        autoRetryTimeoutRef.current = null;
    }, []);

    const scheduleAutoRetry = React.useCallback(() => {
        const nextAttempt = autoRetryAttemptRef.current + 1;
        if (nextAttempt > TERMINAL_AUTO_RETRY_MAX_ATTEMPTS) {
            return false;
        }

        autoRetryAttemptRef.current = nextAttempt;
        safeTimeoutClear(autoRetryTimeoutRef.current);
        autoRetryTimeoutRef.current = safeTimeoutSet(() => {
            autoRetryTimeoutRef.current = null;
            bumpConnectionNonce();
        }, resolveTerminalAutoRetryDelayMs(nextAttempt));
        publishConnection('connecting');
        return true;
    }, [publishConnection]);

    const reconnect = React.useCallback((restart: boolean) => {
        resetAutoRetryState();
        restartRequestedRef.current = restart;
        if (restart) {
            clearTerminalOutput();
            syncDetectedUrl(null);
        }
        bumpConnectionNonce();
    }, [clearTerminalOutput, resetAutoRetryState, syncDetectedUrl]);

    const requestRestart = React.useCallback(() => {
        if (!reconnectTerminalReader(params.terminalKey, true)) reconnect(true);
    }, [params.terminalKey, reconnect]);

    const retryConnect = React.useCallback(() => {
        if (!reconnectTerminalReader(params.terminalKey, false)) reconnect(false);
    }, [params.terminalKey, reconnect]);

    React.useEffect(() => {
        if (!active || !initialTerminalSize) return;
        return subscribeTerminalReaderLeaseAvailability(params.terminalKey, () => {
            if (!hasTerminalReaderLease(params.terminalKey, ownerToken)) bumpConnectionNonce();
        });
    }, [active, initialTerminalSize, ownerToken, params.terminalKey]);

    React.useEffect(() => {
        return () => {
            resetAutoRetryState();
            releaseTerminalReaderLease(params.terminalKey, ownerToken);
        };
    }, [active, ownerToken, params.terminalKey, resetAutoRetryState]);

    React.useEffect(() => {
        let canceled = false;

        const failTerminalSession = (errorCode: string) => {
            publishConnection('error', errorCode);
            releaseTerminalReaderLease(params.terminalKey, ownerToken);
        };

        const exitTerminalSession = () => {
            publishConnection('exited');
            releaseTerminalReaderLease(params.terminalKey, ownerToken);
        };

        const start = async () => {
            if (!active || !initialTerminalSize) return;
            const previousTerminalId = terminalIdRef.current;
            const previousCursor = cursorRef.current;
            const cachedSurfaceState = readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState();

            if (!claimTerminalReaderLease(params.terminalKey, ownerToken, reconnect)) {
                terminalIdRef.current = cachedSurfaceState.terminalId;
                cursorRef.current = cachedSurfaceState.cursor;
                hydrateTerminalRendererIfNeeded();
                return;
            }

            publishConnection('connecting');

            if (!params.machineId || (!params.cwd && !params.launch)) {
                failTerminalSession('terminal_missing_machine_target');
                return;
            }
            if (params.machineRpcTargetAvailable === false) {
                failTerminalSession('terminal_rpc_target_unavailable');
                return;
            }
            if (params.machineReachable === false) {
                failTerminalSession('terminal_machine_unreachable');
                return;
            }

            const terminalSize = latestTerminalSizeRef.current ?? initialTerminalSize;

            const request = params.launch
                ? {
                    terminalKey: params.terminalKey,
                    cols: terminalSize.cols,
                    rows: terminalSize.rows,
                    launch: params.launch,
                }
                : {
                    terminalKey: params.terminalKey,
                    cwd: params.cwd!,
                    cols: terminalSize.cols,
                    rows: terminalSize.rows,
                    initialCommand: params.initialCommand ?? undefined,
                };
            const restartRequested = restartRequestedRef.current;
            restartRequestedRef.current = false;
            const ensured = restartRequested
                ? await machineTerminalRestart(params.machineId, request)
                : await machineTerminalEnsure(params.machineId, request);

            if (canceled) return;
            if (!ensured.ok) {
                if (isRecoverableTerminalSessionErrorCode(ensured.errorCode) && scheduleAutoRetry()) {
                    return;
                }
                failTerminalSession(ensured.errorCode);
                return;
            }
            resetAutoRetryState();

            const terminalIdChanged = ensured.terminalId !== previousTerminalId;
            const shouldPreserveReusedSurfaceState = ensured.reused
                && previousTerminalId === null
                && (previousCursor > 0 || cachedSurfaceState.output.length > 0);
            terminalIdRef.current = ensured.terminalId;
            if (terminalIdChanged && !shouldPreserveReusedSurfaceState) {
                cursorRef.current = 0;
                terminalRendererHandleRef.current = params.terminalRef.current;
                params.terminalRef.current?.clear();
                replaceSurfaceState({
                    terminalId: ensured.terminalId,
                    cursor: 0,
                    output: '',
                    detectedUrl: null,
                });
                setDetectedUrl(null);
            } else {
                cursorRef.current = previousCursor;
                replaceSurfaceState({
                    ...cachedSurfaceState,
                    terminalId: ensured.terminalId,
                    cursor: previousCursor,
                });
                hydrateTerminalRendererIfNeeded();
            }
            publishConnection('connected');

            let idleCount = 0;
            while (!canceled) {
                const terminalId = terminalIdRef.current;
                if (!terminalId) break;
                const readClearNonce = clearNonceRef.current;

                const read = await machineTerminalStreamRead(params.machineId, {
                    terminalId,
                    cursor: cursorRef.current,
                });
                if (canceled) return;

                if (!read.ok) {
                    if (isRecoverableTerminalSessionErrorCode(read.errorCode) && scheduleAutoRetry()) {
                        return;
                    }
                    failTerminalSession(read.errorCode);
                    return;
                }

                const priorCursor = cursorRef.current;
                cursorRef.current = read.nextCursor;
                if (read.nextCursor !== priorCursor) {
                    updateSurfaceState((current) => ({
                        ...current,
                        terminalId,
                        cursor: read.nextCursor,
                    }));
                }

                if (readClearNonce !== clearNonceRef.current) {
                    if (read.events.some((event) => event.t === 'exit') || read.done) {
                        exitTerminalSession();
                        return;
                    }
                    idleCount = 0;
                    continue;
                }

                if (read.events.length === 0) {
                    idleCount = Math.min(10, idleCount + 1);
                    await delay(Math.min(250, 60 + idleCount * 10));
                } else {
                    idleCount = 0;
                }

                let sawExit = false;
                for (const event of read.events) {
                    if (event.t === 'data') {
                        writeTerminalOutput(event.data);
                    } else if (event.t === 'gap') {
                        writeTerminalOutput('\r\n[Output truncated]\r\n');
                    } else if (event.t === 'url') {
                        syncDetectedUrl(event);
                    } else if (event.t === 'exit') {
                        sawExit = true;
                    }
                }

                if (sawExit || read.done) {
                    exitTerminalSession();
                    return;
                }
            }
        };

        void start().catch((e) => {
            if (canceled) return;
            if (isRecoverableTerminalRpcError(e) && scheduleAutoRetry()) {
                return;
            }
            failTerminalSession(e instanceof Error ? e.message : 'terminal_error');
        });

        return () => {
            canceled = true;
        };
    }, [
        active,
        ownerToken,
        publishConnection,
        reconnect,
        connectionNonce,
        hydrateTerminalRendererIfNeeded,
        initialTerminalSize,
        latestTerminalSizeRef,
        params.cwd,
        params.initialCommand,
        params.launch,
        params.machineId,
        params.machineReachable,
        params.machineRpcTargetAvailable,
        params.terminalKey,
        params.terminalRef,
        replaceSurfaceState,
        resetAutoRetryState,
        scheduleAutoRetry,
        setDetectedUrl,
        syncDetectedUrl,
        updateSurfaceState,
        writeTerminalOutput,
    ]);

    React.useEffect(() => {
        return () => {
            if (!params.closeOnUnmount || !params.machineId || !terminalIdRef.current) return;
            void machineTerminalClose(params.machineId, { terminalId: terminalIdRef.current });
        };
    }, [params.closeOnUnmount, params.machineId]);

    const dismissDetectedUrl = React.useCallback(() => {
        syncDetectedUrl(null);
    }, [syncDetectedUrl]);

    return {
        status,
        error,
        detectedUrl,
        onInput,
        onResize,
        onReady,
        clearTerminal,
        requestRestart,
        retryConnect,
        dismissDetectedUrl,
    } as const;
}
