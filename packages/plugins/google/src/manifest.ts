export const PLUGIN_MANIFEST = Object.freeze({
  schemaVersion: 2,
  id: 'happier.voice.google',
  version: '0.0.0',
  displayName: 'Google Voice',
  description: 'Google Gemini speech-to-text and Google Cloud text-to-speech.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: { required: [], optional: [] },
  contributes: {
    voiceProviders: [{
      id: 'speech',
      title: 'Google Voice Speech',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt', 'conversation_tts'],
      platforms: ['web', 'ios', 'android'],
      capabilities: { readiness: { requirements: ['credential'] } },
    }],
  },
});
