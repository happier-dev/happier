import type { SttController, SttStartParams } from '@/voice/input/sttController';
import { resolveLocalNeuralSttCaptureSettings } from '@/voice/input/resolveLocalNeuralSttCaptureSettings';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import type { DaemonVoiceInferenceSttStreamEvent } from '@happier-dev/protocol';

import {
    createDaemonSpeechPcmCapture,
    type DaemonSpeechPcmCapture,
    type DaemonSpeechPcmCaptureOptions,
} from './DaemonSpeechPcmCapture';
import type { DaemonSpeechStreamSender } from './DaemonSpeechStreamSender';
import type { DaemonVoiceInferenceClient } from './DaemonVoiceInferenceClient';

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
}>;

type ActiveDaemonStreamingStt = {
    sender: DaemonStreamingSttSender;
    capture: DaemonSpeechPcmCapture;
    finalText: string;
    aborted: boolean;
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
    const getSettings = deps.getSettings ?? (() => ({}));
    const createClient = deps.createClient ?? createDefaultDaemonVoiceInferenceClient;
    const createPcmCapture = deps.createPcmCapture ?? createDaemonSpeechPcmCapture;

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
                        handle.finalText = text;
                        sink.onPartial(text);
                    }
                    if (event.isEndpoint) {
                        sink.onEndpoint('vad');
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
        handle.aborted = true;
        handle.unlinkAbort();
        await handle.capture.stop().catch(() => {});
        await handle.sender.cancel().catch(() => {});
    };

    return {
        start: async ({ micSession, sink, signal }: SttStartParams) => {
            if (signal?.aborted) {
                return;
            }
            if (active) {
                await cancelActive(active);
                active = null;
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
                const sender = await createClient().createStreamingSttSender({ packId, language, signal });
                await sender.start();
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
                        applyEvents(handle, sink, events);
                    },
	                    onError: (error) => {
	                        if (!handle || active !== handle) {
	                            return;
	                        }
	                        sink.onError(error);
	                        active = null;
	                        void cancelActive(handle);
	                    },
	                });
                handle = {
                    sender,
                    capture,
                    finalText: '',
                    aborted: false,
                    unlinkAbort: () => {},
                };
                active = handle;
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
                await capture.start();
            } catch (error) {
                await cancelActive(handle);
                if (active === handle) {
                    active = null;
                }
                sink.onError(createVoiceMachineError({
                    kind: 'provider_error',
                    reason: resolveDaemonStreamingSttStartErrorReason(error),
                }));
            }
        },
        stop: async () => {
            const handle = active;
            if (!handle) {
                return { finalText: '' };
            }
            active = null;
            handle.unlinkAbort();
            await handle.capture.stop().catch(() => {});
            await handle.capture.waitForDrain().catch(() => {});
            if (handle.aborted) {
                return { finalText: handle.finalText };
            }
            try {
                const response = await handle.sender.finish();
                if (response.ok) {
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
                }
            } catch {
                await handle.sender.cancel().catch(() => {});
            }
            return { finalText: handle.finalText };
        },
    };
}
