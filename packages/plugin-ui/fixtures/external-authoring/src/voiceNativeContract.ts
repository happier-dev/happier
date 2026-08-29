import type {
  VoiceAudioContextHandle,
  VoiceMediaStreamHandle,
  VoiceMicSession,
} from '@happier-dev/plugin-sdk/voice/client';

declare const mic: VoiceMicSession;

const stream: VoiceMediaStreamHandle | null = mic.getStream();
const audioContext: VoiceAudioContextHandle | null = mic.getAudioContext?.() ?? null;

void stream;
void audioContext;
