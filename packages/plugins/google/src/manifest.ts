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
    voiceProviders: [
      {
        id: 'gemini-stt',
        title: 'Google Gemini Speech-to-Text',
        kind: 'speech',
        roles: ['dictation_stt', 'conversation_stt'],
        platforms: ['web', 'ios', 'android'],
        credentials: {
          slot: {
            id: 'api_key',
            purpose: 'voice.speech.transcribe',
            title: 'Google Gemini API key',
          },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            rawGrants: [{
              realm: 'daemon',
              phase: 'speech',
              request: {
                kind: 'httpHeaders',
                origin: 'https://generativelanguage.googleapis.com',
                headerNames: ['x-goog-api-key'],
              },
            }],
          }],
        },
        settings: {
          schemaVersion: 2,
          privacyDisclosure: {
            key: 'settingsVoice.realtimeProviders.google.privacyDisclosure',
            fallback: 'Audio sent for transcription is processed by Google Gemini, and text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
          },
          fields: [
            {
              id: 'model',
              title: 'Model',
              schema: { type: 'string', minLength: 1, maxLength: 256 },
              default: 'gemini-2.5-flash',
              presentation: { control: 'select' },
            },
            {
              id: 'language',
              title: 'Language',
              schema: { type: 'string', maxLength: 64 },
              default: '',
              presentation: { control: 'text' },
            },
          ],
        },
        catalogs: [{ kind: 'models', settingFieldId: 'model', allowCustom: true }],
        limits: { transcribe: { maxInputBytes: 8_388_608 } },
      },
      {
        id: 'google-cloud-tts',
        title: 'Google Cloud Text-to-Speech',
        kind: 'speech',
        roles: ['conversation_tts'],
        platforms: ['web', 'ios', 'android'],
        credentials: {
          slot: {
            id: 'api_key',
            purpose: 'voice.speech.synthesize',
            title: 'Google Cloud API key',
          },
          requirement: { kind: 'always' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            rawGrants: [{
              realm: 'daemon',
              phase: 'speech',
              request: {
                kind: 'httpHeaders',
                origin: 'https://texttospeech.googleapis.com',
                headerNames: ['x-goog-api-key'],
              },
            }],
          }],
        },
        settings: {
          schemaVersion: 2,
          privacyDisclosure: {
            key: 'settingsVoice.realtimeProviders.google.privacyDisclosure',
            fallback: 'Audio sent for transcription is processed by Google Gemini, and text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
          },
          fields: [
            {
              id: 'voiceName',
              title: 'Voice',
              schema: { type: 'string', maxLength: 256 },
              default: '',
              presentation: { control: 'select' },
            },
            {
              id: 'languageCode',
              title: 'Language',
              schema: { type: 'string', maxLength: 64 },
              default: '',
              presentation: { control: 'text' },
            },
            {
              id: 'format',
              title: 'Audio format',
              schema: { type: 'string', enum: ['mp3', 'wav'] },
              default: 'mp3',
              presentation: {
                control: 'select',
                options: [
                  { value: 'mp3', title: 'MP3' },
                  { value: 'wav', title: 'WAV' },
                ],
              },
            },
            {
              id: 'speakingRate',
              title: 'Speaking rate',
              schema: { type: 'number', minimum: 0.25, maximum: 4 },
              default: 1,
              presentation: { control: 'number', step: 0.05 },
            },
            {
              id: 'pitch',
              title: 'Pitch',
              schema: { type: 'number', minimum: -20, maximum: 20 },
              default: 0,
              presentation: { control: 'number', step: 0.5 },
            },
          ],
          readiness: [{ kind: 'setting_nonempty', settingId: 'voiceName' }],
        },
        catalogs: [{ kind: 'voices', settingFieldId: 'voiceName', allowCustom: true }],
        limits: {
          synthesize: {
            maxInputCharacters: 1_666,
            maxOutputBytes: 3_000_000,
          },
        },
      },
    ],
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
