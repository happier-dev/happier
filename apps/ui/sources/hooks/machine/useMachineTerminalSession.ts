import * as React from 'react';
import { TERMINAL_STREAM_MAX_READ_BYTES, type DaemonTerminalLaunchIntent } from '@happier-dev/protocol';

import { createEmptyTerminalSurfaceState, readTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';
import {
    isRecoverableTerminalRpcError,
    isRecoverableTerminalSessionErrorCode,
    resolveTerminalAutoRetryDelayMs,
    safeTimeoutClear,
    safeTimeoutSet,
    TERMINAL_AUTO_RETRY_MAX_ATTEMPTS,
} from '@/components/sessions/terminal/terminalRpcRecovery';
import { useEmbeddedTerminalTransportHandlers } from '@/components/sessions/terminal/useEmbeddedTerminalTransportHandlers';
import { useTerminalSurfaceState } from '@/components/sessions/terminal/useTerminalSurfaceState';
import type {
    EmbeddedTerminalRendererHandle,
    EmbeddedTerminalWriteCompleteEvent,
} from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { resolveTerminalHyperlinkAction } from '@/components/terminal/interaction/links';
import {
    applyEmbeddedTerminalBellPolicy,
    applyEmbeddedTerminalTitlePolicy,
} from '@/components/terminal/interaction/title';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    createMachineRpcTerminalStreamCarrier,
    readTerminalStreamInputErrorCode,
} from '@/sync/domains/terminal/stream/carrier';
import {
    applyTerminalRendererAck,
    createTerminalStreamCreditState,
    type TerminalStreamCreditState,
} from '@/sync/domains/terminal/stream/credit';
import type { TerminalStreamCursor } from '@/sync/domains/terminal/stream/model';
import { resolveTerminalReplayPlan } from '@/sync/domains/terminal/stream/replay';
import { createTerminalStreamRuntime, createTerminalUtf8ProjectionDecoder } from '@/sync/domains/terminal/stream/runtime';
import { machineTerminalClose, machineTerminalEnsure, machineTerminalRestart } from '@/sync/ops/machineTerminal';
import { delay } from '@/utils/timing/time';

export type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'exited';

const embeddedTerminalRendererId = 'embedded-terminal';

type PendingRendererWrite = EmbeddedTerminalWriteCompleteEvent & Readonly<{
    previewText: string;
    nextCursor: TerminalStreamCursor;
}>;

export function useMachineTerminalSession(params: Readonly<{
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
    const byteStreamEnabled = useFeatureEnabled('terminal.transport.byteStream');
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

    const terminalIdRef = React.useRef<string | null>(initialSurfaceState.terminalId);
    const cursorRef = React.useRef(initialSurfaceState.cursor);
    const cursorModeRef = React.useRef<TerminalStreamCursor['mode']>('byte-offset');
    const terminalRendererHandleRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const terminalPreviewDecoderRef = React.useRef(createTerminalUtf8ProjectionDecoder());
    const terminalStreamCarrierRef = React.useRef<ReturnType<typeof createMachineRpcTerminalStreamCarrier> | null>(null);
    const terminalCreditStateRef = React.useRef<TerminalStreamCreditState | null>(null);
    const pendingRendererWriteRef = React.useRef<PendingRendererWrite | null>(null);
    const pendingWritePreviewTextRef = React.useRef(new Map<string, string>());
    const clearActiveTerminalStream = React.useCallback(() => {
        terminalStreamCarrierRef.current = null;
        terminalCreditStateRef.current = null;
        pendingRendererWriteRef.current = null;
        pendingWritePreviewTextRef.current.clear();
    }, []);
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

    const handleInputError = React.useCallback((inputError: unknown) => {
        const inputErrorCode = readTerminalStreamInputErrorCode(inputError);
        clearActiveTerminalStream();
        if (isRecoverableTerminalSessionErrorCode(inputErrorCode) && scheduleAutoRetry()) {
            return;
        }
        setStatus('error');
        setError(inputError instanceof Error && inputError.message
            ? inputError.message
            : inputErrorCode ?? 'terminal_input_failed');
    }, [clearActiveTerminalStream, scheduleAutoRetry]);
    const {
        detectedUrl,
        clearTerminalOutput,
        hydrateTerminalRendererIfNeeded,
        replaceSurfaceState,
        recordTerminalPreviewOutput,
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
        hydrateOnRender: false,
    });
    const { initialTerminalSize, latestTerminalSizeRef, onInput, onPaste, onResize, onReady } = useEmbeddedTerminalTransportHandlers({
        machineId: params.machineId,
        terminalIdRef,
        terminalStreamCarrierRef,
        onInputError: handleInputError,
    });

    const clearTerminal = React.useCallback(() => {
        terminalPreviewDecoderRef.current.reset();
        pendingRendererWriteRef.current = null;
        pendingWritePreviewTextRef.current.clear();
        clearTerminalOutput();
    }, [clearTerminalOutput]);

    const requestRestart = React.useCallback(() => {
        resetAutoRetryState();
        restartRequestedRef.current = true;
        terminalPreviewDecoderRef.current.reset();
        clearActiveTerminalStream();
        cursorModeRef.current = byteStreamEnabled ? 'byte-offset' : 'legacy-event-cursor';
        clearTerminalOutput();
        syncDetectedUrl(null);
        bumpConnectionNonce();
    }, [byteStreamEnabled, clearActiveTerminalStream, clearTerminalOutput, resetAutoRetryState, syncDetectedUrl]);

    const retryConnect = React.useCallback(() => {
        resetAutoRetryState();
        restartRequestedRef.current = false;
        bumpConnectionNonce();
    }, [resetAutoRetryState]);

    const onLink = React.useCallback((rawUrl: string) => {
        const action = resolveTerminalHyperlinkAction(rawUrl);
        if (action.kind === 'deny') {
            return;
        }
        syncDetectedUrl({
            t: 'url',
            url: action.url,
            kind: 'generic',
            suggestOpen: action.kind === 'allow',
        });
    }, [syncDetectedUrl]);

    const onTitle = React.useCallback((title: string) => {
        void applyEmbeddedTerminalTitlePolicy(title);
    }, []);

    const onBell = React.useCallback((label: string) => {
        void applyEmbeddedTerminalBellPolicy(label);
    }, []);

    React.useEffect(() => {
        return () => {
            safeTimeoutClear(autoRetryTimeoutRef.current);
            autoRetryTimeoutRef.current = null;
        };
    }, []);

    React.useEffect(() => {
        let canceled = false;

        const start = async () => {
            const cachedSurfaceState = readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState();

            setError(null);
            setStatus('connecting');

            if (!params.machineId || (!params.cwd && !params.launch)) {
                setStatus('error');
                setError('terminal_missing_machine_target');
                return;
            }
            if (params.machineRpcTargetAvailable === false) {
                setStatus('error');
                setError('terminal_rpc_target_unavailable');
                return;
            }
            if (params.machineReachable === false) {
                setStatus('error');
                setError('terminal_machine_unreachable');
                return;
            }
            if (!initialTerminalSize) {
                setStatus('connecting');
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
            const ensured = restartRequestedRef.current
                ? await machineTerminalRestart(params.machineId, request)
                : await machineTerminalEnsure(params.machineId, request);
            restartRequestedRef.current = false;

            if (canceled) return;
            if (!ensured.ok) {
                if (isRecoverableTerminalSessionErrorCode(ensured.errorCode) && scheduleAutoRetry()) {
                    return;
                }
                setStatus('error');
                setError(ensured.errorCode);
                return;
            }
            resetAutoRetryState();

            const replayPlan = resolveTerminalReplayPlan({
                cachedTerminalId: cachedSurfaceState.terminalId,
                ensuredTerminalId: ensured.terminalId,
                reused: ensured.reused,
                cachedOutput: cachedSurfaceState.output,
                cachedCursor: cachedSurfaceState.cursor,
            });
            terminalIdRef.current = ensured.terminalId;
            cursorRef.current = replayPlan.initialCursor;
            cursorModeRef.current = byteStreamEnabled ? 'byte-offset' : 'legacy-event-cursor';
            if (replayPlan.clearRenderer) {
                terminalPreviewDecoderRef.current.reset();
                terminalRendererHandleRef.current = params.terminalRef.current;
                params.terminalRef.current?.clear();
                replaceSurfaceState({
                    terminalId: ensured.terminalId,
                    cursor: replayPlan.initialCursor,
                    output: '',
                    detectedUrl: null,
                });
                setDetectedUrl(null);
            } else {
                replaceSurfaceState({
                    ...cachedSurfaceState,
                    terminalId: ensured.terminalId,
                    cursor: replayPlan.initialCursor,
                });
                hydrateTerminalRendererIfNeeded();
            }
            setStatus('connected');

            const carrier = createMachineRpcTerminalStreamCarrier({
                machineId: params.machineId,
            });
            terminalStreamCarrierRef.current = carrier;
            terminalCreditStateRef.current = byteStreamEnabled
                ? createTerminalStreamCreditState({
                    terminalId: ensured.terminalId,
                    rendererId: embeddedTerminalRendererId,
                    surfaceEpoch: connectionNonce,
                    ackedByteOffset: cursorRef.current,
                    creditBytes: TERMINAL_STREAM_MAX_READ_BYTES,
                })
                : null;
            const writeDecodedStreamProjection = (data: string) => {
                if (!data) {
                    return;
                }
                if (params.terminalRef.current?.writeBytes) {
                    recordTerminalPreviewOutput(data);
                    return;
                }
                writeTerminalOutput(data);
            };
            pendingRendererWriteRef.current = null;
            pendingWritePreviewTextRef.current.clear();
            const runtime = createTerminalStreamRuntime({
                terminalId: ensured.terminalId,
                rendererId: embeddedTerminalRendererId,
                surfaceEpoch: connectionNonce,
                renderer: {
                    write: writeTerminalOutput,
                    writeBytes: (input) => {
                        const decodedPreview = terminalPreviewDecoderRef.current.decode(input.bytes);
                        const renderer = params.terminalRef.current;
                        if (renderer?.writeBytes) {
                            const result = renderer.writeBytes(input);
                            if (result === false) {
                                return false;
                            }
                            if (isQueuedRendererWriteResult(result)) {
                                pendingWritePreviewTextRef.current.set(
                                    getRendererWriteKey(input),
                                    decodedPreview,
                                );
                                return result;
                            }
                            recordTerminalPreviewOutput(decodedPreview);
                            return result;
                        }
                        return writeTerminalOutput(decodedPreview);
                    },
                    clear: () => params.terminalRef.current?.clear(),
                    focus: () => params.terminalRef.current?.focus?.(),
                    hasSelection: () => params.terminalRef.current?.hasSelection?.() ?? false,
                    getSelectionText: () => params.terminalRef.current?.getSelectionText?.() ?? '',
                },
                onGap: () => {
                    terminalPreviewDecoderRef.current.reset();
                    writeTerminalOutput('\r\n[Output truncated]\r\n');
                },
                onUrl: (event) => {
                    syncDetectedUrl({
                        t: 'url',
                        url: event.url,
                        kind: event.kind,
                        suggestOpen: event.suggestOpen,
                    });
                },
                onExit: () => {
                    writeDecodedStreamProjection(terminalPreviewDecoderRef.current.flush());
                    setStatus('exited');
                },
            });
            let idleCount = 0;
            while (!canceled) {
                const terminalId = terminalIdRef.current;
                if (!terminalId) break;
                if (pendingRendererWriteRef.current) {
                    idleCount = Math.min(10, idleCount + 1);
                    await delay(Math.min(250, 60 + idleCount * 10));
                    continue;
                }
                const readClearNonce = clearNonceRef.current;

                const read = await carrier.read({
                    terminalId,
                    cursor: { mode: cursorModeRef.current, value: cursorRef.current },
                    ackedByteOffset: byteStreamEnabled ? terminalCreditStateRef.current?.ackedByteOffset : undefined,
                    creditBytes: byteStreamEnabled ? terminalCreditStateRef.current?.creditBytes : undefined,
                    rendererId: embeddedTerminalRendererId,
                    surfaceEpoch: connectionNonce,
                });
                if (canceled) return;

                if (!read.ok) {
                    clearActiveTerminalStream();
                    if (isRecoverableTerminalSessionErrorCode(read.code) && scheduleAutoRetry()) {
                        return;
                    }
                    setStatus('error');
                    setError(read.code);
                    return;
                }

                if (read.mode === 'legacy-event-cursor') {
                    terminalCreditStateRef.current = null;
                }

                if (readClearNonce !== clearNonceRef.current) {
                    const priorCursor = cursorRef.current;
                    cursorRef.current = read.nextCursor;
                    cursorModeRef.current = read.mode;
                    if (read.nextCursor !== priorCursor) {
                        updateSurfaceState((current) => ({
                            ...current,
                            terminalId,
                            cursor: read.nextCursor,
                        }));
                    }
                    if (read.frames.some((event) => event.t === 'exit') || read.done) {
                        setStatus('exited');
                        return;
                    }
                    idleCount = 0;
                    continue;
                }

                if (read.frames.length === 0) {
                    idleCount = Math.min(10, idleCount + 1);
                    await delay(Math.min(250, 60 + idleCount * 10));
                } else {
                    idleCount = 0;
                }

                const applied = runtime.applyFrames(read.frames);
                const priorCursor = cursorRef.current;
                if (applied.queuedWrite) {
                    const previewKey = getRendererWriteKey(applied.queuedWrite);
                    pendingRendererWriteRef.current = {
                        ...applied.queuedWrite,
                        previewText: pendingWritePreviewTextRef.current.get(previewKey) ?? '',
                        nextCursor: read.mode === 'legacy-event-cursor'
                            ? { mode: 'legacy-event-cursor', value: applied.queuedWrite.seq + 1 }
                            : {
                                mode: 'byte-offset',
                                value: Math.min(read.nextCursor, applied.queuedWrite.ackedByteOffset),
                            },
                    };
                    pendingWritePreviewTextRef.current.delete(previewKey);
                    idleCount = Math.min(10, idleCount + 1);
                    await delay(Math.min(250, 60 + idleCount * 10));
                    continue;
                }
                const nextCursor = read.mode === 'byte-offset' && applied.rejectedByteOffset !== null
                    ? applied.acceptedByteOffset ?? priorCursor
                    : read.mode === 'byte-offset' && applied.acceptedByteOffset !== null
                        ? Math.min(read.nextCursor, applied.acceptedByteOffset)
                        : read.nextCursor;
                cursorRef.current = nextCursor;
                cursorModeRef.current = read.mode;
                if (nextCursor !== priorCursor) {
                    updateSurfaceState((current) => ({
                        ...current,
                        terminalId,
                        cursor: nextCursor,
                    }));
                }

                if (read.mode === 'byte-offset' && applied.acceptedByteOffset !== null) {
                    const state = terminalCreditStateRef.current;
                    if (state) {
                        const ack = {
                            terminalId,
                            rendererId: embeddedTerminalRendererId,
                            surfaceEpoch: state.surfaceEpoch,
                            ackedByteOffset: applied.acceptedByteOffset,
                            creditBytes: state.creditBytes,
                        };
                        const ackResult = applyTerminalRendererAck(state, ack);
                        if (ackResult.accepted) {
                            terminalCreditStateRef.current = ackResult.state;
                            void carrier.acknowledge(ack);
                        }
                    }
                }

                if (applied.rejectedByteOffset !== null) {
                    idleCount = Math.min(10, idleCount + 1);
                    await delay(Math.min(250, 60 + idleCount * 10));
                    continue;
                }

                if (applied.status === 'exited') {
                    setStatus('exited');
                }

                if (read.done) {
                    setStatus('exited');
                    return;
                }
            }
        };

        void start().catch((e) => {
            if (canceled) return;
            clearActiveTerminalStream();
            if (isRecoverableTerminalRpcError(e) && scheduleAutoRetry()) {
                return;
            }
            setStatus('error');
            setError(e instanceof Error ? e.message : 'terminal_error');
        });

        return () => {
            canceled = true;
            clearActiveTerminalStream();
        };
    }, [
        connectionNonce,
        byteStreamEnabled,
        clearActiveTerminalStream,
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
        recordTerminalPreviewOutput,
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

    React.useEffect(() => {
        if (status !== 'connected' && status !== 'exited') {
            return;
        }
        hydrateTerminalRendererIfNeeded();
    });

    const dismissDetectedUrl = React.useCallback(() => {
        syncDetectedUrl(null);
    }, [syncDetectedUrl]);

    const onWriteComplete = React.useCallback((event: EmbeddedTerminalWriteCompleteEvent) => {
        const pendingWrite = pendingRendererWriteRef.current;
        if (!pendingWrite || !isMatchingRendererWrite(event, pendingWrite)) {
            return;
        }
        if (pendingWrite.previewText) {
            recordTerminalPreviewOutput(pendingWrite.previewText);
        }
        pendingRendererWriteRef.current = null;
        pendingWritePreviewTextRef.current.delete(getRendererWriteKey(pendingWrite));
        const nextCursor = pendingWrite.nextCursor.value;
        cursorModeRef.current = pendingWrite.nextCursor.mode;
        if (nextCursor !== cursorRef.current) {
            cursorRef.current = nextCursor;
            updateSurfaceState((current) => ({
                ...current,
                terminalId: event.terminalId,
                cursor: nextCursor,
            }));
        }

        const state = terminalCreditStateRef.current;
        const carrier = terminalStreamCarrierRef.current;
        if (!state || !carrier || event.terminalId !== terminalIdRef.current) {
            return;
        }
        const ack = {
            terminalId: event.terminalId,
            rendererId: embeddedTerminalRendererId,
            surfaceEpoch: state.surfaceEpoch,
            ackedByteOffset: event.ackedByteOffset,
            creditBytes: state.creditBytes,
        };
        const result = applyTerminalRendererAck(state, ack);
        if (!result.accepted) {
            return;
        }
        terminalCreditStateRef.current = result.state;
        void carrier.acknowledge(ack);
    }, [recordTerminalPreviewOutput, updateSurfaceState]);

    return {
        status,
        error,
        detectedUrl,
        onInput,
        onPaste,
        onLink,
        onTitle,
        onBell,
        onResize,
        onReady,
        clearTerminal,
        requestRestart,
        retryConnect,
        dismissDetectedUrl,
        onWriteComplete,
    } as const;
}

function isQueuedRendererWriteResult(
    result: ReturnType<NonNullable<EmbeddedTerminalRendererHandle['writeBytes']>>,
): result is Readonly<{ status: 'queued' }> {
    return typeof result === 'object' && result !== null && result.status === 'queued';
}

function getRendererWriteKey(input: Pick<EmbeddedTerminalWriteCompleteEvent, 'terminalId' | 'seq' | 'byteOffset' | 'writeGeneration'>): string {
    return `${input.terminalId}:${input.seq}:${input.byteOffset}:${input.writeGeneration}`;
}

function isMatchingRendererWrite(
    event: EmbeddedTerminalWriteCompleteEvent,
    pending: EmbeddedTerminalWriteCompleteEvent,
): boolean {
    return event.terminalId === pending.terminalId
        && event.seq === pending.seq
        && event.byteOffset === pending.byteOffset
        && event.byteLength === pending.byteLength
        && event.ackedByteOffset === pending.ackedByteOffset
        && event.writeGeneration === pending.writeGeneration;
}
