import type { SttController, SttStartParams, SttStopResult } from '@/voice/input/sttController';
import { resolveLocalNeuralSttCaptureSettings } from '@/voice/input/resolveLocalNeuralSttCaptureSettings';
import type { TurnEndpointController } from '@/voice/runtime/input/TurnEndpointController';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import type {
    DaemonVoiceInferenceSttStreamEvent,
    DaemonVoiceInferenceSttStreamFinishResponse,
} from '@happier-dev/protocol';

import {
    createDaemonSpeechPcmCapture,
    type DaemonSpeechPcmCapture,
    type DaemonSpeechPcmCaptureOptions,
} from './DaemonSpeechPcmCapture';
import type { DaemonSpeechStreamSender } from './DaemonSpeechStreamSender';
import type { DaemonVoiceInferenceClient } from './DaemonVoiceInferenceClient';
import { daemonSpeechStreamDiagnostics } from './daemonSpeechStreamDiagnostics';

export type DaemonStreamingSttController = SttController;

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
    recordStartFailure?: (error: unknown) => void;
}>;

type ActiveDaemonStreamingStt = {
    sessionId: string | null;
    sender: DaemonStreamingSttSender;
    capture: DaemonSpeechPcmCapture;
    finalText: string;
    aborted: boolean;
    cancelAttempt: Promise<void> | null;
    unlinkAbort: () => void;
};

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

function createDefaultDaemonVoiceInferenceClient(): DaemonStreamingSttClient {
    // Keep the controller's hot import graph small; the client pulls in transfer
    // readers/encryption and is only needed for the default runtime path.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./DaemonVoiceInferenceClient.ts') as typeof import('./DaemonVoiceInferenceClient');
    return new mod.DaemonVoiceInferenceClient();
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
    return Object.assign(new Error(response.error), { code: response.errorCode });
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
            });
        case 'request_timeout':
            return createVoiceMachineError({
                kind: 'stt_timeout',
                reason: 'daemon_streaming_stt_request_timeout',
            });
        case 'daemon_speech_stream_invalid_ack':
            return createVoiceMachineError({
                kind: 'provider_error',
                reason: 'daemon_streaming_stt_invalid_ack',
            });
        case 'daemon_speech_stream_stale_finish':
            return createVoiceMachineError({
                kind: 'provider_error',
                reason: 'daemon_streaming_stt_stale_finish',
            });
        default:
            return createVoiceMachineError({
                kind: 'provider_error',
                reason: 'daemon_streaming_stt_finalization_failed',
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
    let stopping: Promise<SttStopResult> | null = null;
    const getSettings = deps.getSettings ?? (() => ({}));
    const createClient = deps.createClient ?? createDefaultDaemonVoiceInferenceClient;
    const createPcmCapture = deps.createPcmCapture ?? createDaemonSpeechPcmCapture;
    const endpointController = deps.endpointController;
    const recordStartFailure = deps.recordStartFailure ?? daemonSpeechStreamDiagnostics.recordStartFailure;

    const signalEndpoint = (
        handle: ActiveDaemonStreamingStt,
        transcript: string,
    ): void => {
        if (!handle.sessionId) {
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
                    const text = event.text.trim();
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
                    const text = event.transcript.trim();
                    if (text.length > 0) {
                        handle.finalText = text;
                        sink.onFinal(text);
                    }
                    sink.onEndpoint(mapEndpointReason(event.reason));
                    signalEndpoint(handle, text);
                    break;
                }
                case 'final': {
                    const text = event.text.trim();
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
        const attempt = (async () => {
            await handle.capture.stop().catch(() => {});
            await handle.sender.cancel().catch(() => {});
        })();
        handle.cancelAttempt = attempt;
        await attempt;
    };

    return {
        start: async ({ sessionId, micSession, sink, signal }: SttStartParams) => {
            if (signal?.aborted) {
                return;
            }
            if (stopping) {
                await stopping;
                if (signal?.aborted) {
                    return;
                }
            }
            if (active) {
                const previous = active;
                await cancelActive(previous);
                if (active === previous) {
                    active = null;
                }
                if (signal?.aborted) {
                    return;
                }
            }
            const { packId, language } = resolveLocalNeuralSttCaptureSettings(getSettings());
            if (!packId) {
                sink.onError(createVoiceMachineError({
                    kind: 'provider_error',
                    reason: 'daemon_streaming_stt_pack_missing',
                }));
                return;
            }

            let handle: ActiveDaemonStreamingStt | null = null;
            try {
                const sender = await createClient().createStreamingSttSender({ sessionId, packId, language, signal });
                if (signal?.aborted) {
                    await sender.cancel().catch(() => {});
                    return;
                }
                await sender.start();
                if (signal?.aborted) {
                    await sender.cancel().catch(() => {});
                    return;
                }
                const capture = createPcmCapture({
                    micSession,
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
                        const events = await sender.pushChunk(pcm16Bytes);
                        if (active !== handle || handle.aborted) {
                            return;
                        }
                        applyEvents(handle, sink, events);
                    },
                    onError: (error) => {
                        if (!handle || active !== handle) {
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
                    sessionId: typeof sessionId === 'string' && sessionId.trim().length > 0
                        ? sessionId.trim()
                        : null,
                    sender,
                    capture,
                    finalText: '',
                    aborted: false,
                    cancelAttempt: null,
                    unlinkAbort: () => {},
                };
                active = handle;
                if (handle.sessionId) {
                    endpointController?.startSession(handle.sessionId);
                }
                if (signal) {
                    const abort = () => {
                        if (active === handle) {
                            void cancelActive(handle);
                        }
                    };
                    signal.addEventListener('abort', abort, { once: true });
                    handle.unlinkAbort = () => {
                        signal.removeEventListener('abort', abort);
                    };
                }
                if (signal?.aborted) {
                    await cancelActive(handle);
                    if (active === handle) {
                        active = null;
                    }
                    return;
                }
                await capture.start();
                if (signal?.aborted) {
                    await cancelActive(handle);
                    if (active === handle) {
                        active = null;
                    }
                }
            } catch (error) {
                await cancelActive(handle);
                if (active === handle) {
                    active = null;
                }
                if (signal?.aborted) {
                    return;
                }
                recordStartFailure(error);
                sink.onError(createVoiceMachineError({
                    kind: 'provider_error',
                    reason: resolveDaemonStreamingSttStartErrorReason(error),
                }));
            }
        },
        stop: async () => {
            if (stopping) {
                return stopping;
            }
            const handle = active;
            if (!handle) {
                return { finalText: '' };
            }
            const pending = (async () => {
                try {
                    if (handle.sessionId) {
                        endpointController?.clearSession(handle.sessionId);
                    }
                    handle.unlinkAbort();
                    if (handle.aborted) {
                        await cancelActive(handle);
                        return { finalText: handle.finalText };
                    }
                    await handle.capture.stop().catch(() => {});
                    await handle.capture.waitForDrain().catch(() => {});
                    if (handle.aborted) {
                        return { finalText: handle.finalText };
                    }
                    try {
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
                            handle.finalText = finalText;
                        }
                    } catch (error) {
                        handle.aborted = true;
                        await handle.sender.cancel().catch(() => {});
                        return {
                            error: classifyDaemonStreamingSttFinalizationFailure(error),
                        };
                    }
                    return { finalText: handle.finalText };
                } finally {
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
        },
    };
}
