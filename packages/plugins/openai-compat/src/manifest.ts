export const PLUGIN_MANIFEST = Object.freeze({
  schemaVersion: 2,
  id: 'happier.voice.openai-compat',
  version: '0.0.0',
  displayName: 'OpenAI-compatible Speech',
  description: 'Batch speech-to-text and text-to-speech through a selected-machine OpenAI-compatible endpoint.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: {
    daemon: './dist/index.js',
    development: './src/index.ts',
  },
  hostAccess: { required: [], optional: [] },
  contributes: {
    voiceProviders: [
      {
        id: 'stt',
        title: 'OpenAI-compatible Speech-to-Text',
        kind: 'speech',
        roles: ['dictation_stt', 'conversation_stt'],
        platforms: ['web', 'ios', 'android'],
        credentials: {
          slot: {
            id: 'api_key',
            purpose: 'voice.speech.transcribe',
            title: 'OpenAI-compatible STT API key',
          },
          requirement: { kind: 'optional' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            rawGrants: [{
              realm: 'daemon',
              phase: 'speech',
              request: {
                kind: 'environment',
                keys: ['HAPPIER_VOICE_OPENAI_COMPAT_STT_API_KEY'],
              },
            }],
          }],
        },
        settings: {
          schemaVersion: 2,
          privacyDisclosure: {
            key: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat',
            fallback: 'Audio and text are sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.',
          },
          fields: [
            {
              id: 'baseUrl',
              title: 'Transcription endpoint',
              schema: { type: 'string', minLength: 0, maxLength: 2048 },
              default: '',
              presentation: { control: 'text' },
            },
            {
              id: 'insecureLocalOriginConsent',
              title: 'Confirmed insecure local origin',
              schema: { type: 'string', minLength: 0, maxLength: 512 },
              default: '',
              presentation: { control: 'text', hidden: true },
            },
            {
              id: 'insecureLocalConsentMachineId',
              title: 'Confirmed insecure local machine',
              schema: { type: 'string', minLength: 0, maxLength: 512 },
              default: '',
              presentation: { control: 'text', hidden: true },
            },
            {
              id: 'model',
              title: 'Model',
              schema: { type: 'string', minLength: 1, maxLength: 256 },
              default: 'whisper-1',
              presentation: { control: 'text' },
            },
            {
              id: 'language',
              title: 'Language',
              schema: { type: 'string', minLength: 0, maxLength: 64 },
              default: '',
              presentation: { control: 'text' },
            },
          ],
          readiness: [{ kind: 'setting_nonempty', settingId: 'baseUrl' }],
        },
        limits: { transcribe: { maxInputBytes: 8388608 } },
      },
      {
        id: 'tts',
        title: 'OpenAI-compatible Text-to-Speech',
        kind: 'speech',
        roles: ['conversation_tts'],
        platforms: ['web', 'ios', 'android'],
        credentials: {
          slot: {
            id: 'api_key',
            purpose: 'voice.speech.synthesize',
            title: 'OpenAI-compatible TTS API key',
          },
          requirement: { kind: 'optional' },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            rawGrants: [{
              realm: 'daemon',
              phase: 'speech',
              request: {
                kind: 'environment',
                keys: ['HAPPIER_VOICE_OPENAI_COMPAT_TTS_API_KEY'],
              },
            }],
          }],
        },
        settings: {
          schemaVersion: 2,
          privacyDisclosure: {
            key: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat',
            fallback: 'Audio and text are sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.',
          },
          fields: [
            {
              id: 'baseUrl',
              title: 'Speech endpoint',
              schema: { type: 'string', minLength: 0, maxLength: 2048 },
              default: '',
              presentation: { control: 'text' },
            },
            {
              id: 'insecureLocalOriginConsent',
              title: 'Confirmed insecure local origin',
              schema: { type: 'string', minLength: 0, maxLength: 512 },
              default: '',
              presentation: { control: 'text', hidden: true },
            },
            {
              id: 'insecureLocalConsentMachineId',
              title: 'Confirmed insecure local machine',
              schema: { type: 'string', minLength: 0, maxLength: 512 },
              default: '',
              presentation: { control: 'text', hidden: true },
            },
            {
              id: 'model',
              title: 'Model',
              schema: { type: 'string', minLength: 1, maxLength: 256 },
              default: 'tts-1',
              presentation: { control: 'text' },
            },
            {
              id: 'voiceName',
              title: 'Voice',
              schema: { type: 'string', minLength: 1, maxLength: 256 },
              default: 'alloy',
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
          ],
          readiness: [{ kind: 'setting_nonempty', settingId: 'baseUrl' }],
        },
        limits: {
          synthesize: {
            maxInputCharacters: 200000,
            maxOutputBytes: 33554432,
          },
        },
      },
    ],
  },
} satisfies import('@happier-dev/plugin-sdk/manifest').PluginManifest);
