import type { SttController, SttStartParams, SttStopResult } from '@/voice/input/sttController';
import { resolveLocalNeuralSttCaptureSettings } from '@/voice/input/resolveLocalNeuralSttCaptureSettings';
import type { TurnEndpointController } from '@/voice/runtime/input/TurnEndpointController';
import { classifyVoiceMachineError, createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { readSafeVoiceRuntimeFailureCode, recordVoiceRuntimeFailure } from '@/voice/runtime/voiceRuntimeFailureCode';
import type {
    DaemonVoiceInferenceSttStreamEvent,
    DaemonVoiceInferenceSttStreamFinishResponse,
} from '@happier-dev/protocol/daemon/voiceInference';

import {
    createDaemonSpeechPcmCapture,
    type DaemonSpeechPcmCapture,
    type DaemonSpeechPcmCaptureOptions,
} from './DaemonSpeechPcmCapture';
import type { DaemonSpeechStreamSender } from './DaemonSpeechStreamSender';
import { DaemonSpeechRelayDisconnectedError } from './DaemonSpeechRelayDisconnectedError';
import type { DaemonVoiceInferenceClient } from './DaemonVoiceInferenceClient';
import { daemonSpeechStreamDiagnostics, type DaemonSpeechStreamStartStep } from './daemonSpeechStreamDiagnostics';

export type DaemonStreamingSttController = SttController & Readonly<{
    setMuted: (muted: boolean) => Promise<void>;
}>;

type DaemonStreamingSttSender = Pick<DaemonSpeechStreamSender, 'start' | 'pushChunk' | 'finish' | 'cancel'>;
type DaemonStreamingSttClient = Readonly<{
    createStreamingSttSender: (
        options: Parameters<DaemonVoiceInferenceClient['createStreamingSttSender']>[0],
    ) => Promise<DaemonStreamingSttSender>;
}>;

export type DaemonStreamingSttControllerDeps = Readonly<{
    getSettings?: () => unknown;
    createClient?: () => DaemonStreamingSttClient;
    createPcmCapture?: (options: DaemonSpeechPcmCaptureOptions) => DaemonSpeechPcmCapture;
    endpointController?: TurnEndpointController;
    recordStartFailure?: (error: unknown, context: Readonly<{ step: DaemonSpeechStreamStartStep }>) => void;
}>;

type ActiveDaemonStreamingStt = {
    params: SttStartParams;
    prefixText: string;
    sessionId: string | null;
    sender: DaemonStreamingSttSender;
    capture: DaemonSpeechPcmCapture;
    finalText: string;
    aborted: boolean;
    cancelAttempt: Promise<void> | null;
    hasAudio: boolean;
    unlinkAbort: () => void;
};

// Readout may replace the controller while retaining the call's admission.
// Keep startup and retirement owned by that existing call lifetime.
const captureStarts = new WeakMap<AbortSignal | DaemonStreamingSttClient, {
    pending: Promise<void>;
    retire: (continuingRecovery?: AbortSignal) => Promise<void>;
}>();

const DAEMON_STT_START_ERROR_REASONS = new Set([
    'feature_disabled',
    'machine_unreachable',
    'runtime_unavailable',
    'model_not_installed',
    'request_timeout',
    'invalid_audio_input',
    'unsupported_codec',
    'cancelled',
    'stream_transport_unavailable',
    'internal_error',
]);

export function createDefaultDaemonVoiceInferenceClient(): DaemonStreamingSttClient {
    // Keep the controller's hot import graph small; the client pulls in transfer
    // readers/encryption and is only needed for the default runtime path. The deferral
    // is a dynamic import rather than a bundler-only `require`: every host that executes
    // this module resolves the target through its own module graph, so the client stays
    // one module instance under Metro and under the Vitest/Vite graph alike. A `require`
    // here reaches Node's CommonJS loader in tests and loads a second, unaliased copy.
    let client: Promise<DaemonVoiceInferenceClient> | null = null;
    return {
        createStreamingSttSender: async (options) => {
            client ??= import('./DaemonVoiceInferenceClient').then(({ DaemonVoiceInferenceClient }) => new DaemonVoiceInferenceClient());
            return (await client).createStreamingSttSender(options);
        },
    };
}

function resolveDaemonStreamingSttStartErrorReason(error: unknown): string {
    const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    if (DAEMON_STT_START_ERROR_REASONS.has(code)) {
        return `daemon_streaming_stt_${code}`;
    }
    return 'daemon_streaming_stt_start_failed';
}

function createDaemonStreamingSttFinishResponseError(
    response: Extract<DaemonVoiceInferenceSttStreamFinishResponse, { ok: false }>,
): Error & Readonly<{ code: string }> {
    return Object.assign(new Error(response.error), { code: response.errorCode,
        ...(response.failureCause ? { failureCause: response.failureCause } : {}) });
}

function classifyDaemonStreamingSttFinalizationFailure(error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    switch (code) {
        case 'daemon_speech_stream_finish_timeout':
            return createVoiceMachineError({
                kind: 'stt_timeout',
                reason: 'daemon_streaming_stt_finish_timeout',
                cause: error,
            });
        case 'request_timeout':
            return createVoiceMachineError({
                kind: 'stt_timeout',
                reason: 'daemon_streaming_stt_request_timeout',
                cause: error,
            });
        case 'daemon_speech_stream_invalid_ack':
            return createVoiceMachineError({
                kind: 'provider_error',
                reason: 'daemon_streaming_stt_invalid_ack',
                cause: error,
            });
        case 'daemon_speech_stream_stale_finish':
            return createVoiceMachineError({
                kind: 'provider_error',
                reason: 'daemon_streaming_stt_stale_finish',
                cause: error,
            });
        default:
            return createVoiceMachineError({
                kind: 'provider_error',
                reason: 'daemon_streaming_stt_finalization_failed',
                cause: error,
            });
    }
}

function mapEndpointReason(reason: Extract<DaemonVoiceInferenceSttStreamEvent, { type: 'endpoint' }>['reason']) {
    switch (reason) {
        case 'manual':
            return 'manual';
        case 'timeout':
        case 'eof':
            return 'silence';
        case 'vad':
        default:
            return 'vad';
    }
}

export function createDaemonStreamingSttController(
    deps: DaemonStreamingSttControllerDeps = {},
): DaemonStreamingSttController {
    let active: ActiveDaemonStreamingStt | null = null;
    let recovery: { handle: ActiveDaemonStreamingStt; abort: AbortController } | null = null;
    let stopping: Promise<SttStopResult> | null = null;
    let paused: Readonly<{ params: SttStartParams; result: Promise<SttStopResult> }> | null = null;
    const unretiredCaptures = new Set<DaemonSpeechPcmCapture>();
    const retireCapture = async (capture: DaemonSpeechPcmCapture): Promise<void> => {
        await capture.stop();
        unretiredCaptures.delete(capture);
    };
    const getSettings = deps.getSettings ?? (() => ({}));
    const client = (deps.createClient ?? createDefaultDaemonVoiceInferenceClient)();
    const createPcmCapture = deps.createPcmCapture ?? createDaemonSpeechPcmCapture;
    const endpointController = deps.endpointController;
    const recordStartFailure = deps.recordStartFailure ?? daemonSpeechStreamDiagnostics.recordStartFailure;

    const signalEndpoint = (
        handle: ActiveDaemonStreamingStt,
        transcript: string,
    ): void => {
        if (!handle.sessionId || paused) {
            return;
        }
        endpointController?.signalEndpointDetected({
            sessionId: handle.sessionId,
            source: 'daemon_stream',
            transcript,
        });
    };

    const applyEvents = (
        handle: ActiveDaemonStreamingStt,
        sink: SttStartParams['sink'],
        events: readonly DaemonVoiceInferenceSttStreamEvent[],
    ): void => {
        for (const event of events) {
            if (active !== handle) {
                return;
            }
            switch (event.type) {
                case 'partial': {
                    const text = [handle.prefixText, event.text.trim()].filter(Boolean).join(' ');
                    if (text.length > 0) {
                        sink.onPartial(text);
                    }
                    if (event.isEndpoint) {
                        sink.onEndpoint('vad');
                        signalEndpoint(handle, text);
                    }
                    break;
                }
                case 'endpoint': {
                    const text = [handle.prefixText, event.transcript.trim()].filter(Boolean).join(' ');
                    if (text.length > 0) {
                        handle.finalText = text;
                        sink.onFinal(text);
                    }
                    sink.onEndpoint(mapEndpointReason(event.reason));
                    signalEndpoint(handle, text);
                    break;
                }
                case 'final': {
                    const text = [handle.prefixText, event.text.trim()].filter(Boolean).join(' ');
                    if (text.length > 0) {
                        handle.finalText = text;
                        sink.onFinal(text);
                    }
                    break;
                }
            }
        }
    };

    const cancelActive = async (handle: ActiveDaemonStreamingStt | null): Promise<void> => {
        if (!handle) {
            return;
        }
        if (handle.cancelAttempt) {
            await handle.cancelAttempt;
            return;
        }
        handle.aborted = true;
        if (handle.sessionId) {
            endpointController?.clearSession(handle.sessionId);
        }
        handle.unlinkAbort();
        const attempt = Promise.all([
            retireCapture(handle.capture).catch((error: unknown) => {
                const failure = classifyVoiceMachineError(error, { kind: 'provider_error' });
                recordVoiceRuntimeFailure('daemon_streaming_stt', 'provider_error', failure.kind,
                    readSafeVoiceRuntimeFailureCode(error) ?? failure.kind);
            }),
            handle.sender.cancel().catch(() => {}),
        ]).then(() => undefined);
        handle.cancelAttempt = attempt;
        await attempt;
    };

    const startAttempt = async (params: SttStartParams, prefixText: string, recoverySignal?: AbortSignal) => {
        const { sessionId, micSession, sink, signal, callSignal, capturePurpose } = params;
        const isAborted = () => signal?.aborted || callSignal?.aborted || recoverySignal?.aborted;
        paused = null;
        if (isAborted()) {
            return;
        }
        if (stopping) {
            await stopping;
            if (isAborted()) {
                return;
            }
        }
        if (active) {
            const previous = active;
            await cancelActive(previous);
            if (active === previous) {
                active = null;
            }
            if (isAborted()) {
                return;
            }
        }
        if (micSession.isMuted()) {
            paused = { params, result: Promise.resolve({ finalText: prefixText }) };
            return;
        }
        const { packId, language } = resolveLocalNeuralSttCaptureSettings(getSettings(), capturePurpose);
        if (!packId) {
            sink.onError(createVoiceMachineError({
                kind: 'provider_error',
                reason: 'daemon_streaming_stt_pack_missing',
            }));
            return;
        }

        let handle: ActiveDaemonStreamingStt | null = null;
        let startStep: DaemonSpeechStreamStartStep = 'create_sender';
        try {
            const sender = await client.createStreamingSttSender({ sessionId, packId, language, signal, callSignal });
            if (isAborted()) {
                await sender.cancel().catch(() => {});
                return;
            }
            startStep = 'sender_start';
            await sender.start();
            if (isAborted()) {
                await sender.cancel().catch(() => {});
                return;
            }
            startStep = 'capture_start';
            const capture = createPcmCapture({
                micSession,
                capturePurpose,
                signal,
                onAudioStarted: () => {
                    if (active === handle) {
                        sink.onAudioStarted();
                    }
                },
                onChunk: async (pcm16Bytes) => {
                    if (!handle || active !== handle || handle.aborted) {
                        return;
                    }
                    const admittedHandle = handle;
                    admittedHandle.hasAudio = true;
                    // pushChunk admits synchronously into the sender's bounded window.
                    // Recognition replies must not hold the browser/native capture queue.
                    void sender.pushChunk(pcm16Bytes).then((events) => {
                        if (active === admittedHandle && !admittedHandle.aborted && !paused) {
                            applyEvents(admittedHandle, sink, events);
                        }
                    }).catch((error: unknown) => {
                        if (active !== admittedHandle || admittedHandle.aborted) return;
                        if (error instanceof DaemonSpeechRelayDisconnectedError && callSignal && !stopping && error.waitForReconnect) {
                            void recoverCapture(admittedHandle, error.waitForReconnect);
                            return;
                        }
                        void cancelActive(admittedHandle).then(() => {
                            if (active === admittedHandle) active = null;
                            const failure = createVoiceMachineError({
                                kind: 'provider_error',
                                cause: error,
                                reason: error && typeof error === 'object' && 'code' in error
                                    && error.code === 'daemon_speech_stream_backpressure'
                                    ? 'daemon_streaming_stt_pcm_backpressure'
                                    : 'daemon_streaming_stt_pcm_chunk_failed',
                            });
                            Object.defineProperty(failure, 'cause', { value: error, enumerable: false });
                            sink.onError(failure);
                        });
                    });
                },
                onError: (error) => {
                    if (!handle || active !== handle || handle.aborted) {
                        return;
                    }
                    const failedHandle = handle;
                    void cancelActive(failedHandle).then(() => {
                        if (active === failedHandle) {
                            active = null;
                        }
                        sink.onError(error);
                    });
                },
            });
            handle = {
                params,
                prefixText,
                sessionId: typeof sessionId === 'string' && sessionId.trim().length > 0
                    ? sessionId.trim()
                    : null,
                sender,
                capture,
                finalText: prefixText,
                aborted: false,
                cancelAttempt: null,
                hasAudio: false,
                unlinkAbort: () => {},
            };
            active = handle;
            unretiredCaptures.add(capture);
            if (handle.sessionId) {
                endpointController?.startSession(handle.sessionId);
            }
            if (signal || callSignal || recoverySignal) {
                const abort = () => {
                    if (active === handle) {
                        void cancelActive(handle);
                    }
                };
                signal?.addEventListener('abort', abort, { once: true });
                callSignal?.addEventListener('abort', abort, { once: true });
                recoverySignal?.addEventListener('abort', abort, { once: true });
                handle.unlinkAbort = () => {
                    signal?.removeEventListener('abort', abort);
                    callSignal?.removeEventListener('abort', abort);
                    recoverySignal?.removeEventListener('abort', abort);
                };
            }
            if (isAborted()) {
                await cancelActive(handle);
                if (active === handle) {
                    active = null;
                }
                return;
            }
            await capture.start();
            if (isAborted()) {
                await cancelActive(handle);
                if (active === handle) {
                    active = null;
                }
                return;
            }
            return handle;
        } catch (error) {
            await cancelActive(handle);
            if (active === handle) {
                active = null;
            }
            if (isAborted()) {
                return;
            }
            recordStartFailure(error, { step: startStep });
            const failure = createVoiceMachineError({
                kind: 'provider_error',
                reason: resolveDaemonStreamingSttStartErrorReason(error),
                cause: error,
            });
            // Keep the actual transport/start exception available to local diagnostics
            // without disclosing it in the machine projection or serialized state.
            Object.defineProperty(failure, 'cause', { value: error, enumerable: false });
            sink.onError(failure);
        }
    };
    const start = (params: SttStartParams, prefixText = '', recoverySignal?: AbortSignal): Promise<void> => {
        const key = params.callSignal ?? client;
        const owner = captureStarts.get(key) ?? { pending: Promise.resolve(), retire: async () => {} };
        captureStarts.set(key, owner);
        const attempt = owner.pending.then(async () => {
            if (params.signal?.aborted || params.callSignal?.aborted || recoverySignal?.aborted) return;
            await owner.retire(recoverySignal);
            const handle = await startAttempt(params, prefixText, recoverySignal);
            owner.retire = async (continuingRecovery) => {
                if (handle && recovery?.handle === handle && recovery.abort.signal !== continuingRecovery) {
                    recovery.abort.abort();
                }
                // End can abandon a held cancellation reply. Its sender is
                // already locally closed; physical capture still must retire
                // before this admitted call can listen again.
                if (handle?.aborted) {
                    await retireCapture(handle.capture);
                    return;
                }
                await stopping;
                await cancelActive(handle ?? null);
            };
            if (recoverySignal && handle && active === handle && !handle.aborted) {
                params.sink.onCaptureRecovery?.('recovered');
            }
        });
        owner.pending = attempt.catch(() => {});
        return attempt;
    };
    const recoverCapture = async (
        handle: ActiveDaemonStreamingStt,
        waitForReconnect: (signal: AbortSignal) => Promise<boolean>,
    ): Promise<void> => {
        const { signal, callSignal, sink } = handle.params;
        const pending = { handle, abort: new AbortController() };
        recovery = pending;
        const recoverySignal = pending.abort.signal;
        const abort = () => pending.abort.abort();
        const cancelPresentation = () => sink.onCaptureRecovery?.('cancelled');
        recoverySignal.addEventListener('abort', cancelPresentation, { once: true });
        // The failed sender has already closed and dispatched cleanup. Its
        // cancel() is now a no-op, so retirement only waits for local PCM.
        const retirement = cancelActive(handle);
        sink.onCaptureRecovery?.('reconnecting');
        signal?.addEventListener('abort', abort, { once: true });
        callSignal?.addEventListener('abort', abort, { once: true });
        try {
            const [connected] = await Promise.all([waitForReconnect(recoverySignal), retirement]);
            if (!connected || recoverySignal.aborted || active !== handle) return;
            active = null;
            await start(handle.params, handle.finalText, recoverySignal);
        } catch (cause) {
            if (!recoverySignal.aborted) sink.onError(createVoiceMachineError({
                kind: 'provider_error', reason: 'daemon_streaming_stt_pcm_chunk_failed', cause,
            }));
        } finally {
            if (recovery === pending) recovery = null;
            recoverySignal.removeEventListener('abort', cancelPresentation);
            signal?.removeEventListener('abort', abort);
            callSignal?.removeEventListener('abort', abort);
        }
    };
    const finalize = async (): Promise<SttStopResult> => {
        if (stopping) {
            return stopping;
        }
        const recovering = recovery;
        const handle = active ?? recovering?.handle;
        recovering?.abort.abort();
        if (!handle) {
            return { finalText: '' };
        }
        const pending = (async () => {
            try {
                if (handle.sessionId) {
                    endpointController?.clearSession(handle.sessionId);
                }
                if (handle.aborted) {
                    await cancelActive(handle);
                    return { finalText: handle.finalText };
                }
                try {
                    await handle.capture.finish();
                    unretiredCaptures.delete(handle.capture);
                    if (handle.aborted) {
                        return { finalText: handle.finalText };
                    }
                    const response = await handle.sender.finish();
                    if (!response.ok) {
                        throw createDaemonStreamingSttFinishResponseError(response);
                    }
                    applyEvents(handle, {
                        onAudioStarted: () => {},
                        onPartial: () => {},
                        onFinal: (text) => {
                            handle.finalText = text.trim() || handle.finalText;
                        },
                        onEndpoint: () => {},
                        onError: () => {},
                    }, response.events);
                    const finalText = response.finalText.trim();
                    if (finalText.length > 0) {
                        handle.finalText = [handle.prefixText, finalText].filter(Boolean).join(' ');
                    }
                } catch (error) {
                    if (handle.aborted) {
                        return { finalText: handle.finalText };
                    }
                    await cancelActive(handle);
                    const failure = classifyDaemonStreamingSttFinalizationFailure(error);
                    // Keep finish/capture details in local diagnostics only.
                    Object.defineProperty(failure, 'cause', { value: error, enumerable: false });
                    return { error: failure };
                }
                return { finalText: handle.finalText };
            } finally {
                handle.unlinkAbort();
                if (active === handle) {
                    active = null;
                }
            }
        })();
        stopping = pending;
        try {
            return await pending;
        } finally {
            if (stopping === pending) {
                stopping = null;
            }
        }
    };
    return {
        start,
        discardInput: async () => {
            recovery?.abort.abort();
            await Promise.all([...unretiredCaptures].map(retireCapture));
        },
        hasUnretiredInput: () => unretiredCaptures.size > 0,
        stop: async () => {
            const held = paused;
            paused = null;
            return held ? await held.result : await finalize();
        },
        setMuted: async (muted) => {
            if (muted) {
                const handle = active ?? recovery?.handle;
                if (paused || !handle) return;
                // Close the remote stream while it is still owned, retaining
                // its final in this capture until Send. Muted input produces no
                // traffic and must not depend on the daemon's abandoned-stream TTL.
                const result = handle.hasAudio ? finalize() : cancelActive(handle).then(() => {
                    if (active === handle) active = null;
                    return { finalText: handle.finalText };
                });
                const held = { params: handle.params, result };
                paused = held;
                // Physical mute has already taken effect. Publish it without
                // waiting for recognition; Send/Unmute consume this same final.
                void result.then((final) => {
                    if (paused === held && 'error' in final) {
                        paused = null;
                        handle.params.sink.onError(final.error);
                    }
                });
                return;
            }
            const held = paused;
            if (!held) return;
            const final = await held.result;
            if (paused !== held || held.params.signal?.aborted) return;
            paused = null;
            if ('error' in final) return;
            await start(held.params, final.finalText);
        },
    };
}
