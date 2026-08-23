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
        {
          locale: 'en',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': 'Audio for transcription is sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': 'Reply text for speech synthesis is sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.',
          },
        },
        {
          locale: 'ru',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': 'Аудио для распознавания речи отправляется с выбранной машины выполнения на настроенную вами OpenAI-совместимую конечную точку. Оператор конечной точки может хранить полученные данные в соответствии со своими условиями.',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': 'Текст ответа для синтеза речи отправляется с выбранной машины выполнения на настроенную вами OpenAI-совместимую конечную точку. Оператор конечной точки может хранить полученные данные в соответствии со своими условиями.',
          },
        },
        {
          locale: 'pl',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': 'Dźwięk do transkrypcji jest wysyłany z wybranej maszyny wykonawczej do skonfigurowanego punktu końcowego zgodnego z OpenAI. Operator punktu końcowego może przechowywać otrzymane dane zgodnie z własnymi warunkami.',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': 'Tekst odpowiedzi do syntezy mowy jest wysyłany z wybranej maszyny wykonawczej do skonfigurowanego punktu końcowego zgodnego z OpenAI. Operator punktu końcowego może przechowywać otrzymane dane zgodnie z własnymi warunkami.',
          },
        },
        {
          locale: 'es',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': 'El audio para la transcripción se envía desde la máquina de ejecución seleccionada al punto de conexión compatible con OpenAI que configures. Su operador puede conservar los datos recibidos según sus propias condiciones.',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': 'El texto de la respuesta para la síntesis de voz se envía desde la máquina de ejecución seleccionada al punto de conexión compatible con OpenAI que configures. Su operador puede conservar los datos recibidos según sus propias condiciones.',
          },
        },
        {
          locale: 'fr',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': 'L’audio destiné à la transcription est envoyé depuis la machine d’exécution sélectionnée vers le point de terminaison compatible OpenAI que vous configurez. Son opérateur peut conserver les données reçues selon ses propres conditions.',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': 'Le texte de la réponse destiné à la synthèse vocale est envoyé depuis la machine d’exécution sélectionnée vers le point de terminaison compatible OpenAI que vous configurez. Son opérateur peut conserver les données reçues selon ses propres conditions.',
          },
        },
        {
          locale: 'it',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': 'L’audio per la trascrizione viene inviato dalla macchina di esecuzione selezionata all’endpoint compatibile con OpenAI configurato. Il gestore dell’endpoint può conservare i dati ricevuti secondo le proprie condizioni.',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': 'Il testo della risposta per la sintesi vocale viene inviato dalla macchina di esecuzione selezionata all’endpoint compatibile con OpenAI configurato. Il gestore dell’endpoint può conservare i dati ricevuti secondo le proprie condizioni.',
          },
        },
        {
          locale: 'pt',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': 'O áudio para transcrição é enviado da máquina de execução selecionada para o endpoint compatível com OpenAI que configurar. O operador do endpoint pode conservar os dados recebidos de acordo com os respetivos termos.',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': 'O texto da resposta para síntese de voz é enviado da máquina de execução selecionada para o endpoint compatível com OpenAI que configurar. O operador do endpoint pode conservar os dados recebidos de acordo com os respetivos termos.',
          },
        },
        {
          locale: 'ca',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': 'L’àudio per a la transcripció s’envia des de la màquina d’execució seleccionada al punt final compatible amb OpenAI que configuris. L’operador del punt final pot conservar les dades rebudes segons les seves condicions.',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': 'El text de la resposta per a la síntesi de veu s’envia des de la màquina d’execució seleccionada al punt final compatible amb OpenAI que configuris. L’operador del punt final pot conservar les dades rebudes segons les seves condicions.',
          },
        },
        {
          locale: 'zh-Hans',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': '用于转录的音频会从所选执行计算机发送到您配置的 OpenAI 兼容端点。端点运营商可能会根据其自身条款保留收到的数据。',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': '用于语音合成的回复文本会从所选执行计算机发送到您配置的 OpenAI 兼容端点。端点运营商可能会根据其自身条款保留收到的数据。',
          },
        },
        {
          locale: 'zh-Hant',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': '用於轉錄的音訊會從所選執行電腦傳送至您設定的 OpenAI 相容端點。端點營運商可能會依其自身條款保留收到的資料。',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': '用於語音合成的回覆文字會從所選執行電腦傳送至您設定的 OpenAI 相容端點。端點營運商可能會依其自身條款保留收到的資料。',
          },
        },
        {
          locale: 'ja',
          messages: {
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt': '文字起こし用の音声は、選択した実行マシンから設定済みの OpenAI 互換エンドポイントへ送信されます。エンドポイントの運営者は、独自の規約に従って受信データを保持する場合があります。',
            'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts': '音声合成用の応答テキストは、選択した実行マシンから設定済みの OpenAI 互換エンドポイントへ送信されます。エンドポイントの運営者は、独自の規約に従って受信データを保持する場合があります。',
          },
        },
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
            key: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt',
            fallback: 'Audio for transcription is sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.',
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
            key: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts',
            fallback: 'Reply text for speech synthesis is sent from the selected execution machine to the OpenAI-compatible endpoint you configure. The endpoint operator may retain received data according to its own terms.',
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
