import { definePlugin } from '@happier-dev/plugin-sdk';
import { VoiceCredentialSlotIdSchema } from '@happier-dev/plugin-sdk/voice';

import { ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION_ID } from './constants.js';
import { ELEVENLABS_SETTINGS_SECTION } from './voiceSettingsPresentation.js';

const ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID = VoiceCredentialSlotIdSchema.parse('api_key');
const ELEVENLABS_PROCESSING_DISCLOSURE_KEY = 'settingsVoice.realtimeProviders.elevenLabs.privacyDisclosure';
const ELEVENLABS_PROCESSING_DISCLOSURE_FALLBACK = 'Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing.';

export const ELEVENLABS_PLUGIN = definePlugin({
  id: 'happier.voice.elevenlabs',
  version: '0.0.0',
  displayName: 'ElevenLabs Voice',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  hostAccess: { required: [], optional: [] },
  ui: {
    translations: [
      {
        locale: 'en',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: ELEVENLABS_PROCESSING_DISCLOSURE_FALLBACK,
        },
      },
      {
        locale: 'ru',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: 'Аудио и содержимое разговора отправляются с этого устройства в ElevenLabs через клиентское подключение ElevenLabs. В зависимости от выбранной настройки Happier также может отправлять в ElevenLabs ограниченные инструкции агента, определения и результаты клиентских инструментов, а также запросы аутентификации или подготовки, необходимые для функции. Сервер Happier может участвовать в размещённой аутентификации и учёте использования, но ни сервер Happier, ни ретранслятор не передают аудио живого разговора. ElevenLabs может обрабатывать и хранить полученные данные в соответствии с настройками вашей учётной записи ElevenLabs и его условиями. Элементы управления обменом голосовым контекстом отделены от обработки этим провайдером.',
        },
      },
      {
        locale: 'pl',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: 'Dźwięk i treść rozmowy są wysyłane z tego urządzenia do ElevenLabs przez połączenie klienta ElevenLabs. W zależności od wybranej konfiguracji Happier może również wysyłać do ElevenLabs ograniczone instrukcje agenta, definicje i wyniki narzędzi klienckich oraz żądania uwierzytelniania lub provisioningu wymagane przez tę funkcję. Serwer Happier może uczestniczyć w hostowanym uwierzytelnianiu i rozliczaniu użycia, ale ani serwer Happier, ani przekaźnik nie przesyłają dźwięku rozmowy na żywo. ElevenLabs może przetwarzać i przechowywać otrzymane dane zgodnie z ustawieniami Twojego konta ElevenLabs i jego warunkami. Kontrolki udostępniania kontekstu głosowego są odrębne od przetwarzania przez tego dostawcę.',
        },
      },
      {
        locale: 'es',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: 'El audio y el contenido de la conversación se envían desde este dispositivo a ElevenLabs mediante la conexión del cliente de ElevenLabs. Según la configuración seleccionada, Happier también puede enviar a ElevenLabs instrucciones acotadas del agente, definiciones y resultados de herramientas del cliente, y solicitudes de autenticación o aprovisionamiento necesarias para la función. El servidor de Happier puede participar en la autenticación alojada y la contabilidad de uso, pero ni el servidor de Happier ni el relé transportan el audio de la conversación en directo. ElevenLabs puede procesar y conservar los datos recibidos según la configuración y los términos de tu cuenta de ElevenLabs. Los controles para compartir el contexto de voz son independientes del procesamiento por este proveedor.',
        },
      },
      {
        locale: 'fr',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: 'L’audio et le contenu de la conversation sont envoyés depuis cet appareil à ElevenLabs via la connexion cliente d’ElevenLabs. Selon la configuration choisie, Happier peut également envoyer à ElevenLabs des instructions d’agent limitées, des définitions et résultats d’outils côté client, ainsi que les demandes d’authentification ou de provisionnement nécessaires à cette fonctionnalité. Le serveur Happier peut participer à l’authentification hébergée et à la comptabilisation de l’utilisation, mais ni le serveur Happier ni le relais ne transportent l’audio de la conversation en direct. ElevenLabs peut traiter et conserver les données reçues selon les paramètres et les conditions de votre compte ElevenLabs. Les contrôles de partage du contexte vocal sont distincts du traitement par ce fournisseur.',
        },
      },
      {
        locale: 'it',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: 'L’audio e il contenuto della conversazione vengono inviati da questo dispositivo a ElevenLabs tramite la connessione client di ElevenLabs. A seconda della configurazione selezionata, Happier può anche inviare a ElevenLabs istruzioni limitate per l’agente, definizioni e risultati degli strumenti client e richieste di autenticazione o provisioning necessarie per la funzione. Il server di Happier può partecipare all’autenticazione ospitata e alla contabilizzazione dell’utilizzo, ma né il server di Happier né il relay trasportano l’audio della conversazione in diretta. ElevenLabs può elaborare e conservare i dati ricevuti secondo le impostazioni e i termini del tuo account ElevenLabs. I controlli di condivisione del contesto vocale sono separati dall’elaborazione di questo provider.',
        },
      },
      {
        locale: 'pt',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: 'O áudio e o conteúdo da conversa são enviados deste dispositivo para a ElevenLabs através da ligação do cliente ElevenLabs. Consoante a configuração selecionada, a Happier também pode enviar à ElevenLabs instruções limitadas do agente, definições e resultados de ferramentas do cliente e pedidos de autenticação ou aprovisionamento necessários para a funcionalidade. O servidor da Happier pode participar na autenticação alojada e na contabilização de utilização, mas nem o servidor da Happier nem o relay transportam o áudio da conversa em direto. A ElevenLabs pode processar e reter os dados recebidos de acordo com as definições e os termos da sua conta ElevenLabs. Os controlos de partilha de contexto de voz são separados do processamento por este fornecedor.',
        },
      },
      {
        locale: 'ca',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: 'L’àudio i el contingut de la conversa s’envien des d’aquest dispositiu a ElevenLabs mitjançant la connexió del client d’ElevenLabs. Segons la configuració seleccionada, Happier també pot enviar a ElevenLabs instruccions limitades de l’agent, definicions i resultats d’eines del client, i sol·licituds d’autenticació o aprovisionament necessàries per a la funció. El servidor de Happier pot participar en l’autenticació allotjada i la comptabilització d’ús, però ni el servidor de Happier ni el relé transporten l’àudio de la conversa en directe. ElevenLabs pot processar i conservar les dades rebudes segons la configuració i les condicions del vostre compte d’ElevenLabs. Els controls per compartir el context de veu són independents del processament per aquest proveïdor.',
        },
      },
      {
        locale: 'de',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: 'Audio und Gesprächsinhalte werden von diesem Gerät über die ElevenLabs-Clientverbindung an ElevenLabs gesendet. Abhängig von der ausgewählten Einrichtung kann Happier außerdem begrenzte Agentenanweisungen, Client-Tool-Definitionen und -Ergebnisse sowie für die Funktion erforderliche Authentifizierungs- oder Bereitstellungsanfragen an ElevenLabs senden. Der Happier-Server kann an gehosteter Authentifizierung und Nutzungsabrechnung beteiligt sein, aber weder der Happier-Server noch das Relay übertragen Live-Gesprächsaudio. ElevenLabs kann empfangene Daten gemäß den Einstellungen und Bedingungen Ihres ElevenLabs-Kontos verarbeiten und speichern. Steuerelemente zur Freigabe des Sprachkontexts sind von der Verarbeitung durch diesen Anbieter getrennt.',
        },
      },
      {
        locale: 'zh-Hans',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: '音频和对话内容会通过 ElevenLabs 客户端连接从此设备发送到 ElevenLabs。根据所选设置，Happier 还可能向 ElevenLabs 发送受限的代理指令、客户端工具定义和结果，以及此功能所需的身份验证或预配请求。Happier 服务器可能参与托管身份验证和使用情况核算，但 Happier 服务器和中继均不传输实时对话音频。ElevenLabs 可能会根据您的 ElevenLabs 帐户设置和其条款处理并保留收到的数据。语音上下文共享控件独立于此提供商的处理。',
        },
      },
      {
        locale: 'zh-Hant',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: '音訊和對話內容會透過 ElevenLabs 用戶端連線從此裝置傳送至 ElevenLabs。根據所選設定，Happier 也可能向 ElevenLabs 傳送受限的代理程式指示、用戶端工具定義和結果，以及此功能所需的驗證或佈建請求。Happier 伺服器可能參與代管驗證和使用量核算，但 Happier 伺服器和轉送均不傳輸即時對話音訊。ElevenLabs 可能會根據您的 ElevenLabs 帳戶設定和其條款處理並保留收到的資料。語音脈絡共用控制項獨立於此提供者的處理。',
        },
      },
      {
        locale: 'ja',
        messages: {
          [ELEVENLABS_PROCESSING_DISCLOSURE_KEY]: '音声と会話内容は、このデバイスから ElevenLabs クライアント接続を通じて ElevenLabs に送信されます。選択した設定に応じて、Happier は限定されたエージェント指示、クライアントツールの定義と結果、およびこの機能に必要な認証またはプロビジョニング要求も ElevenLabs に送信することがあります。Happier のサーバーはホスト型認証と使用量計測に関与する場合がありますが、Happier のサーバーもリレーもライブ会話音声を転送しません。ElevenLabs は、受信したデータをお客様の ElevenLabs アカウント設定およびその規約に従って処理・保持する場合があります。音声コンテキスト共有の制御は、このプロバイダーによる処理とは別です。',
        },
      },
    ],
  },
  voiceProviders: {
    [ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION_ID]: {
      declaration: {
        title: 'ElevenLabs Voice',
        kind: 'conversation',
        roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
        platforms: ['web', 'ios', 'android'],
        capabilities: {
          turn: {
            cancelResponse: false,
            bargeIn: false,
            exactMessage: true,
            interruptionPolicy: 'disabled',
          },
          tools: { effectCalls: 'none' },
        },
        settings: {
          schemaVersion: 2,
          presentation: JSON.parse(JSON.stringify(ELEVENLABS_SETTINGS_SECTION)),
          privacyDisclosure: {
            key: ELEVENLABS_PROCESSING_DISCLOSURE_KEY,
            fallback: ELEVENLABS_PROCESSING_DISCLOSURE_FALLBACK,
          },
          fields: [
            {
              id: 'billingMode',
              title: 'Billing mode',
              schema: {
                type: 'string',
                enum: ['happier', 'byo'],
              },
              default: 'happier',
              presentation: {
                control: 'select',
                options: [
                  { value: 'happier', title: 'Happier hosted' },
                  { value: 'byo', title: 'Bring your own ElevenLabs account' },
                ],
              },
            },
            {
              id: 'tts',
              title: 'Text-to-speech configuration',
              schema: {
                type: 'object',
                properties: {
                  voiceId: { type: 'string', minLength: 1, maxLength: 256 },
                  modelId: {
                    anyOf: [
                      { type: 'string', minLength: 1, maxLength: 256 },
                      { type: 'null' },
                    ],
                  },
                  voiceSettings: {
                    type: 'object',
                    properties: {
                      stability: {
                        anyOf: [
                          { type: 'number', minimum: 0, maximum: 1 },
                          { type: 'null' },
                        ],
                      },
                      similarityBoost: {
                        anyOf: [
                          { type: 'number', minimum: 0, maximum: 1 },
                          { type: 'null' },
                        ],
                      },
                      speed: {
                        anyOf: [
                          { type: 'number', minimum: 0.7, maximum: 1.2 },
                          { type: 'null' },
                        ],
                      },
                    },
                    required: [
                      'stability',
                      'similarityBoost',
                      'speed',
                    ],
                    additionalProperties: false,
                  },
                },
                required: ['voiceId', 'modelId', 'voiceSettings'],
                additionalProperties: false,
              },
              default: {
                voiceId: 'hpp4J3VqNfWAUOO0d1Us',
                modelId: null,
                voiceSettings: {
                  stability: null,
                  similarityBoost: null,
                  speed: null,
                },
              },
              presentation: { control: 'json' },
            },
            {
              id: 'agentId',
              title: 'ElevenLabs Agent ID',
              schema: {
                type: 'string',
                minLength: 0,
                maxLength: 256,
                pattern: '^[A-Za-z0-9_-]*$',
              },
              default: '',
              presentation: { control: 'text' },
            },
          ],
          readiness: [{
            kind: 'setting_nonempty',
            settingId: 'agentId',
            when: { settingId: 'billingMode', equals: 'byo' },
          }],
          actions: [
            {
              id: 'create-agent',
              title: 'Create Happier Voice agent',
              placement: { kind: 'afterField', fieldId: 'agentId' },
              confirmation: {
                kind: 'required',
                title: 'Create ElevenLabs agent?',
                description: 'Creates a Happier Voice agent and its client tools in the selected ElevenLabs account.',
                confirmLabel: 'Create agent',
              },
              patchFieldIds: ['agentId'],
            },
            {
              id: 'update-agent',
              title: 'Update Happier Voice agent',
              placement: { kind: 'afterField', fieldId: 'agentId' },
              enabledWhen: { kind: 'setting_nonempty', settingId: 'agentId' },
              confirmation: {
                kind: 'required',
                title: 'Update ElevenLabs agent?',
                description: 'Reconciles the configured Happier Voice agent and its client tools in the selected ElevenLabs account.',
                confirmLabel: 'Update agent',
              },
              patchFieldIds: ['agentId'],
            },
          ],
        },
        credentials: {
          slot: {
            id: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
            purpose: 'voice.client-auth.elevenlabs',
            title: 'ElevenLabs API key',
            description: 'Used only for BYO conversation authentication, voice catalogs, and explicit agent settings actions.',
          },
          requirement: {
            kind: 'when_setting_equals',
            settingId: 'billingMode',
            value: 'byo',
          },
          sources: [{
            kind: 'savedSecret',
            secretKinds: ['apiKey'],
            operationProjections: [
              { kind: 'recipientCredential', operation: 'signed-url', phase: 'prepare', format: 'raw' },
              { kind: 'recipientCredential', operation: 'conversation-token', phase: 'prepare', format: 'raw' },
              { kind: 'recipientCredential', operation: 'voices', phase: 'settings', format: 'raw' },
              { kind: 'recipientCredential', operation: 'agents', phase: 'settings', format: 'raw' },
              { kind: 'recipientCredential', operation: 'agent', phase: 'settings', format: 'raw' },
              { kind: 'recipientCredential', operation: 'tools', phase: 'settings', format: 'raw' },
              { kind: 'recipientCredential', operation: 'create-tool', phase: 'settings', format: 'raw' },
              { kind: 'recipientCredential', operation: 'delete-tool', phase: 'settings', format: 'raw' },
              { kind: 'recipientCredential', operation: 'create-agent', phase: 'settings', format: 'raw' },
              { kind: 'recipientCredential', operation: 'update-agent', phase: 'settings', format: 'raw' },
            ],
          }],
          hostMediated: { operations: [
            {
              id: 'signed-url',
              purpose: 'voice.client-auth.signed-url',
              credentialSlotId: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
              effect: 'read',
              request: {
                origin: 'https://api.elevenlabs.io',
                pathTemplate: '/v1/convai/conversation/get-signed-url',
                queryTemplate: [],
                headerTemplate: [{ name: 'accept', value: 'application/json' }],
                bodyTemplate: { kind: 'none' },
                method: 'GET',
                credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                redirect: 'error',
                maxBodyBytes: 0,
                contentTypes: [],
              },
              parameters: {
                schema: {
                  type: 'object',
                  properties: { agentId: { type: 'string', minLength: 1, maxLength: 256 } },
                  required: ['agentId'],
                  additionalProperties: false,
                },
                mapping: [{ parameter: 'agentId', target: { kind: 'query', name: 'agent_id' } }],
              },
              response: { maxBytes: 32768, contentTypes: ['application/json'] },
            },
            {
              id: 'conversation-token',
              purpose: 'voice.client-auth.sdk-token',
              credentialSlotId: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
              effect: 'read',
              request: {
                origin: 'https://api.elevenlabs.io',
                pathTemplate: '/v1/convai/conversation/token',
                queryTemplate: [],
                headerTemplate: [{ name: 'accept', value: 'application/json' }],
                bodyTemplate: { kind: 'none' },
                method: 'GET',
                credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                redirect: 'error',
                maxBodyBytes: 0,
                contentTypes: [],
              },
              parameters: {
                schema: {
                  type: 'object',
                  properties: { agentId: { type: 'string', minLength: 1, maxLength: 256 } },
                  required: ['agentId'],
                  additionalProperties: false,
                },
                mapping: [{ parameter: 'agentId', target: { kind: 'query', name: 'agent_id' } }],
              },
              response: { maxBytes: 32768, contentTypes: ['application/json'] },
            },
            {
              id: 'voices',
              purpose: 'voice.catalog.voices',
              credentialSlotId: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
              effect: 'read',
              request: {
                origin: 'https://api.elevenlabs.io',
                pathTemplate: '/v1/voices',
                queryTemplate: [],
                headerTemplate: [{ name: 'accept', value: 'application/json' }],
                bodyTemplate: { kind: 'none' },
                method: 'GET',
                credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                redirect: 'error',
                maxBodyBytes: 0,
                contentTypes: [],
              },
              parameters: {
                schema: { type: 'object', properties: {}, additionalProperties: false },
                mapping: [],
              },
              response: { maxBytes: 2097152, contentTypes: ['application/json'] },
            },
            {
              id: 'agents',
              purpose: 'voice.provision.agents.list',
              credentialSlotId: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
              effect: 'read',
              request: {
                origin: 'https://api.elevenlabs.io',
                pathTemplate: '/v1/convai/agents',
                queryTemplate: [
                  { name: 'page_size', value: '50' },
                  { name: 'search', value: 'Happier Voice' },
                ],
                headerTemplate: [{ name: 'accept', value: 'application/json' }],
                bodyTemplate: { kind: 'none' },
                method: 'GET',
                credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                redirect: 'error',
                maxBodyBytes: 0,
                contentTypes: [],
              },
              parameters: {
                schema: {
                  type: 'object',
                  properties: {
                    cursor: { type: 'string', minLength: 1, maxLength: 512 },
                  },
                  additionalProperties: false,
                },
                mapping: [{ parameter: 'cursor', target: { kind: 'query', name: 'cursor' } }],
              },
              response: { maxBytes: 2097152, contentTypes: ['application/json'] },
            },
            {
              id: 'agent',
              purpose: 'voice.provision.agent.get',
              credentialSlotId: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
              effect: 'read',
              request: {
                origin: 'https://api.elevenlabs.io',
                pathTemplate: '/v1/convai/agents/{agentId}',
                queryTemplate: [],
                headerTemplate: [{ name: 'accept', value: 'application/json' }],
                bodyTemplate: { kind: 'none' },
                method: 'GET',
                credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                redirect: 'error',
                maxBodyBytes: 0,
                contentTypes: [],
              },
              parameters: {
                schema: {
                  type: 'object',
                  properties: {
                    agentId: { type: 'string', minLength: 1, maxLength: 256 },
                  },
                  required: ['agentId'],
                  additionalProperties: false,
                },
                mapping: [{
                  parameter: 'agentId',
                  target: { kind: 'path', placeholder: 'agentId', encoding: 'uri_component' },
                }],
              },
              response: { maxBytes: 2097152, contentTypes: ['application/json'] },
            },
            {
              id: 'tools',
              purpose: 'voice.provision.tools.list',
              credentialSlotId: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
              effect: 'read',
              request: {
                origin: 'https://api.elevenlabs.io',
                pathTemplate: '/v1/convai/tools',
                queryTemplate: [{ name: 'page_size', value: '100' }],
                headerTemplate: [{ name: 'accept', value: 'application/json' }],
                bodyTemplate: { kind: 'none' },
                method: 'GET',
                credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                redirect: 'error',
                maxBodyBytes: 0,
                contentTypes: [],
              },
              parameters: {
                schema: {
                  type: 'object',
                  properties: {
                    cursor: { type: 'string', minLength: 1, maxLength: 512 },
                  },
                  additionalProperties: false,
                },
                mapping: [{ parameter: 'cursor', target: { kind: 'query', name: 'cursor' } }],
              },
              response: { maxBytes: 2097152, contentTypes: ['application/json'] },
            },
            {
              id: 'create-tool',
              purpose: 'voice.provision.tool.create',
              credentialSlotId: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
              effect: 'mutation',
              request: {
                origin: 'https://api.elevenlabs.io',
                pathTemplate: '/v1/convai/tools',
                queryTemplate: [],
                headerTemplate: [
                  { name: 'accept', value: 'application/json' },
                  { name: 'content-type', value: 'application/json' },
                ],
                bodyTemplate: { kind: 'json', value: {} },
                method: 'POST',
                credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                redirect: 'error',
                maxBodyBytes: 524288,
                contentTypes: ['application/json'],
              },
              parameters: {
                schema: {
                  type: 'object',
                  properties: { body: { type: 'object', additionalProperties: true } },
                  required: ['body'],
                  additionalProperties: false,
                },
                mapping: [{ parameter: 'body', target: { kind: 'body', pointer: '' } }],
              },
              response: { maxBytes: 2097152, contentTypes: ['application/json'] },
            },
            {
              id: 'delete-tool',
              purpose: 'voice.provision.tool.delete',
              credentialSlotId: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
              effect: 'mutation',
              request: {
                origin: 'https://api.elevenlabs.io',
                pathTemplate: '/v1/convai/tools/{toolId}',
                queryTemplate: [{ name: 'force', value: 'false' }],
                headerTemplate: [{ name: 'accept', value: 'application/json' }],
                bodyTemplate: { kind: 'none' },
                method: 'DELETE',
                credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                redirect: 'error',
                maxBodyBytes: 0,
                contentTypes: [],
              },
              parameters: {
                schema: {
                  type: 'object',
                  properties: {
                    toolId: { type: 'string', minLength: 1, maxLength: 256 },
                  },
                  required: ['toolId'],
                  additionalProperties: false,
                },
                mapping: [{
                  parameter: 'toolId',
                  target: { kind: 'path', placeholder: 'toolId', encoding: 'uri_component' },
                }],
              },
              response: { maxBytes: 2097152, contentTypes: ['application/json'] },
            },
            {
              id: 'create-agent',
              purpose: 'voice.provision.agent.create',
              credentialSlotId: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
              effect: 'mutation',
              request: {
                origin: 'https://api.elevenlabs.io',
                pathTemplate: '/v1/convai/agents/create',
                queryTemplate: [],
                headerTemplate: [
                  { name: 'accept', value: 'application/json' },
                  { name: 'content-type', value: 'application/json' },
                ],
                bodyTemplate: { kind: 'json', value: {} },
                method: 'POST',
                credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                redirect: 'error',
                maxBodyBytes: 524288,
                contentTypes: ['application/json'],
              },
              parameters: {
                schema: {
                  type: 'object',
                  properties: { body: { type: 'object', additionalProperties: true } },
                  required: ['body'],
                  additionalProperties: false,
                },
                mapping: [{ parameter: 'body', target: { kind: 'body', pointer: '' } }],
              },
              response: { maxBytes: 2097152, contentTypes: ['application/json'] },
            },
            {
              id: 'update-agent',
              purpose: 'voice.provision.agent.update',
              credentialSlotId: ELEVENLABS_API_KEY_VOICE_CREDENTIAL_SLOT_ID,
              effect: 'mutation',
              request: {
                origin: 'https://api.elevenlabs.io',
                pathTemplate: '/v1/convai/agents/{agentId}',
                queryTemplate: [],
                headerTemplate: [
                  { name: 'accept', value: 'application/json' },
                  { name: 'content-type', value: 'application/json' },
                ],
                bodyTemplate: { kind: 'json', value: {} },
                method: 'PATCH',
                credential: { kind: 'httpHeader', name: 'xi-api-key', format: 'raw' },
                redirect: 'error',
                maxBodyBytes: 524288,
                contentTypes: ['application/json'],
              },
              parameters: {
                schema: {
                  type: 'object',
                  properties: {
                    agentId: { type: 'string', minLength: 1, maxLength: 256 },
                    body: { type: 'object', additionalProperties: true },
                  },
                  required: ['agentId', 'body'],
                  additionalProperties: false,
                },
                mapping: [
                  { parameter: 'agentId', target: { kind: 'path', placeholder: 'agentId', encoding: 'uri_component' } },
                  { parameter: 'body', target: { kind: 'body', pointer: '' } },
                ],
              },
              response: { maxBytes: 2097152, contentTypes: ['application/json'] },
            },
          ] },
        },
        client: {
          artifactId: 'voice-runtime',
          modulePath: './ui/voice',
          exportName: 'activate',
        },
      },
    },
  },
});

export const PLUGIN_MANIFEST = ELEVENLABS_PLUGIN.manifest;
