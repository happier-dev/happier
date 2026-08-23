import {
  VoiceCredentialSlotIdSchema,
  type VoiceProviderContribution,
} from '@happier-dev/plugin-sdk/voice';

type SpeechVoiceProviderDeclaration = Omit<Extract<VoiceProviderContribution, { kind: 'speech' }>, 'id'>;
const GOOGLE_API_KEY_VOICE_CREDENTIAL_SLOT_ID = VoiceCredentialSlotIdSchema.parse('api_key');

export const GOOGLE_GEMINI_STT_VOICE_PROVIDER_DECLARATION = {
  title: 'Google Gemini Speech-to-Text',
  kind: 'speech',
  roles: ['dictation_stt', 'conversation_stt'],
  platforms: ['web', 'ios', 'android'],
  credentials: {
    slot: {
      id: GOOGLE_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
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
      key: 'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure',
      fallback: 'Audio sent for transcription is processed by Google Gemini. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
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
} satisfies SpeechVoiceProviderDeclaration;

export const GOOGLE_CLOUD_TTS_VOICE_PROVIDER_DECLARATION = {
  title: 'Google Cloud Text-to-Speech',
  kind: 'speech',
  roles: ['conversation_tts'],
  platforms: ['web', 'ios', 'android'],
  credentials: {
    slot: {
      id: GOOGLE_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
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
      key: 'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure',
      fallback: 'Text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
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
} satisfies SpeechVoiceProviderDeclaration;

export const GOOGLE_VOICE_UI = {
  translations: [
    {
      locale: 'en',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': 'Audio sent for transcription is processed by Google Gemini. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': 'Text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
      },
    },
    {
      locale: 'ru',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': 'Аудио, отправленное на транскрипцию, обрабатывается Google Gemini. Happier отправляет эти запросы через выбранную исполнительную машину, используя учетные данные Google API этой машины. Google может сохранять полученные данные в соответствии с настройками выбранной учетной записи Google и условиями Google.',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': 'Текст, отправленный на речь, обрабатывается Google Cloud Text-to-Speech. Happier отправляет эти запросы через выбранную исполнительную машину, используя учетные данные Google API этой машины. Google может сохранять полученные данные в соответствии с настройками выбранной учетной записи Google и условиями Google.',
      },
    },
    {
      locale: 'pl',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': 'Dźwięk przesyłany do transkrypcji jest przetwarzany przez Google Gemini. Happier wysyła te żądania za pośrednictwem wybranej maszyny wykonawczej, korzystając z danych uwierzytelniających Google API tej maszyny. Google może zachować otrzymane dane zgodnie z wybranymi ustawieniami konta Google i warunkami Google.',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': 'Tekst przesyłany do mowy jest przetwarzany przez Google Cloud Text-to-Speech. Happier wysyła te żądania za pośrednictwem wybranej maszyny wykonawczej, korzystając z danych uwierzytelniających Google API tej maszyny. Google może zachować otrzymane dane zgodnie z wybranymi ustawieniami konta Google i warunkami Google.',
      },
    },
    {
      locale: 'es',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': 'El audio enviado para transcripción lo procesa Google Gemini. Happier envía estas solicitudes a través de la máquina de ejecución seleccionada utilizando la credencial API de Google de esa máquina. Google puede conservar los datos recibidos de acuerdo con la configuración de la cuenta de Google seleccionada y los términos de Google.',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': 'El texto enviado para voz lo procesa Google Cloud Text-to-Speech. Happier envía estas solicitudes a través de la máquina de ejecución seleccionada utilizando la credencial API de Google de esa máquina. Google puede conservar los datos recibidos de acuerdo con la configuración de la cuenta de Google seleccionada y los términos de Google.',
      },
    },
    {
      locale: 'fr',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': 'L\'audio envoyé pour transcription est traité par Google Gemini. Happier envoie ces requêtes via la machine d\'exécution sélectionnée à l\'aide des informations d\'identification de l\'API Google de cette machine. Google peut conserver les données reçues conformément aux paramètres du compte Google sélectionné et aux conditions de Google.',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': 'Le texte envoyé pour la parole est traité par Google Cloud Text-to-Speech. Happier envoie ces requêtes via la machine d\'exécution sélectionnée à l\'aide des informations d\'identification de l\'API Google de cette machine. Google peut conserver les données reçues conformément aux paramètres du compte Google sélectionné et aux conditions de Google.',
      },
    },
    {
      locale: 'it',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': 'L\'audio inviato per la trascrizione viene elaborato da Google Gemini. Happier invia queste richieste attraverso la macchina di esecuzione selezionata utilizzando le credenziali API di Google di quella macchina. Google può conservare i dati ricevuti in base alle impostazioni dell\'account Google selezionato e ai termini di Google.',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': 'Il testo inviato per la sintesi vocale viene elaborato da Google Cloud Text-to-Speech. Happier invia queste richieste attraverso la macchina di esecuzione selezionata utilizzando le credenziali API di Google di quella macchina. Google può conservare i dati ricevuti in base alle impostazioni dell\'account Google selezionato e ai termini di Google.',
      },
    },
    {
      locale: 'pt',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': 'O áudio enviado para transcrição é processado pelo Google Gemini. Happier envia essas solicitações por meio da máquina de execução selecionada usando a credencial da API do Google dessa máquina. O Google pode reter os dados recebidos de acordo com as configurações da conta do Google selecionada e os termos do Google.',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': 'O texto enviado para fala é processado pelo Google Cloud Text-to-Speech. Happier envia essas solicitações por meio da máquina de execução selecionada usando a credencial da API do Google dessa máquina. O Google pode reter os dados recebidos de acordo com as configurações da conta do Google selecionada e os termos do Google.',
      },
    },
    {
      locale: 'ca',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': 'Google Gemini processa l\'àudio enviat per a la transcripció. Happier envia aquestes sol·licituds a través de la màquina d\'execució seleccionada mitjançant la credencial de l\'API de Google d\'aquesta màquina. Google pot conservar les dades rebudes d\'acord amb la configuració del compte de Google seleccionat i els termes de Google.',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': 'Google Cloud Text-to-Speech processa el text enviat per a la veu. Happier envia aquestes sol·licituds a través de la màquina d\'execució seleccionada mitjançant la credencial de l\'API de Google d\'aquesta màquina. Google pot conservar les dades rebudes d\'acord amb la configuració del compte de Google seleccionat i els termes de Google.',
      },
    },
    {
      locale: 'zh-Hans',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': '发送用于转录的音频由 Google Gemini 处理。Happier 使用该机器的 Google API 凭证通过选定的执行机器发送这些请求。Google 可能会根据所选 Google 帐户的设置和 Google 条款保留收到的数据。',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': '发送用于语音的文本由 Google Cloud 文本转语音处理。Happier 使用该机器的 Google API 凭证通过选定的执行机器发送这些请求。Google 可能会根据所选 Google 帐户的设置和 Google 条款保留收到的数据。',
      },
    },
    {
      locale: 'zh-Hant',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': '發送用於轉錄的音訊由 Google Gemini 處理。Happier 使用該機器的 Google API 認證透過選定的執行機器發送這些請求。Google 可能會根據所選 Google 帳戶的設定和 Google 條款保留收到的資料。',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': '發送用於語音的文字由 Google Cloud 文字轉語音處理。Happier 使用該機器的 Google API 認證透過選定的執行機器發送這些請求。Google 可能會根據所選 Google 帳戶的設定和 Google 條款保留收到的資料。',
      },
    },
    {
      locale: 'ja',
      messages: {
        'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure': '文字起こしのために送信された音声は Google Gemini によって処理されます。Happier は、選択した実行マシンの Google API 認証情報を使用して、これらのリクエストをそのマシン経由で送信します。Google は、選択した Google アカウントの設定および Google の規約に従って、受信したデータを保持する場合があります。',
        'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure': '音声として送信されたテキストは Google Cloud Text-to-Speech によって処理されます。Happier は、選択した実行マシンの Google API 認証情報を使用して、これらのリクエストをそのマシン経由で送信します。Google は、選択した Google アカウントの設定および Google の規約に従って、受信したデータを保持する場合があります。',
      },
    },
  ],
};
