import * as React from 'react';

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

export type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'exited';

export function useMachineTerminalSession(params: Readonly<{
    machineId: string | null;
    cwd: string | null;
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

    const [status, setStatus] = React.useState<TerminalStatus>('idle');
    const [error, setError] = React.useState<string | null>(null);

    const [connectionNonce, bumpConnectionNonce] = React.useReducer((x: number) => x + 1, 0);
    const restartRequestedRef = React.useRef(false);
    const autoRetryAttemptRef = React.useRef(0);
    const autoRetryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearNonceRef = React.useRef(0);
    const terminalReaderOwnerTokenRef = React.useRef(Symbol(params.terminalKey));
    const ignoreNextLeaseAvailabilityRef = React.useRef(false);

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
        setError(null);
        setStatus('connecting');
        return true;
    }, []);

    const requestRestart = React.useCallback(() => {
        resetAutoRetryState();
        restartRequestedRef.current = true;
        clearTerminalOutput();
        syncDetectedUrl(null);
        bumpConnectionNonce();
    }, [clearTerminalOutput, resetAutoRetryState, syncDetectedUrl]);

    const retryConnect = React.useCallback(() => {
        resetAutoRetryState();
        restartRequestedRef.current = false;
        bumpConnectionNonce();
    }, [resetAutoRetryState]);

    React.useEffect(() => {
        return () => {
            safeTimeoutClear(autoRetryTimeoutRef.current);
            autoRetryTimeoutRef.current = null;
        };
    }, []);

    React.useEffect(() => {
        terminalReaderOwnerTokenRef.current = Symbol(params.terminalKey);
    }, [params.terminalKey]);

    React.useEffect(() => {
        return subscribeTerminalReaderLeaseAvailability(params.terminalKey, () => {
            if (ignoreNextLeaseAvailabilityRef.current) {
                ignoreNextLeaseAvailabilityRef.current = false;
                return;
            }
            if (!hasTerminalReaderLease(params.terminalKey, terminalReaderOwnerTokenRef.current)) {
                bumpConnectionNonce();
            }
        });
    }, [params.terminalKey]);

    React.useEffect(() => {
        return () => {
            releaseTerminalReaderLease(params.terminalKey, terminalReaderOwnerTokenRef.current);
        };
    }, [params.terminalKey]);

    React.useEffect(() => {
        let canceled = false;
        let readerLeaseReleased = false;

        const releaseReaderLease = () => {
            if (readerLeaseReleased) {
                return;
            }
            readerLeaseReleased = true;
            ignoreNextLeaseAvailabilityRef.current = true;
            releaseTerminalReaderLease(params.terminalKey, terminalReaderOwnerTokenRef.current);
        };

        const failTerminalSession = (errorCode: string) => {
            releaseReaderLease();
            setStatus('error');
            setError(errorCode);
        };

        const exitTerminalSession = () => {
            releaseReaderLease();
            setStatus('exited');
            setError(null);
        };

        const start = async () => {
            const previousTerminalId = terminalIdRef.current;
            const previousCursor = cursorRef.current;
            const cachedSurfaceState = readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState();

            if (!claimTerminalReaderLease(params.terminalKey, terminalReaderOwnerTokenRef.current)) {
                terminalIdRef.current = cachedSurfaceState.terminalId;
                cursorRef.current = cachedSurfaceState.cursor;
                setError(null);
                setStatus(cachedSurfaceState.terminalId ? 'connected' : 'connecting');
                hydrateTerminalRendererIfNeeded();
                return;
            }

            setError(null);
            setStatus('connecting');

            if (!params.machineId || !params.cwd) {
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
            if (!initialTerminalSize) {
                setStatus('connecting');
                return;
            }

            const terminalSize = latestTerminalSizeRef.current ?? initialTerminalSize;

            const ensured = restartRequestedRef.current
                ? await machineTerminalRestart(params.machineId, {
                    terminalKey: params.terminalKey,
                    cwd: params.cwd,
                    cols: terminalSize.cols,
                    rows: terminalSize.rows,
                    initialCommand: params.initialCommand ?? undefined,
                })
                : await machineTerminalEnsure(params.machineId, {
                    terminalKey: params.terminalKey,
                    cwd: params.cwd,
                    cols: terminalSize.cols,
                    rows: terminalSize.rows,
                    initialCommand: params.initialCommand ?? undefined,
                });
            restartRequestedRef.current = false;

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
            setStatus('connected');

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
        connectionNonce,
        hydrateTerminalRendererIfNeeded,
        initialTerminalSize,
        latestTerminalSizeRef,
        params.cwd,
        params.initialCommand,
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
