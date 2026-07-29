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
    ui: {
      translations: [{
        locale: 'en',
        messages: {
          'settingsVoice.realtimeProviders.google.privacyDisclosure': 'Audio sent for transcription is processed by Google Gemini, and text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
        },
      }],
    },
  },
});
