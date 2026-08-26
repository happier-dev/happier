import { throwIfAborted } from '@happier-dev/plugin-sdk/async';
import type { RegisteredVoiceProviderRuntime } from '@happier-dev/plugin-sdk/voice';
import type {
    SpeechProviderRuntime,
    VoiceSpeechSynthesizeRequest,
    VoiceSpeechTranscribeRequest,
} from '@happier-dev/plugin-sdk/voice/speech';

export const speechToTextRuntime: SpeechProviderRuntime = {
    kind: 'speech',
    catalog: {
        async list({ catalog }, context) {
            throwIfAborted(context.signal);
            if (catalog !== 'models') throw new Error('voice_catalog_unsupported');
            return [{ id: 'synthetic-stt-v1', name: 'Synthetic STT v1', metadata: {} }];
        },
    },
    async transcribe(request: VoiceSpeechTranscribeRequest, context) {
        throwIfAborted(context.signal);
        return { requestId: request.requestId, text: 'synthetic transcript' };
    },
};

export const textToSpeechRuntime: SpeechProviderRuntime & Pick<RegisteredVoiceProviderRuntime, 'settingsActions'> = {
    kind: 'speech',
    catalog: {
        async list({ catalog }, context) {
            throwIfAborted(context.signal);
            if (catalog !== 'voices') throw new Error('voice_catalog_unsupported');
            return [{ id: 'synthetic-voice', name: 'Synthetic Voice', metadata: { locale: 'en' } }];
        },
    },
    async synthesize(request: VoiceSpeechSynthesizeRequest, context) {
        throwIfAborted(context.signal);
        return {
            requestId: request.requestId,
            bytes: new Uint8Array([82, 73, 70, 70]),
            mimeType: 'audio/wav',
        };
    },
    settingsActions: {
        async execute(input, context) {
            throwIfAborted(context.signal);
            if (input.actionId !== 'refresh-voices') {
                throw new Error('voice_settings_action_unsupported');
            }
            return { patch: { voice: 'synthetic-voice' } };
        },
    },
};
