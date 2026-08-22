import { definePlugin } from '@happier-dev/plugin-sdk';
import { VoiceCredentialSlotIdSchema } from '@happier-dev/plugin-sdk/voice';

import {
  OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY,
  OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY,
} from './speechIdentity.js';
import {
  OPENAI_COMPAT_STT_RUNTIME,
  OPENAI_COMPAT_TTS_RUNTIME,
} from './voice/speech.js';

const OPENAI_COMPAT_API_KEY_CREDENTIAL_SLOT_ID = VoiceCredentialSlotIdSchema.parse('api_key');

export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.voice.openai-compat',
  version: '0.0.0',
  displayName: 'OpenAI-compatible Speech',
  description: 'Batch speech-to-text and text-to-speech through a selected-machine OpenAI-compatible endpoint.',
  engines: { happier: '^0.0.0' },
  runtime: { apiVersion: 1 },
  entrypoints: {
    daemon: './.happier-plugin/daemon.js',
    development: './src/index.ts',
  },
  hostAccess: { required: [], optional: [] },
  ui: {
      translations: [
        { locale: 'en', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': 'Audio and text are sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.' } },
        { locale: 'ru', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': 'Аудио и текст отправляются с выбранной машины выполнения на настроенную вами OpenAI-совместимую конечную точку. Оператор конечной точки может хранить полученные данные в соответствии со своими условиями.' } },
        { locale: 'pl', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': 'Dźwięk i tekst są wysyłane z wybranej maszyny wykonawczej do skonfigurowanego punktu końcowego zgodnego z OpenAI. Operator punktu końcowego może przechowywać otrzymane dane zgodnie z własnymi warunkami.' } },
        { locale: 'es', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': 'El audio y el texto se envían desde la máquina de ejecución seleccionada al punto de conexión compatible con OpenAI que configures. Su operador puede conservar los datos recibidos según sus propias condiciones.' } },
        { locale: 'fr', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': 'L’audio et le texte sont envoyés depuis la machine d’exécution sélectionnée vers le point de terminaison compatible OpenAI que vous configurez. Son opérateur peut conserver les données reçues selon ses propres conditions.' } },
        { locale: 'it', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': 'Audio e testo vengono inviati dalla macchina di esecuzione selezionata all’endpoint compatibile con OpenAI configurato. Il gestore dell’endpoint può conservare i dati ricevuti secondo le proprie condizioni.' } },
        { locale: 'pt', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': 'O áudio e o texto são enviados da máquina de execução selecionada para o endpoint compatível com OpenAI que configurar. O operador do endpoint pode conservar os dados recebidos de acordo com os respetivos termos.' } },
        { locale: 'ca', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': 'L’àudio i el text s’envien des de la màquina d’execució seleccionada al punt final compatible amb OpenAI que configuris. L’operador del punt final pot conservar les dades rebudes segons les seves condicions.' } },
        { locale: 'zh-Hans', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': '音频和文本会从所选执行计算机发送到您配置的 OpenAI 兼容端点。端点运营商可能会根据其自身条款保留收到的数据。' } },
        { locale: 'zh-Hant', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': '音訊和文字會從所選執行電腦傳送至您設定的 OpenAI 相容端點。端點營運商可能會依其自身條款保留收到的資料。' } },
        { locale: 'ja', messages: { 'settingsVoice.realtimeProviders.speechProcessing.openAiCompat': '音声とテキストは、選択した実行マシンから設定済みの OpenAI 互換エンドポイントへ送信されます。エンドポイントの運営者は、独自の規約に従って受信データを保持する場合があります。' } },
      ],
  },
  voiceProviders: {
    stt: {
      declaration: {
        title: 'OpenAI-compatible Speech-to-Text',
        kind: 'speech',
        roles: ['dictation_stt', 'conversation_stt'],
        platforms: ['web', 'ios', 'android'],
        credentials: {
          slot: {
            id: OPENAI_COMPAT_API_KEY_CREDENTIAL_SLOT_ID,
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
                keys: [OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY],
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
      runtime: OPENAI_COMPAT_STT_RUNTIME,
    },
    tts: {
      declaration: {
        title: 'OpenAI-compatible Text-to-Speech',
        kind: 'speech',
        roles: ['conversation_tts'],
        platforms: ['web', 'ios', 'android'],
        credentials: {
          slot: {
            id: OPENAI_COMPAT_API_KEY_CREDENTIAL_SLOT_ID,
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
                keys: [OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY],
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
      runtime: OPENAI_COMPAT_TTS_RUNTIME,
    },
  },
});
