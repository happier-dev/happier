import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { VoiceProviderContribution } from '@happier-dev/plugin-sdk/voice';
import type {
  SpeechProviderRuntime,
  VoiceSpeechSynthesizeRequest,
  VoiceSpeechTranscribeRequest,
} from '@happier-dev/plugin-sdk/voice/speech';

import { createPackedVoiceAgentRuntime } from './voiceAgentRuntime.js';

const STT_MODEL = 'packed-stt-v1';
const TTS_VOICE = 'packed-voice-primary';
const SPEECH_KIND: Extract<VoiceProviderContribution['kind'], 'speech'> = 'speech';

const speechToTextRuntime: SpeechProviderRuntime = {
  kind: SPEECH_KIND,
  catalog: {
    async list(request, context) {
      context.signal.throwIfAborted();
      if (request.catalog !== 'models') throw new Error('unsupported_speech_catalog');
      return [{ id: STT_MODEL, name: 'Packed STT v1', metadata: {} }];
    },
  },
  async transcribe(request: VoiceSpeechTranscribeRequest, context) {
    context.signal.throwIfAborted();
    return { requestId: request.requestId, text: 'packed fixture transcript' };
  },
};

const textToSpeechRuntime: SpeechProviderRuntime = {
  kind: SPEECH_KIND,
  catalog: {
    async list(request, context) {
      context.signal.throwIfAborted();
      if (request.catalog !== 'voices') throw new Error('unsupported_speech_catalog');
      return [{ id: TTS_VOICE, name: 'Packed Voice', metadata: { locale: 'en' } }];
    },
  },
  async synthesize(request: VoiceSpeechSynthesizeRequest, context) {
    context.signal.throwIfAborted();
    return {
      requestId: request.requestId,
      bytes: new Uint8Array([82, 73, 70, 70]),
      mimeType: 'audio/wav',
    };
  },
};

export function activate(api: Pick<PluginApi, 'agents' | 'voiceProviders'>): void {
  api.agents.register('voice-agent', createPackedVoiceAgentRuntime, {
    sessionRunnerFactory: {
      module: './voiceAgentRuntime.js',
      export: 'createPackedVoiceAgentRuntime',
      runtimeApiVersion: 1,
    },
  });
  api.voiceProviders.register('speech-stt', speechToTextRuntime);
  api.voiceProviders.register('speech-tts', textToSpeechRuntime);
}
