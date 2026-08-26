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
    sanitizeTerminalBell,
    sanitizeTerminalTitle,
} from '@/components/terminal/interaction/title';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
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
import type {
    TerminalStreamCursor,
    TerminalStreamFrame,
} from '@/sync/domains/terminal/stream/model';
import { resolveTerminalReplayPlan } from '@/sync/domains/terminal/stream/replay';
import {
    createTerminalStreamRuntime,
    createTerminalUtf8ProjectionDecoder,
    type TerminalStreamRuntime,
} from '@/sync/domains/terminal/stream/runtime';
import { machineTerminalClose, machineTerminalEnsure, machineTerminalRestart } from '@/sync/ops/machineTerminal';
import { delay } from '@/utils/timing/time';

export type TerminalStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'exited';

const embeddedTerminalRendererId = 'embedded-terminal';

type PendingRendererWrite = EmbeddedTerminalWriteCompleteEvent & Readonly<{
    previewBytes: Uint8Array;
    nextCursor: TerminalStreamCursor;
    deferredFrames: readonly TerminalStreamFrame[];
    responseCursor: TerminalStreamCursor;
    responseDone: boolean;
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
    const [terminalTitle, setTerminalTitle] = React.useState<string | null>(null);
    const [terminalBell, setTerminalBell] = React.useState<string | null>(null);

    const [connectionNonce, bumpConnectionNonce] = React.useReducer((x: number) => x + 1, 0);
    const restartRequestedRef = React.useRef(false);
    const autoRetryAttemptRef = React.useRef(0);
    const autoRetryTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearNonceRef = React.useRef(0);

    const terminalIdRef = React.useRef<string | null>(initialSurfaceState.terminalId);
    const cursorRef = React.useRef(initialSurfaceState.cursor);
    const cursorModeRef = React.useRef<TerminalStreamCursor['mode']>(initialSurfaceState.cursorMode);
    const terminalRendererHandleRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const terminalPreviewDecoderRef = React.useRef(createTerminalUtf8ProjectionDecoder());
    const terminalStreamCarrierRef = React.useRef<ReturnType<typeof createMachineRpcTerminalStreamCarrier> | null>(null);
    const terminalStreamRuntimeRef = React.useRef<TerminalStreamRuntime | null>(null);
    const terminalCreditStateRef = React.useRef<TerminalStreamCreditState | null>(null);
    const pendingRendererWriteRef = React.useRef<PendingRendererWrite | null>(null);
    const pendingWritePreviewBytesRef = React.useRef(new Map<string, Uint8Array>());
    const replaceCachedPreviewOnReplayRef = React.useRef(false);
    const terminalStreamDoneRef = React.useRef(false);
    const clearActiveTerminalStream = React.useCallback(() => {
        terminalStreamCarrierRef.current = null;
        terminalStreamRuntimeRef.current = null;
        terminalCreditStateRef.current = null;
        pendingRendererWriteRef.current = null;
        pendingWritePreviewBytesRef.current.clear();
        replaceCachedPreviewOnReplayRef.current = false;
        terminalStreamDoneRef.current = false;
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
    const acknowledgeAcceptedBytes = React.useCallback((input: Readonly<{
        terminalId: string;
        ackedByteOffset: number;
        writeGeneration?: number;
    }>) => {
        const state = terminalCreditStateRef.current;
        const carrier = terminalStreamCarrierRef.current;
        if (!state || !carrier || input.terminalId !== terminalIdRef.current) {
            return;
        }
        if (input.writeGeneration !== undefined && state.surfaceEpoch !== input.writeGeneration) {
            return;
        }
        const ack = {
            terminalId: input.terminalId,
            rendererId: embeddedTerminalRendererId,
            surfaceEpoch: state.surfaceEpoch,
            ackedByteOffset: input.ackedByteOffset,
            creditBytes: state.creditBytes,
        };
        const result = applyTerminalRendererAck(state, ack);
        if (!result.accepted) {
            return;
        }
        terminalCreditStateRef.current = result.state;
        void carrier.acknowledge(ack);
    }, []);
    const replaceCachedPreviewWithReplay = React.useCallback((terminalId: string) => {
        if (!replaceCachedPreviewOnReplayRef.current) {
            return;
        }
        replaceCachedPreviewOnReplayRef.current = false;
        terminalPreviewDecoderRef.current.reset();
        const renderer = params.terminalRef.current;
        if (renderer) {
            terminalRendererHandleRef.current = renderer;
            renderer.clear();
        }
        updateSurfaceState((current) => ({
            ...current,
            terminalId,
            cursor: cursorRef.current,
            cursorMode: cursorModeRef.current,
            output: '',
        }));
    }, [params.terminalRef, terminalRendererHandleRef, updateSurfaceState]);
    const { initialTerminalSize, latestTerminalSizeRef, onInput, onPaste, onResize, onReady } = useEmbeddedTerminalTransportHandlers({
        machineId: params.machineId,
        terminalIdRef,
        terminalStreamCarrierRef,
        onInputError: handleInputError,
    });

    const clearTerminal = React.useCallback(() => {
        terminalPreviewDecoderRef.current.reset();
        pendingRendererWriteRef.current = null;
        pendingWritePreviewBytesRef.current.clear();
        replaceCachedPreviewOnReplayRef.current = false;
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
        const sanitized = sanitizeTerminalTitle(title);
        void applyEmbeddedTerminalTitlePolicy(sanitized);
        setTerminalTitle(sanitized || null);
    }, []);

    const onBell = React.useCallback((label: string) => {
        const sanitized = sanitizeTerminalBell(label);
        void applyEmbeddedTerminalBellPolicy(sanitized);
        setTerminalBell(sanitized || null);
    }, []);

    const copySelection = React.useCallback((request?: Readonly<{
        source: 'user-selection' | 'remote-osc52';
        text: string;
    }>) => {
        if (request?.source === 'remote-osc52') return;
        const text = request?.text ?? (params.terminalRef.current?.hasSelection?.()
            ? params.terminalRef.current.getSelectionText?.() ?? ''
            : '');
        if (text) void setClipboardStringSafe(text);
    }, [params.terminalRef]);

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

            const replayMode: TerminalStreamCursor['mode'] = byteStreamEnabled
                ? 'byte-offset'
                : 'legacy-event-cursor';
            const replayPlan = resolveTerminalReplayPlan({
                cachedTerminalId: cachedSurfaceState.terminalId,
                ensuredTerminalId: ensured.terminalId,
                reused: ensured.reused,
                cachedOutput: cachedSurfaceState.output,
                cachedCursor: {
                    mode: cachedSurfaceState.cursorMode,
                    value: cachedSurfaceState.cursor,
                },
                replayMode,
            });
            terminalIdRef.current = ensured.terminalId;
            cursorRef.current = replayPlan.initialCursor.value;
            cursorModeRef.current = replayPlan.initialCursor.mode;
            replaceCachedPreviewOnReplayRef.current = replayPlan.replacePreviewOnReplay;
            terminalStreamDoneRef.current = false;
            if (replayPlan.clearRenderer) {
                terminalPreviewDecoderRef.current.reset();
                terminalRendererHandleRef.current = params.terminalRef.current;
                params.terminalRef.current?.clear();
                replaceSurfaceState({
                    terminalId: ensured.terminalId,
                    cursor: replayPlan.initialCursor.value,
                    cursorMode: replayPlan.initialCursor.mode,
                    output: '',
                    detectedUrl: null,
                });
                setDetectedUrl(null);
            } else {
                replaceSurfaceState({
                    ...cachedSurfaceState,
                    terminalId: ensured.terminalId,
                    cursor: replayPlan.initialCursor.value,
                    cursorMode: replayPlan.initialCursor.mode,
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
            pendingWritePreviewBytesRef.current.clear();
            const runtime = createTerminalStreamRuntime({
                terminalId: ensured.terminalId,
                rendererId: embeddedTerminalRendererId,
                surfaceEpoch: connectionNonce,
                renderer: {
                    write: writeTerminalOutput,
                    writeBytes: (input) => {
                        const renderer = params.terminalRef.current;
                        if (renderer?.writeBytes) {
                            const result = renderer.writeBytes(input);
                            if (result === false) {
                                return false;
                            }
                            if (isQueuedRendererWriteResult(result)) {
                                pendingWritePreviewBytesRef.current.set(
                                    getRendererWriteKey(input),
                                    input.bytes,
                                );
                                return result;
                            }
                            const decodedPreview = terminalPreviewDecoderRef.current.decode(input.bytes);
                            recordTerminalPreviewOutput(decodedPreview);
                            return result;
                        }
                        const decodedPreview = terminalPreviewDecoderRef.current.decode(input.bytes);
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
                    terminalStreamDoneRef.current = true;
                    setStatus('exited');
                },
            });
            terminalStreamRuntimeRef.current = runtime;
            let idleCount = 0;
            while (!canceled) {
                if (terminalStreamDoneRef.current) {
                    return;
                }
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
                    const priorCursorMode = cursorModeRef.current;
                    cursorRef.current = read.nextCursor;
                    cursorModeRef.current = read.mode;
                    if (read.nextCursor !== priorCursor || read.mode !== priorCursorMode) {
                        updateSurfaceState((current) => ({
                            ...current,
                            terminalId,
                            cursor: read.nextCursor,
                            cursorMode: read.mode,
                        }));
                    }
                    if (read.frames.some((event) => event.t === 'exit') || read.done) {
                        terminalStreamDoneRef.current = true;
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

                if (containsTerminalReplayOutput(read.frames, terminalId)) {
                    replaceCachedPreviewWithReplay(terminalId);
                }
                const applied = runtime.applyFrames(read.frames);
                const priorCursor = cursorRef.current;
                if (applied.queuedWrite) {
                    if (read.mode === 'byte-offset' && applied.acceptedByteOffset !== null) {
                        const acceptedCursor = Math.min(read.nextCursor, applied.acceptedByteOffset);
                        const priorAcceptedCursor = cursorRef.current;
                        const priorAcceptedCursorMode = cursorModeRef.current;
                        cursorRef.current = acceptedCursor;
                        cursorModeRef.current = read.mode;
                        if (acceptedCursor !== priorAcceptedCursor || read.mode !== priorAcceptedCursorMode) {
                            updateSurfaceState((current) => ({
                                ...current,
                                terminalId,
                                cursor: acceptedCursor,
                                cursorMode: read.mode,
                            }));
                        }
                        acknowledgeAcceptedBytes({ terminalId, ackedByteOffset: applied.acceptedByteOffset });
                    }
                    const previewKey = getRendererWriteKey(applied.queuedWrite);
                    pendingRendererWriteRef.current = {
                        ...applied.queuedWrite,
                        previewBytes: pendingWritePreviewBytesRef.current.get(previewKey) ?? new Uint8Array(),
                        nextCursor: read.mode === 'legacy-event-cursor'
                            ? { mode: 'legacy-event-cursor', value: applied.queuedWrite.seq + 1 }
                            : {
                                mode: 'byte-offset',
                                value: Math.min(read.nextCursor, applied.queuedWrite.ackedByteOffset),
                            },
                        deferredFrames: applied.deferredFrames ?? [],
                        responseCursor: { mode: read.mode, value: read.nextCursor },
                        responseDone: read.done,
                    };
                    pendingWritePreviewBytesRef.current.delete(previewKey);
                    idleCount = Math.min(10, idleCount + 1);
                    await delay(Math.min(250, 60 + idleCount * 10));
                    continue;
                }
                const nextCursor = read.mode === 'byte-offset' && applied.rejectedByteOffset !== null
                    ? applied.acceptedByteOffset ?? priorCursor
                    : read.mode === 'byte-offset' && applied.acceptedByteOffset !== null
                        ? Math.min(read.nextCursor, applied.acceptedByteOffset)
                        : read.nextCursor;
                const priorCursorMode = cursorModeRef.current;
                cursorRef.current = nextCursor;
                cursorModeRef.current = read.mode;
                if (nextCursor !== priorCursor || read.mode !== priorCursorMode) {
                    updateSurfaceState((current) => ({
                        ...current,
                        terminalId,
                        cursor: nextCursor,
                        cursorMode: read.mode,
                    }));
                }

                if (read.mode === 'byte-offset' && applied.acceptedByteOffset !== null) {
                    acknowledgeAcceptedBytes({ terminalId, ackedByteOffset: applied.acceptedByteOffset });
                }

                if (applied.rejectedByteOffset !== null) {
                    idleCount = Math.min(10, idleCount + 1);
                    await delay(Math.min(250, 60 + idleCount * 10));
                    continue;
                }

                if (applied.status === 'exited') {
                    terminalStreamDoneRef.current = true;
                    setStatus('exited');
                    return;
                }

                if (read.done) {
                    terminalStreamDoneRef.current = true;
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
        acknowledgeAcceptedBytes,
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
        replaceCachedPreviewWithReplay,
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
        const runtime = terminalStreamRuntimeRef.current;
        if (!pendingWrite || !runtime || !isMatchingRendererWriteIdentity(event, pendingWrite)) {
            return;
        }
        const expectedAckedByteOffset = pendingWrite.byteOffset + pendingWrite.byteLength;
        if (event.ackedByteOffset > expectedAckedByteOffset) {
            return;
        }
        pendingRendererWriteRef.current = null;
        pendingWritePreviewBytesRef.current.delete(getRendererWriteKey(pendingWrite));
        if (event.ackedByteOffset < expectedAckedByteOffset) {
            const retryCursor = pendingWrite.nextCursor.mode === 'byte-offset'
                ? pendingWrite.byteOffset
                : cursorRef.current;
            const priorCursor = cursorRef.current;
            const priorCursorMode = cursorModeRef.current;
            cursorRef.current = retryCursor;
            cursorModeRef.current = pendingWrite.nextCursor.mode;
            if (retryCursor !== priorCursor || pendingWrite.nextCursor.mode !== priorCursorMode) {
                updateSurfaceState((current) => ({
                    ...current,
                    terminalId: event.terminalId,
                    cursor: retryCursor,
                    cursorMode: pendingWrite.nextCursor.mode,
                }));
            }
            return;
        }
        if (pendingWrite.previewBytes.byteLength > 0) {
            recordTerminalPreviewOutput(terminalPreviewDecoderRef.current.decode(pendingWrite.previewBytes));
        }
        const nextCursor = pendingWrite.nextCursor.value;
        const priorPendingCursor = cursorRef.current;
        const priorPendingCursorMode = cursorModeRef.current;
        cursorRef.current = nextCursor;
        cursorModeRef.current = pendingWrite.nextCursor.mode;
        if (nextCursor !== priorPendingCursor || pendingWrite.nextCursor.mode !== priorPendingCursorMode) {
            updateSurfaceState((current) => ({
                ...current,
                terminalId: event.terminalId,
                cursor: nextCursor,
                cursorMode: pendingWrite.nextCursor.mode,
            }));
        }
        acknowledgeAcceptedBytes({
            terminalId: event.terminalId,
            ackedByteOffset: event.ackedByteOffset,
            writeGeneration: event.writeGeneration,
        });

        if (containsTerminalReplayOutput(pendingWrite.deferredFrames, event.terminalId)) {
            replaceCachedPreviewWithReplay(event.terminalId);
        }
        const applied = runtime.applyFrames(pendingWrite.deferredFrames);
        if (applied.queuedWrite) {
            if (pendingWrite.responseCursor.mode === 'byte-offset' && applied.acceptedByteOffset !== null) {
                const acceptedCursor = Math.min(pendingWrite.responseCursor.value, applied.acceptedByteOffset);
                const priorAcceptedCursor = cursorRef.current;
                const priorAcceptedCursorMode = cursorModeRef.current;
                cursorRef.current = acceptedCursor;
                cursorModeRef.current = pendingWrite.responseCursor.mode;
                if (acceptedCursor !== priorAcceptedCursor || pendingWrite.responseCursor.mode !== priorAcceptedCursorMode) {
                    updateSurfaceState((current) => ({
                        ...current,
                        terminalId: event.terminalId,
                        cursor: acceptedCursor,
                        cursorMode: pendingWrite.responseCursor.mode,
                    }));
                }
                acknowledgeAcceptedBytes({ terminalId: event.terminalId, ackedByteOffset: applied.acceptedByteOffset });
            }
            const previewKey = getRendererWriteKey(applied.queuedWrite);
            pendingRendererWriteRef.current = {
                ...applied.queuedWrite,
                previewBytes: pendingWritePreviewBytesRef.current.get(previewKey) ?? new Uint8Array(),
                nextCursor: pendingWrite.responseCursor.mode === 'legacy-event-cursor'
                    ? { mode: 'legacy-event-cursor', value: applied.queuedWrite.seq + 1 }
                    : {
                        mode: 'byte-offset',
                        value: Math.min(pendingWrite.responseCursor.value, applied.queuedWrite.ackedByteOffset),
                    },
                deferredFrames: applied.deferredFrames ?? [],
                responseCursor: pendingWrite.responseCursor,
                responseDone: pendingWrite.responseDone,
            };
            pendingWritePreviewBytesRef.current.delete(previewKey);
            return;
        }

        const priorCursor = cursorRef.current;
        const priorCursorMode = cursorModeRef.current;
        const finalCursor = pendingWrite.responseCursor.mode === 'byte-offset'
            && applied.rejectedByteOffset !== null
            ? applied.acceptedByteOffset ?? priorCursor
            : pendingWrite.responseCursor.value;
        cursorRef.current = finalCursor;
        cursorModeRef.current = pendingWrite.responseCursor.mode;
        if (finalCursor !== priorCursor || pendingWrite.responseCursor.mode !== priorCursorMode) {
            updateSurfaceState((current) => ({
                ...current,
                terminalId: event.terminalId,
                cursor: finalCursor,
                cursorMode: pendingWrite.responseCursor.mode,
            }));
        }
        if (pendingWrite.responseCursor.mode === 'byte-offset' && applied.acceptedByteOffset !== null) {
            acknowledgeAcceptedBytes({ terminalId: event.terminalId, ackedByteOffset: applied.acceptedByteOffset });
        }
        if (applied.rejectedByteOffset !== null) {
            return;
        }
        if (applied.status === 'exited' || pendingWrite.responseDone) {
            terminalStreamDoneRef.current = true;
            setStatus('exited');
        }
    }, [
        acknowledgeAcceptedBytes,
        recordTerminalPreviewOutput,
        replaceCachedPreviewWithReplay,
        updateSurfaceState,
    ]);

    return {
        status,
        error,
        detectedUrl,
        onInput,
        onPaste,
        onLink,
        onTitle,
        onBell,
        terminalTitle,
        terminalBell,
        copySelection,
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

function containsTerminalReplayOutput(frames: readonly TerminalStreamFrame[], terminalId: string): boolean {
    return frames.some((frame) => frame.terminalId === terminalId && (frame.t === 'bytes' || frame.t === 'gap'));
}

function getRendererWriteKey(input: Pick<EmbeddedTerminalWriteCompleteEvent, 'terminalId' | 'seq' | 'byteOffset' | 'writeGeneration'>): string {
    return `${input.terminalId}:${input.seq}:${input.byteOffset}:${input.writeGeneration}`;
}

function isMatchingRendererWriteIdentity(
    event: EmbeddedTerminalWriteCompleteEvent,
    pending: EmbeddedTerminalWriteCompleteEvent,
): boolean {
    return event.terminalId === pending.terminalId
        && event.seq === pending.seq
        && event.byteOffset === pending.byteOffset
        && event.byteLength === pending.byteLength
        && event.writeGeneration === pending.writeGeneration;
}
