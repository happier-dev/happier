export const voiceProviderPrivacyTranslations = {
  en: {
    openai: {
      privacyDisclosure: 'Audio and conversation content are sent from this device to OpenAI using WebRTC. Happier uses the selected Saved Voice API key, OpenAI Connected Service, or experimental Codex OAuth account to mint short-lived client authentication; connected accounts are accessed through the selected machine. OpenAI processes the live conversation under the selected account and may retain received data according to that account’s settings and OpenAI’s terms. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
    },
    xai: {
      privacyDisclosure: 'Audio and conversation content are sent from this device to xAI through the xAI Realtime connection. Happier uses the xAI API key saved in your Happier account secrets only for the bounded client-auth and voice-catalog operations. xAI processes the live conversation under that account and may retain received data according to the account settings and xAI’s terms. If resumption is enabled, Happier saves the provider conversation ID; forgetting it removes Happier’s saved ID and does not delete data held by xAI. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
    },
    google: {
      privacyDisclosure: 'Audio sent for transcription is processed by Google Gemini, and text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
    },
    resumption: {
      forgetTitle: 'Forget Happier resumption ID',
      forgetSubtitle: 'Remove Happier’s saved provider conversation ID. This does not delete the conversation or data held by xAI.',
      forgotten: 'Happier removed its saved provider conversation ID.',
      unsupported: 'Happier cannot remove the saved provider conversation ID from this session.',
      failed: 'Happier could not remove its saved provider conversation ID. Please try again.',
    },
  },
  ru: {
    openai: { privacyDisclosure: 'Аудио и содержимое разговора отправляются с этого устройства в OpenAI через WebRTC. Happier использует выбранный сохранённый ключ Voice API, подключённый сервис OpenAI или экспериментальную учётную запись Codex OAuth для получения краткосрочной клиентской авторизации; подключённые учётные записи используются через выбранную машину. OpenAI обрабатывает разговор в выбранной учётной записи и может хранить полученные данные согласно настройкам этой учётной записи и условиям OpenAI. Сервер и relay Happier не передают живое аудио. Настройки передачи контекста Voice отделены от этой обработки провайдером.' },
    xai: { privacyDisclosure: 'Аудио и содержимое разговора отправляются с этого устройства в xAI через соединение xAI Realtime. Happier использует ключ xAI API, сохранённый в секретах вашей учётной записи Happier, только для ограниченных операций клиентской авторизации и каталога голосов. xAI обрабатывает разговор в этой учётной записи и может хранить полученные данные согласно настройкам учётной записи и условиям xAI. Если возобновление включено, Happier сохраняет идентификатор разговора провайдера; забывание удаляет сохранённый в Happier идентификатор и не удаляет данные, хранящиеся в xAI. Сервер и relay Happier не передают живое аудио.' },
    google: { privacyDisclosure: 'Аудио для распознавания обрабатывается Google Gemini, а текст для озвучивания — Google Cloud Text-to-Speech. Happier отправляет эти запросы через выбранную машину, используя её учётные данные Google API. Google может хранить полученные данные согласно настройкам выбранной учётной записи Google и условиям Google.' },
    resumption: {
      forgetTitle: 'Забыть идентификатор возобновления в Happier',
      forgetSubtitle: 'Удалить сохранённый в Happier идентификатор разговора провайдера. Это не удаляет разговор или данные, хранящиеся в xAI.',
      forgotten: 'Happier удалил сохранённый идентификатор разговора провайдера.',
      unsupported: 'Happier не может удалить сохранённый идентификатор разговора провайдера из этой сессии.',
      failed: 'Happier не удалось удалить сохранённый идентификатор разговора провайдера. Повторите попытку.',
    },
  },
  pl: {
    openai: { privacyDisclosure: 'Dźwięk i treść rozmowy są wysyłane z tego urządzenia do OpenAI przez WebRTC. Happier używa wybranego zapisanego klucza Voice API, usługi połączonej OpenAI lub eksperymentalnego konta Codex OAuth, aby uzyskać krótkotrwałe uwierzytelnienie klienta; konta połączone są używane przez wybraną maszynę. OpenAI przetwarza rozmowę na wybranym koncie i może przechowywać otrzymane dane zgodnie z ustawieniami tego konta i warunkami OpenAI. Serwer i relay Happier nie przenoszą dźwięku na żywo.' },
    xai: { privacyDisclosure: 'Dźwięk i treść rozmowy są wysyłane z tego urządzenia do xAI przez połączenie xAI Realtime. Happier używa klucza xAI API zapisanego w sekretach konta Happier tylko do ograniczonych operacji uwierzytelnienia klienta i katalogu głosów. xAI przetwarza rozmowę na tym koncie i może przechowywać otrzymane dane zgodnie z ustawieniami konta i warunkami xAI. Gdy wznawianie jest włączone, Happier zapisuje identyfikator rozmowy dostawcy; zapomnienie usuwa identyfikator zapisany w Happier i nie usuwa danych przechowywanych przez xAI. Serwer i relay Happier nie przenoszą dźwięku na żywo.' },
    google: { privacyDisclosure: 'Dźwięk wysłany do transkrypcji jest przetwarzany przez Google Gemini, a tekst wysłany do syntezy mowy przez Google Cloud Text-to-Speech. Happier wysyła te żądania przez wybraną maszynę, używając jej poświadczeń Google API. Google może przechowywać otrzymane dane zgodnie z ustawieniami wybranego konta Google i warunkami Google.' },
    resumption: {
      forgetTitle: 'Zapomnij identyfikator wznowienia Happier',
      forgetSubtitle: 'Usuń identyfikator rozmowy dostawcy zapisany w Happier. Nie usuwa to rozmowy ani danych przechowywanych przez xAI.',
      forgotten: 'Happier usunął zapisany identyfikator rozmowy dostawcy.',
      unsupported: 'Happier nie może usunąć zapisanego identyfikatora rozmowy dostawcy z tej sesji.',
      failed: 'Happier nie mógł usunąć zapisanego identyfikatora rozmowy dostawcy. Spróbuj ponownie.',
    },
  },
  es: {
    openai: { privacyDisclosure: 'El audio y el contenido de la conversación se envían desde este dispositivo a OpenAI mediante WebRTC. Happier usa la clave de Voice API guardada, el servicio conectado de OpenAI o la cuenta experimental de Codex OAuth seleccionados para obtener autenticación de cliente de corta duración; las cuentas conectadas se usan mediante la máquina seleccionada. OpenAI procesa la conversación en la cuenta seleccionada y puede conservar los datos recibidos según la configuración de esa cuenta y sus términos. El servidor y el relay de Happier no transportan el audio en directo.' },
    xai: { privacyDisclosure: 'El audio y el contenido de la conversación se envían desde este dispositivo a xAI mediante la conexión xAI Realtime. Happier usa la clave API de xAI guardada en los secretos de tu cuenta de Happier solo para las operaciones acotadas de autenticación de cliente y catálogo de voces. xAI procesa la conversación en esa cuenta y puede conservar los datos recibidos según la configuración de la cuenta y sus términos. Si se activa la reanudación, Happier guarda el identificador de conversación del proveedor; olvidarlo elimina el identificador guardado por Happier y no elimina los datos conservados por xAI. El servidor y el relay de Happier no transportan el audio en directo.' },
    google: { privacyDisclosure: 'El audio enviado para transcripción lo procesa Google Gemini, y el texto enviado para voz lo procesa Google Cloud Text-to-Speech. Happier envía estas solicitudes mediante la máquina seleccionada usando su credencial de Google API. Google puede conservar los datos recibidos según la configuración de la cuenta de Google seleccionada y sus términos.' },
    resumption: {
      forgetTitle: 'Olvidar el identificador de reanudación de Happier',
      forgetSubtitle: 'Elimina el identificador de conversación del proveedor guardado por Happier. Esto no elimina la conversación ni los datos conservados por xAI.',
      forgotten: 'Happier eliminó el identificador de conversación del proveedor guardado.',
      unsupported: 'Happier no puede eliminar el identificador de conversación del proveedor guardado desde esta sesión.',
      failed: 'Happier no pudo eliminar el identificador de conversación del proveedor guardado. Inténtalo de nuevo.',
    },
  },
  it: {
    openai: { privacyDisclosure: 'L’audio e il contenuto della conversazione vengono inviati da questo dispositivo a OpenAI tramite WebRTC. Happier usa la chiave Voice API salvata, il servizio connesso OpenAI o l’account sperimentale Codex OAuth selezionati per ottenere un’autenticazione client di breve durata; gli account connessi vengono usati tramite la macchina selezionata. OpenAI elabora la conversazione nell’account selezionato e può conservare i dati ricevuti secondo le impostazioni dell’account e i termini di OpenAI. Il server e il relay di Happier non trasportano l’audio in tempo reale.' },
    xai: { privacyDisclosure: 'L’audio e il contenuto della conversazione vengono inviati da questo dispositivo a xAI tramite la connessione xAI Realtime. Happier usa la chiave API xAI salvata nei segreti del tuo account Happier solo per le operazioni limitate di autenticazione client e catalogo voci. xAI elabora la conversazione in tale account e può conservare i dati ricevuti secondo le impostazioni dell’account e i termini di xAI. Se la ripresa è attiva, Happier salva l’identificatore della conversazione del provider; dimenticarlo rimuove l’identificatore salvato da Happier e non elimina i dati conservati da xAI. Il server e il relay di Happier non trasportano l’audio in tempo reale.' },
    google: { privacyDisclosure: 'L’audio inviato per la trascrizione viene elaborato da Google Gemini e il testo inviato per la sintesi vocale da Google Cloud Text-to-Speech. Happier invia queste richieste tramite la macchina selezionata usando le sue credenziali Google API. Google può conservare i dati ricevuti secondo le impostazioni dell’account Google selezionato e i termini di Google.' },
    resumption: {
      forgetTitle: 'Dimentica l’identificatore di ripresa di Happier',
      forgetSubtitle: 'Rimuove l’identificatore della conversazione del provider salvato da Happier. Questo non elimina la conversazione né i dati conservati da xAI.',
      forgotten: 'Happier ha rimosso l’identificatore della conversazione del provider salvato.',
      unsupported: 'Happier non può rimuovere da questa sessione l’identificatore della conversazione del provider salvato.',
      failed: 'Happier non ha potuto rimuovere l’identificatore della conversazione del provider salvato. Riprova.',
    },
  },
  pt: {
    openai: { privacyDisclosure: 'O áudio e o conteúdo da conversa são enviados deste dispositivo para a OpenAI por WebRTC. O Happier usa a chave de Voice API guardada, o Serviço ligado da OpenAI ou a conta experimental Codex OAuth selecionados para obter autenticação de cliente de curta duração; as contas ligadas são usadas através da máquina selecionada. A OpenAI processa a conversa na conta selecionada e pode reter os dados recebidos segundo as definições dessa conta e os termos da OpenAI. O servidor e o relay do Happier não transportam o áudio em direto.' },
    xai: { privacyDisclosure: 'O áudio e o conteúdo da conversa são enviados deste dispositivo para a xAI pela ligação xAI Realtime. O Happier usa a chave API da xAI guardada nos segredos da sua conta Happier apenas para as operações limitadas de autenticação do cliente e catálogo de vozes. A xAI processa a conversa nessa conta e pode reter os dados recebidos segundo as definições da conta e os termos da xAI. Se a retoma estiver ativa, o Happier guarda o identificador da conversa do fornecedor; esquecê-lo remove o identificador guardado pelo Happier e não elimina os dados retidos pela xAI. O servidor e o relay do Happier não transportam o áudio em direto.' },
    google: { privacyDisclosure: 'O áudio enviado para transcrição é processado pelo Google Gemini e o texto enviado para voz pelo Google Cloud Text-to-Speech. O Happier envia estes pedidos através da máquina selecionada usando a credencial Google API dessa máquina. A Google pode reter os dados recebidos segundo as definições da conta Google selecionada e os termos da Google.' },
    resumption: {
      forgetTitle: 'Esquecer o identificador de retoma do Happier',
      forgetSubtitle: 'Remove o identificador da conversa do fornecedor guardado pelo Happier. Isto não elimina a conversa nem os dados retidos pela xAI.',
      forgotten: 'O Happier removeu o identificador da conversa do fornecedor guardado.',
      unsupported: 'O Happier não pode remover desta sessão o identificador da conversa do fornecedor guardado.',
      failed: 'O Happier não conseguiu remover o identificador da conversa do fornecedor guardado. Tente novamente.',
    },
  },
  ca: {
    openai: { privacyDisclosure: 'L’àudio i el contingut de la conversa s’envien des d’aquest dispositiu a OpenAI mitjançant WebRTC. Happier utilitza la clau de Voice API desada, el servei connectat d’OpenAI o el compte experimental Codex OAuth seleccionats per obtenir autenticació de client de curta durada; els comptes connectats s’utilitzen mitjançant la màquina seleccionada. OpenAI processa la conversa al compte seleccionat i pot conservar les dades rebudes segons la configuració del compte i els termes d’OpenAI. El servidor i el relay de Happier no transporten l’àudio en directe.' },
    xai: { privacyDisclosure: 'L’àudio i el contingut de la conversa s’envien des d’aquest dispositiu a xAI mitjançant la connexió xAI Realtime. Happier utilitza la clau API d’xAI desada als secrets del teu compte de Happier només per a les operacions acotades d’autenticació de client i catàleg de veus. xAI processa la conversa en aquest compte i pot conservar les dades rebudes segons la configuració del compte i els termes d’xAI. Si la represa està activada, Happier desa l’identificador de conversa del proveïdor; oblidar-lo elimina l’identificador desat per Happier i no elimina les dades conservades per xAI. El servidor i el relay de Happier no transporten l’àudio en directe.' },
    google: { privacyDisclosure: 'L’àudio enviat per transcriure és processat per Google Gemini i el text enviat per generar veu per Google Cloud Text-to-Speech. Happier envia aquestes sol·licituds mitjançant la màquina seleccionada usant-ne la credencial de Google API. Google pot conservar les dades rebudes segons la configuració del compte de Google seleccionat i els termes de Google.' },
    resumption: {
      forgetTitle: 'Oblida l’identificador de represa de Happier',
      forgetSubtitle: 'Elimina l’identificador de conversa del proveïdor desat per Happier. Això no elimina la conversa ni les dades conservades per xAI.',
      forgotten: 'Happier ha eliminat l’identificador de conversa del proveïdor desat.',
      unsupported: 'Happier no pot eliminar d’aquesta sessió l’identificador de conversa del proveïdor desat.',
      failed: 'Happier no ha pogut eliminar l’identificador de conversa del proveïdor desat. Torna-ho a provar.',
    },
  },
  'zh-Hans': {
    openai: { privacyDisclosure: '音频和对话内容会通过 WebRTC 从此设备发送到 OpenAI。Happier 使用所选的已保存 Voice API 密钥、OpenAI 已连接服务或实验性 Codex OAuth 账户来获取短期客户端身份验证；已连接账户通过所选机器使用。OpenAI 会在所选账户下处理实时对话，并可能根据该账户设置和 OpenAI 条款保留收到的数据。Happier 的服务器和中继不承载实时音频。' },
    xai: { privacyDisclosure: '音频和对话内容会通过 xAI Realtime 连接从此设备发送到 xAI。Happier 仅将保存在 Happier 账户密钥中的 xAI API 密钥用于有限的客户端身份验证和语音目录操作。xAI 会在该账户下处理实时对话，并可能根据账户设置和 xAI 条款保留收到的数据。启用续接后，Happier 会保存提供商对话标识符；忘记操作只会移除 Happier 保存的标识符，不会删除 xAI 持有的数据。Happier 的服务器和中继不承载实时音频。' },
    google: { privacyDisclosure: '发送用于转写的音频由 Google Gemini 处理，发送用于语音合成的文本由 Google Cloud Text-to-Speech 处理。Happier 通过所选执行机器并使用该机器的 Google API 凭据发送这些请求。Google 可能根据所选 Google 账户设置和 Google 条款保留收到的数据。' },
    resumption: {
      forgetTitle: '忘记 Happier 续接标识符',
      forgetSubtitle: '移除 Happier 保存的提供商对话标识符。这不会删除对话或 xAI 持有的数据。',
      forgotten: 'Happier 已移除保存的提供商对话标识符。',
      unsupported: 'Happier 无法从此会话中移除保存的提供商对话标识符。',
      failed: 'Happier 无法移除保存的提供商对话标识符。请重试。',
    },
  },
  'zh-Hant': {
    openai: { privacyDisclosure: '音訊與對話內容會透過 WebRTC 從此裝置傳送至 OpenAI。Happier 使用所選的已儲存 Voice API 金鑰、OpenAI 已連線服務或實驗性 Codex OAuth 帳戶取得短期用戶端驗證；已連線帳戶會透過所選機器使用。OpenAI 會在所選帳戶下處理即時對話，並可能依該帳戶設定與 OpenAI 條款保留收到的資料。Happier 的伺服器與中繼不承載即時音訊。' },
    xai: { privacyDisclosure: '音訊與對話內容會透過 xAI Realtime 連線從此裝置傳送至 xAI。Happier 僅將儲存在 Happier 帳戶祕密中的 xAI API 金鑰用於有限的用戶端驗證與語音目錄操作。xAI 會在該帳戶下處理即時對話，並可能依帳戶設定與 xAI 條款保留收到的資料。啟用續接後，Happier 會儲存提供者對話識別碼；忘記操作只會移除 Happier 儲存的識別碼，不會刪除 xAI 持有的資料。Happier 的伺服器與中繼不承載即時音訊。' },
    google: { privacyDisclosure: '送出以供轉錄的音訊由 Google Gemini 處理，送出以供語音合成的文字由 Google Cloud Text-to-Speech 處理。Happier 會透過所選執行機器並使用該機器的 Google API 憑證送出這些要求。Google 可能依所選 Google 帳戶設定與 Google 條款保留收到的資料。' },
    resumption: {
      forgetTitle: '忘記 Happier 續接識別碼',
      forgetSubtitle: '移除 Happier 儲存的提供者對話識別碼。這不會刪除對話或 xAI 持有的資料。',
      forgotten: 'Happier 已移除儲存的提供者對話識別碼。',
      unsupported: 'Happier 無法從此工作階段移除儲存的提供者對話識別碼。',
      failed: 'Happier 無法移除儲存的提供者對話識別碼。請再試一次。',
    },
  },
  ja: {
    openai: { privacyDisclosure: '音声と会話内容は WebRTC を使ってこのデバイスから OpenAI に送信されます。Happier は、選択された保存済み Voice API キー、OpenAI 接続サービス、または実験的な Codex OAuth アカウントを使って短期クライアント認証を取得します。接続アカウントは選択したマシン経由で使用されます。OpenAI は選択したアカウントで会話を処理し、そのアカウント設定と OpenAI の規約に従って受信データを保持する場合があります。Happier のサーバーとリレーはライブ音声を中継しません。' },
    xai: { privacyDisclosure: '音声と会話内容は xAI Realtime 接続を通じてこのデバイスから xAI に送信されます。Happier は Happier アカウントのシークレットに保存された xAI API キーを、限定されたクライアント認証と音声カタログ操作にだけ使用します。xAI はそのアカウントで会話を処理し、アカウント設定と xAI の規約に従って受信データを保持する場合があります。再開を有効にすると Happier はプロバイダー会話 ID を保存します。忘れる操作は Happier が保存した ID だけを削除し、xAI が保持するデータは削除しません。Happier のサーバーとリレーはライブ音声を中継しません。' },
    google: { privacyDisclosure: '文字起こし用に送信された音声は Google Gemini が処理し、音声合成用に送信されたテキストは Google Cloud Text-to-Speech が処理します。Happier は選択した実行マシンとそのマシンの Google API 認証情報を使ってこれらのリクエストを送信します。Google は選択した Google アカウント設定と Google の規約に従って受信データを保持する場合があります。' },
    resumption: {
      forgetTitle: 'Happier の再開 ID を忘れる',
      forgetSubtitle: 'Happier が保存したプロバイダー会話 ID を削除します。会話や xAI が保持するデータは削除しません。',
      forgotten: 'Happier が保存したプロバイダー会話 ID を削除しました。',
      unsupported: 'このセッションから Happier が保存したプロバイダー会話 ID を削除できません。',
      failed: 'Happier が保存したプロバイダー会話 ID を削除できませんでした。もう一度お試しください。',
    },
  },
} as const;
