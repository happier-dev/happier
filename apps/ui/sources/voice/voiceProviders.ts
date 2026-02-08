export const VOICE_PROVIDER_IDS = {
  OFF: 'off',
  HAPPIER_ELEVENLABS_AGENTS: 'happier_elevenlabs_agents',
  BYO_ELEVENLABS_AGENTS: 'byo_elevenlabs_agents',
  LOCAL_OPENAI_STT_TTS: 'local_openai_stt_tts',
} as const;

export type VoiceProviderId = (typeof VOICE_PROVIDER_IDS)[keyof typeof VOICE_PROVIDER_IDS];

