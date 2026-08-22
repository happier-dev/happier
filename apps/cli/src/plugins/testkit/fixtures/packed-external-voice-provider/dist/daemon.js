import { createPackedVoiceAgentRuntime } from './agentRuntime.js';

const STT_MODEL = 'packed-stt-v1';
const TTS_VOICE = 'packed-voice-primary';

export function activate(api) {
  api.agents.register('voice-agent', createPackedVoiceAgentRuntime, {
    sessionRunnerFactory: {
      module: './agentRuntime.js',
      export: 'createPackedVoiceAgentRuntime',
      runtimeApiVersion: 1,
    },
  });
  api.voiceProviders.register('speech-stt', {
    kind: 'speech',
    catalog: {
      async list(request, context) {
        context.signal.throwIfAborted();
        if (request.catalog !== 'models') throw new Error('unsupported_speech_catalog');
        return [{ id: STT_MODEL, name: 'Packed STT v1', metadata: {} }];
      },
    },
    async transcribe(request, context) {
      context.signal.throwIfAborted();
      return { requestId: request.requestId, text: 'packed fixture transcript' };
    },
  });
  api.voiceProviders.register('speech-tts', {
    kind: 'speech',
    catalog: {
      async list(request, context) {
        context.signal.throwIfAborted();
        if (request.catalog !== 'voices') throw new Error('unsupported_speech_catalog');
        return [{ id: TTS_VOICE, name: 'Packed Voice', metadata: { locale: 'en' } }];
      },
    },
    async synthesize(request, context) {
      context.signal.throwIfAborted();
      return {
        requestId: request.requestId,
        bytes: new Uint8Array([82, 73, 70, 70]),
        mimeType: 'audio/wav',
      };
    },
  });
}
