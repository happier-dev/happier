export const voiceProviderPrivacyTranslations = {
  en: {
    openai: {
      privacyDisclosure: 'Audio and conversation content are sent from this device to OpenAI using WebRTC. When enabled or used, OpenAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the selected Saved Voice API key, OpenAI Connected Service, or experimental Codex OAuth account to mint short-lived client authentication; connected accounts are accessed through the selected machine. OpenAI processes the live conversation under the selected account and may retain received data according to that account’s settings and OpenAI’s terms. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
    },
    xai: {
      privacyDisclosure: 'Audio and conversation content are sent from this device to xAI through the xAI Realtime connection. When enabled or used, xAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the xAI API key saved in your Happier account secrets only for the bounded client-auth and voice-catalog operations. xAI processes the live conversation under that account and may retain received data according to the account settings and xAI’s terms. If resumption is enabled, Happier saves the provider conversation ID; forgetting it removes Happier’s saved ID and does not delete data held by xAI. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
    },
    google: {
      privacyDisclosure: 'Audio sent for transcription is processed by Google Gemini, and text sent for speech is processed by Google Cloud Text-to-Speech. Happier sends these requests through the selected execution machine using that machine’s Google API credential. Google may retain received data according to the selected Google account’s settings and Google’s terms.',
    },
    speechProcessing: {
      openaiCompatStt: 'Audio for transcription is sent to the configured external OpenAI-compatible endpoint. That service processes the audio and may retain received data according to its configuration and terms.',
      openaiCompatTts: 'Reply text for speech synthesis is sent to the configured external OpenAI-compatible endpoint. That service processes the text and may retain received data according to its configuration and terms.',
      deviceStt: 'Audio is processed by the browser or operating system speech-recognition service. Depending on the platform and configured service, processing may occur off-device.',
      deviceTts: 'Reply text is processed by the browser or operating system speech-synthesis service. Depending on the platform and configured service, processing may occur off-device.',
    },
    fields: {
      resumption: {
        title: 'Save xAI resumption ID',
        subtitle: 'Allow Happier to save xAI’s short-lived provider conversation ID for reconnecting.',
      },
    },
    resumption: {
      confirmTitle: 'Save the xAI resumption ID?',
      confirmBody: 'Happier will save xAI’s provider conversation ID for up to {minutes} minutes so an interrupted conversation can reconnect. This does not change or delete data held by xAI.',
      confirmAction: 'Save ID',
      forgetTitle: 'Forget Happier resumption ID',
      forgetSubtitle: 'Remove Happier’s saved provider conversation ID. This does not delete the conversation or data held by xAI.',
      forgotten: 'Happier removed its saved provider conversation ID.',
      unsupported: 'Happier cannot remove the saved provider conversation ID from this session.',
      failed: 'Happier could not remove its saved provider conversation ID. Please try again.',
    },
  },
  fr: {
    openai: {
      privacyDisclosure: 'L’audio et le contenu de la conversation sont envoyés depuis cet appareil vers OpenAI via WebRTC. Lorsque les fonctionnalités correspondantes sont activées ou utilisées, OpenAI peut aussi recevoir depuis cet appareil des mises à jour limitées du contexte Voice, des définitions d’outils client et des résultats délégués. Happier utilise la clé Voice API enregistrée, le Service connecté OpenAI ou le compte expérimental Codex OAuth sélectionné pour générer une authentification client de courte durée ; les comptes connectés sont utilisés via la machine sélectionnée. OpenAI traite la conversation en direct sous le compte sélectionné et peut conserver les données reçues selon les réglages de ce compte et les conditions d’OpenAI. Le serveur et le relay de Happier ne transportent pas l’audio en direct. Les contrôles de partage du contexte Voice sont distincts de ce traitement par le provider.',
    },
    xai: {
      privacyDisclosure: 'L’audio et le contenu de la conversation sont envoyés depuis cet appareil vers xAI via la connexion xAI Realtime. Lorsque les fonctionnalités correspondantes sont activées ou utilisées, xAI peut aussi recevoir depuis cet appareil des mises à jour limitées du contexte Voice, des définitions d’outils client et des résultats délégués. Happier utilise la clé API xAI enregistrée dans les secrets de ton compte Happier uniquement pour les opérations limitées d’authentification client et de catalogue de voix. xAI traite la conversation en direct sous ce compte et peut conserver les données reçues selon les réglages du compte et les conditions de xAI. Si la reprise est activée, Happier enregistre l’identifiant de conversation du provider ; l’oublier supprime l’identifiant enregistré par Happier et ne supprime pas les données conservées par xAI. Le serveur et le relay de Happier ne transportent pas l’audio en direct. Les contrôles de partage du contexte Voice sont distincts de ce traitement par le provider.',
    },
    google: {
      privacyDisclosure: 'L’audio envoyé pour la transcription est traité par Google Gemini, et le texte envoyé pour la synthèse vocale est traité par Google Cloud Text-to-Speech. Happier envoie ces requêtes via la machine d’exécution sélectionnée en utilisant les identifiants Google API de cette machine. Google peut conserver les données reçues selon les réglages du compte Google sélectionné et les conditions de Google.',
    },
    speechProcessing: {
      openaiCompatStt: 'L’audio destiné à la transcription est envoyé à l’endpoint externe compatible OpenAI configuré. Ce service traite l’audio et peut conserver les données reçues selon sa configuration et ses conditions.',
      openaiCompatTts: 'Le texte de la réponse destiné à la synthèse vocale est envoyé à l’endpoint externe compatible OpenAI configuré. Ce service traite le texte et peut conserver les données reçues selon sa configuration et ses conditions.',
      deviceStt: 'L’audio est traité par le service de reconnaissance vocale du navigateur ou du système d’exploitation. Selon la plateforme et le service configuré, le traitement peut avoir lieu hors de l’appareil.',
      deviceTts: 'Le texte de la réponse est traité par le service de synthèse vocale du navigateur ou du système d’exploitation. Selon la plateforme et le service configuré, le traitement peut avoir lieu hors de l’appareil.',
    },
    fields: {
      resumption: {
        title: 'Enregistrer l’identifiant de reprise xAI',
        subtitle: 'Autorise Happier à enregistrer l’identifiant de conversation temporaire du provider xAI pour la reconnexion.',
      },
    },
    resumption: {
      confirmTitle: 'Enregistrer l’identifiant de reprise xAI ?',
      confirmBody: 'Happier enregistrera l’identifiant de conversation du provider xAI pendant {minutes} minutes au maximum afin qu’une conversation interrompue puisse se reconnecter. Cela ne modifie ni ne supprime les données conservées par xAI.',
      confirmAction: 'Enregistrer l’identifiant',
      forgetTitle: 'Oublier l’identifiant de reprise Happier',
      forgetSubtitle: 'Supprime l’identifiant de conversation du provider enregistré par Happier. La conversation n’est pas supprimée, et les données conservées par xAI non plus.',
      forgotten: 'Happier a supprimé l’identifiant de conversation du provider qu’il avait enregistré.',
      unsupported: 'Happier ne peut pas supprimer l’identifiant de conversation du provider enregistré depuis cette session.',
      failed: 'Happier n’a pas pu supprimer l’identifiant de conversation du provider qu’il avait enregistré. Réessaie.',
    },
  },
  ru: {
    openai: { privacyDisclosure: 'Аудио и содержимое разговора отправляются с этого устройства в OpenAI через WebRTC. Когда соответствующие функции включены или используются, OpenAI также может получать с этого устройства ограниченные обновления контекста Voice, вызовы клиентских инструментов и их результаты. Happier использует выбранный сохранённый ключ Voice API, подключённый сервис OpenAI или экспериментальную учётную запись Codex OAuth для получения краткосрочной клиентской авторизации; подключённые учётные записи используются через выбранную машину. OpenAI обрабатывает разговор в выбранной учётной записи и может хранить полученные данные согласно настройкам этой учётной записи и условиям OpenAI. Сервер и relay Happier не передают живое аудио. Настройки передачи контекста Voice отделены от этой обработки провайдером.' },
    xai: { privacyDisclosure: 'Аудио и содержимое разговора отправляются с этого устройства в xAI через соединение xAI Realtime. Когда соответствующие функции включены или используются, xAI также может получать с этого устройства ограниченные обновления контекста Voice, вызовы клиентских инструментов и их результаты. Happier использует ключ xAI API, сохранённый в секретах вашей учётной записи Happier, только для ограниченных операций клиентской авторизации и каталога голосов. xAI обрабатывает разговор в этой учётной записи и может хранить полученные данные согласно настройкам учётной записи и условиям xAI. Если возобновление включено, Happier сохраняет идентификатор разговора провайдера; забывание удаляет сохранённый в Happier идентификатор и не удаляет данные, хранящиеся в xAI. Сервер и relay Happier не передают живое аудио. Настройки передачи контекста Voice отделены от этой обработки провайдером.' },
    google: { privacyDisclosure: 'Аудио для распознавания обрабатывается Google Gemini, а текст для озвучивания — Google Cloud Text-to-Speech. Happier отправляет эти запросы через выбранную машину, используя её учётные данные Google API. Google может хранить полученные данные согласно настройкам выбранной учётной записи Google и условиям Google.' },
    speechProcessing: {
      openaiCompatStt: 'Аудио для расшифровки отправляется на настроенную внешнюю OpenAI-совместимую конечную точку. Этот сервис обрабатывает аудио и может хранить полученные данные согласно своей конфигурации и условиям.',
      openaiCompatTts: 'Текст ответа для синтеза речи отправляется на настроенную внешнюю OpenAI-совместимую конечную точку. Этот сервис обрабатывает текст и может хранить полученные данные согласно своей конфигурации и условиям.',
      deviceStt: 'Аудио обрабатывается службой распознавания речи браузера или операционной системы. В зависимости от платформы и настроенной службы обработка может выполняться вне устройства.',
      deviceTts: 'Текст ответа обрабатывается службой синтеза речи браузера или операционной системы. В зависимости от платформы и настроенной службы обработка может выполняться вне устройства.',
    },
    fields: {
      resumption: {
        title: 'Сохранять идентификатор возобновления xAI',
        subtitle: 'Разрешить Happier сохранять краткосрочный идентификатор разговора xAI для переподключения.',
      },
    },
    resumption: {
      confirmTitle: 'Сохранить идентификатор возобновления xAI?',
      confirmBody: 'Happier будет хранить идентификатор разговора xAI до {minutes} минут, чтобы прерванный разговор можно было возобновить. Это не изменяет и не удаляет данные в xAI.',
      confirmAction: 'Сохранить идентификатор',
      forgetTitle: 'Забыть идентификатор возобновления в Happier',
      forgetSubtitle: 'Удалить сохранённый в Happier идентификатор разговора провайдера. Это не удаляет разговор или данные, хранящиеся в xAI.',
      forgotten: 'Happier удалил сохранённый идентификатор разговора провайдера.',
      unsupported: 'Happier не может удалить сохранённый идентификатор разговора провайдера из этой сессии.',
      failed: 'Happier не удалось удалить сохранённый идентификатор разговора провайдера. Повторите попытку.',
    },
  },
  pl: {
    openai: { privacyDisclosure: 'Dźwięk i treść rozmowy są wysyłane z tego urządzenia do OpenAI przez WebRTC. Gdy odpowiednie funkcje są włączone lub używane, OpenAI może również otrzymywać z tego urządzenia ograniczone aktualizacje kontekstu Voice, wywołania narzędzi klienta i ich wyniki. Happier używa wybranego zapisanego klucza Voice API, usługi połączonej OpenAI lub eksperymentalnego konta Codex OAuth, aby uzyskać krótkotrwałe uwierzytelnienie klienta; konta połączone są używane przez wybraną maszynę. OpenAI przetwarza rozmowę na wybranym koncie i może przechowywać otrzymane dane zgodnie z ustawieniami tego konta i warunkami OpenAI. Serwer i relay Happier nie przenoszą dźwięku na żywo. Ustawienia udostępniania kontekstu Voice są oddzielone od tego przetwarzania przez dostawcę.' },
    xai: { privacyDisclosure: 'Dźwięk i treść rozmowy są wysyłane z tego urządzenia do xAI przez połączenie xAI Realtime. Gdy odpowiednie funkcje są włączone lub używane, xAI może również otrzymywać z tego urządzenia ograniczone aktualizacje kontekstu Voice, wywołania narzędzi klienta i ich wyniki. Happier używa klucza xAI API zapisanego w sekretach konta Happier tylko do ograniczonych operacji uwierzytelnienia klienta i katalogu głosów. xAI przetwarza rozmowę na tym koncie i może przechowywać otrzymane dane zgodnie z ustawieniami konta i warunkami xAI. Gdy wznawianie jest włączone, Happier zapisuje identyfikator rozmowy dostawcy; zapomnienie usuwa identyfikator zapisany w Happier i nie usuwa danych przechowywanych przez xAI. Serwer i relay Happier nie przenoszą dźwięku na żywo. Ustawienia udostępniania kontekstu Voice są oddzielone od tego przetwarzania przez dostawcę.' },
    google: { privacyDisclosure: 'Dźwięk wysłany do transkrypcji jest przetwarzany przez Google Gemini, a tekst wysłany do syntezy mowy przez Google Cloud Text-to-Speech. Happier wysyła te żądania przez wybraną maszynę, używając jej poświadczeń Google API. Google może przechowywać otrzymane dane zgodnie z ustawieniami wybranego konta Google i warunkami Google.' },
    speechProcessing: {
      openaiCompatStt: 'Dźwięk do transkrypcji jest wysyłany do skonfigurowanego zewnętrznego punktu końcowego zgodnego z OpenAI. Usługa przetwarza dźwięk i może przechowywać otrzymane dane zgodnie ze swoją konfiguracją i warunkami.',
      openaiCompatTts: 'Tekst odpowiedzi do syntezy mowy jest wysyłany do skonfigurowanego zewnętrznego punktu końcowego zgodnego z OpenAI. Usługa przetwarza tekst i może przechowywać otrzymane dane zgodnie ze swoją konfiguracją i warunkami.',
      deviceStt: 'Dźwięk jest przetwarzany przez usługę rozpoznawania mowy przeglądarki lub systemu operacyjnego. Zależnie od platformy i skonfigurowanej usługi przetwarzanie może odbywać się poza urządzeniem.',
      deviceTts: 'Tekst odpowiedzi jest przetwarzany przez usługę syntezy mowy przeglądarki lub systemu operacyjnego. Zależnie od platformy i skonfigurowanej usługi przetwarzanie może odbywać się poza urządzeniem.',
    },
    fields: {
      resumption: {
        title: 'Zapisuj identyfikator wznowienia xAI',
        subtitle: 'Zezwól Happier na zapisywanie krótkotrwałego identyfikatora rozmowy xAI na potrzeby ponownego połączenia.',
      },
    },
    resumption: {
      confirmTitle: 'Zapisać identyfikator wznowienia xAI?',
      confirmBody: 'Happier zapisze identyfikator rozmowy xAI na maksymalnie {minutes} minut, aby można było wznowić przerwaną rozmowę. Nie zmienia to ani nie usuwa danych przechowywanych przez xAI.',
      confirmAction: 'Zapisz identyfikator',
      forgetTitle: 'Zapomnij identyfikator wznowienia Happier',
      forgetSubtitle: 'Usuń identyfikator rozmowy dostawcy zapisany w Happier. Nie usuwa to rozmowy ani danych przechowywanych przez xAI.',
      forgotten: 'Happier usunął zapisany identyfikator rozmowy dostawcy.',
      unsupported: 'Happier nie może usunąć zapisanego identyfikatora rozmowy dostawcy z tej sesji.',
      failed: 'Happier nie mógł usunąć zapisanego identyfikatora rozmowy dostawcy. Spróbuj ponownie.',
    },
  },
  es: {
    openai: { privacyDisclosure: 'El audio y el contenido de la conversación se envían desde este dispositivo a OpenAI mediante WebRTC. Cuando las funciones correspondientes están activadas o se usan, OpenAI también puede recibir desde este dispositivo actualizaciones acotadas del contexto de Voice, llamadas a herramientas del cliente y sus resultados. Happier usa la clave de Voice API guardada, el servicio conectado de OpenAI o la cuenta experimental de Codex OAuth seleccionados para obtener autenticación de cliente de corta duración; las cuentas conectadas se usan mediante la máquina seleccionada. OpenAI procesa la conversación en la cuenta seleccionada y puede conservar los datos recibidos según la configuración de esa cuenta y sus términos. El servidor y el relay de Happier no transportan el audio en directo. Los controles para compartir contexto de Voice son independientes de este tratamiento por el proveedor.' },
    xai: { privacyDisclosure: 'El audio y el contenido de la conversación se envían desde este dispositivo a xAI mediante la conexión xAI Realtime. Cuando las funciones correspondientes están activadas o se usan, xAI también puede recibir desde este dispositivo actualizaciones acotadas del contexto de Voice, llamadas a herramientas del cliente y sus resultados. Happier usa la clave API de xAI guardada en los secretos de tu cuenta de Happier solo para las operaciones acotadas de autenticación de cliente y catálogo de voces. xAI procesa la conversación en esa cuenta y puede conservar los datos recibidos según la configuración de la cuenta y sus términos. Si se activa la reanudación, Happier guarda el identificador de conversación del proveedor; olvidarlo elimina el identificador guardado por Happier y no elimina los datos conservados por xAI. El servidor y el relay de Happier no transportan el audio en directo. Los controles para compartir contexto de Voice son independientes de este tratamiento por el proveedor.' },
    google: { privacyDisclosure: 'El audio enviado para transcripción lo procesa Google Gemini, y el texto enviado para voz lo procesa Google Cloud Text-to-Speech. Happier envía estas solicitudes mediante la máquina seleccionada usando su credencial de Google API. Google puede conservar los datos recibidos según la configuración de la cuenta de Google seleccionada y sus términos.' },
    speechProcessing: {
      openaiCompatStt: 'El audio para transcripción se envía al endpoint externo compatible con OpenAI configurado. Ese servicio procesa el audio y puede conservar los datos recibidos según su configuración y sus términos.',
      openaiCompatTts: 'El texto de la respuesta para síntesis de voz se envía al endpoint externo compatible con OpenAI configurado. Ese servicio procesa el texto y puede conservar los datos recibidos según su configuración y sus términos.',
      deviceStt: 'El audio lo procesa el servicio de reconocimiento de voz del navegador o del sistema operativo. Según la plataforma y el servicio configurado, el procesamiento puede realizarse fuera del dispositivo.',
      deviceTts: 'El texto de la respuesta lo procesa el servicio de síntesis de voz del navegador o del sistema operativo. Según la plataforma y el servicio configurado, el procesamiento puede realizarse fuera del dispositivo.',
    },
    fields: {
      resumption: {
        title: 'Guardar el identificador de reanudación de xAI',
        subtitle: 'Permite que Happier guarde el identificador temporal de conversación de xAI para volver a conectar.',
      },
    },
    resumption: {
      confirmTitle: '¿Guardar el identificador de reanudación de xAI?',
      confirmBody: 'Happier guardará el identificador de conversación de xAI durante un máximo de {minutes} minutos para poder volver a conectar una conversación interrumpida. Esto no cambia ni elimina los datos conservados por xAI.',
      confirmAction: 'Guardar identificador',
      forgetTitle: 'Olvidar el identificador de reanudación de Happier',
      forgetSubtitle: 'Elimina el identificador de conversación del proveedor guardado por Happier. Esto no elimina la conversación ni los datos conservados por xAI.',
      forgotten: 'Happier eliminó el identificador de conversación del proveedor guardado.',
      unsupported: 'Happier no puede eliminar el identificador de conversación del proveedor guardado desde esta sesión.',
      failed: 'Happier no pudo eliminar el identificador de conversación del proveedor guardado. Inténtalo de nuevo.',
    },
  },
  it: {
    openai: { privacyDisclosure: 'L’audio e il contenuto della conversazione vengono inviati da questo dispositivo a OpenAI tramite WebRTC. Quando le funzioni corrispondenti sono abilitate o utilizzate, OpenAI può ricevere da questo dispositivo anche aggiornamenti limitati del contesto Voice, chiamate agli strumenti client e i relativi risultati. Happier usa la chiave Voice API salvata, il servizio connesso OpenAI o l’account sperimentale Codex OAuth selezionati per ottenere un’autenticazione client di breve durata; gli account connessi vengono usati tramite la macchina selezionata. OpenAI elabora la conversazione nell’account selezionato e può conservare i dati ricevuti secondo le impostazioni dell’account e i termini di OpenAI. Il server e il relay di Happier non trasportano l’audio in tempo reale. I controlli di condivisione del contesto Voice sono separati da questo trattamento del provider.' },
    xai: { privacyDisclosure: 'L’audio e il contenuto della conversazione vengono inviati da questo dispositivo a xAI tramite la connessione xAI Realtime. Quando le funzioni corrispondenti sono abilitate o utilizzate, xAI può ricevere da questo dispositivo anche aggiornamenti limitati del contesto Voice, chiamate agli strumenti client e i relativi risultati. Happier usa la chiave API xAI salvata nei segreti del tuo account Happier solo per le operazioni limitate di autenticazione client e catalogo voci. xAI elabora la conversazione in tale account e può conservare i dati ricevuti secondo le impostazioni dell’account e i termini di xAI. Se la ripresa è attiva, Happier salva l’identificatore della conversazione del provider; dimenticarlo rimuove l’identificatore salvato da Happier e non elimina i dati conservati da xAI. Il server e il relay di Happier non trasportano l’audio in tempo reale. I controlli di condivisione del contesto Voice sono separati da questo trattamento del provider.' },
    google: { privacyDisclosure: 'L’audio inviato per la trascrizione viene elaborato da Google Gemini e il testo inviato per la sintesi vocale da Google Cloud Text-to-Speech. Happier invia queste richieste tramite la macchina selezionata usando le sue credenziali Google API. Google può conservare i dati ricevuti secondo le impostazioni dell’account Google selezionato e i termini di Google.' },
    speechProcessing: {
      openaiCompatStt: 'L’audio da trascrivere viene inviato all’endpoint esterno compatibile con OpenAI configurato. Il servizio elabora l’audio e può conservare i dati ricevuti secondo la propria configurazione e i propri termini.',
      openaiCompatTts: 'Il testo della risposta da sintetizzare viene inviato all’endpoint esterno compatibile con OpenAI configurato. Il servizio elabora il testo e può conservare i dati ricevuti secondo la propria configurazione e i propri termini.',
      deviceStt: 'L’audio viene elaborato dal servizio di riconoscimento vocale del browser o del sistema operativo. A seconda della piattaforma e del servizio configurato, l’elaborazione può avvenire fuori dal dispositivo.',
      deviceTts: 'Il testo della risposta viene elaborato dal servizio di sintesi vocale del browser o del sistema operativo. A seconda della piattaforma e del servizio configurato, l’elaborazione può avvenire fuori dal dispositivo.',
    },
    fields: {
      resumption: {
        title: 'Salva l’identificatore di ripresa xAI',
        subtitle: 'Consenti a Happier di salvare l’identificatore temporaneo della conversazione xAI per la riconnessione.',
      },
    },
    resumption: {
      confirmTitle: 'Salvare l’identificatore di ripresa xAI?',
      confirmBody: 'Happier salverà l’identificatore della conversazione xAI per un massimo di {minutes} minuti, così una conversazione interrotta potrà riconnettersi. Questo non modifica né elimina i dati conservati da xAI.',
      confirmAction: 'Salva identificatore',
      forgetTitle: 'Dimentica l’identificatore di ripresa di Happier',
      forgetSubtitle: 'Rimuove l’identificatore della conversazione del provider salvato da Happier. Questo non elimina la conversazione né i dati conservati da xAI.',
      forgotten: 'Happier ha rimosso l’identificatore della conversazione del provider salvato.',
      unsupported: 'Happier non può rimuovere da questa sessione l’identificatore della conversazione del provider salvato.',
      failed: 'Happier non ha potuto rimuovere l’identificatore della conversazione del provider salvato. Riprova.',
    },
  },
  pt: {
    openai: { privacyDisclosure: 'O áudio e o conteúdo da conversa são enviados deste dispositivo para a OpenAI por WebRTC. Quando as funcionalidades correspondentes estão ativas ou são usadas, a OpenAI também pode receber deste dispositivo atualizações limitadas do contexto de Voice, chamadas a ferramentas do cliente e os respetivos resultados. O Happier usa a chave de Voice API guardada, o Serviço ligado da OpenAI ou a conta experimental Codex OAuth selecionados para obter autenticação de cliente de curta duração; as contas ligadas são usadas através da máquina selecionada. A OpenAI processa a conversa na conta selecionada e pode reter os dados recebidos segundo as definições dessa conta e os termos da OpenAI. O servidor e o relay do Happier não transportam o áudio em direto. Os controlos de partilha de contexto do Voice são separados deste processamento pelo fornecedor.' },
    xai: { privacyDisclosure: 'O áudio e o conteúdo da conversa são enviados deste dispositivo para a xAI pela ligação xAI Realtime. Quando as funcionalidades correspondentes estão ativas ou são usadas, a xAI também pode receber deste dispositivo atualizações limitadas do contexto de Voice, chamadas a ferramentas do cliente e os respetivos resultados. O Happier usa a chave API da xAI guardada nos segredos da sua conta Happier apenas para as operações limitadas de autenticação do cliente e catálogo de vozes. A xAI processa a conversa nessa conta e pode reter os dados recebidos segundo as definições da conta e os termos da xAI. Se a retoma estiver ativa, o Happier guarda o identificador da conversa do fornecedor; esquecê-lo remove o identificador guardado pelo Happier e não elimina os dados retidos pela xAI. O servidor e o relay do Happier não transportam o áudio em direto. Os controlos de partilha de contexto do Voice são separados deste processamento pelo fornecedor.' },
    google: { privacyDisclosure: 'O áudio enviado para transcrição é processado pelo Google Gemini e o texto enviado para voz pelo Google Cloud Text-to-Speech. O Happier envia estes pedidos através da máquina selecionada usando a credencial Google API dessa máquina. A Google pode reter os dados recebidos segundo as definições da conta Google selecionada e os termos da Google.' },
    speechProcessing: {
      openaiCompatStt: 'O áudio para transcrição é enviado para o endpoint externo compatível com OpenAI configurado. Esse serviço processa o áudio e pode reter os dados recebidos segundo a sua configuração e os seus termos.',
      openaiCompatTts: 'O texto da resposta para síntese de voz é enviado para o endpoint externo compatível com OpenAI configurado. Esse serviço processa o texto e pode reter os dados recebidos segundo a sua configuração e os seus termos.',
      deviceStt: 'O áudio é processado pelo serviço de reconhecimento de voz do browser ou do sistema operativo. Consoante a plataforma e o serviço configurado, o processamento pode ocorrer fora do dispositivo.',
      deviceTts: 'O texto da resposta é processado pelo serviço de síntese de voz do browser ou do sistema operativo. Consoante a plataforma e o serviço configurado, o processamento pode ocorrer fora do dispositivo.',
    },
    fields: {
      resumption: {
        title: 'Guardar o identificador de retoma da xAI',
        subtitle: 'Permita que o Happier guarde o identificador temporário da conversa da xAI para restabelecer a ligação.',
      },
    },
    resumption: {
      confirmTitle: 'Guardar o identificador de retoma da xAI?',
      confirmBody: 'O Happier guardará o identificador da conversa da xAI durante até {minutes} minutos para poder restabelecer uma conversa interrompida. Isto não altera nem elimina os dados retidos pela xAI.',
      confirmAction: 'Guardar identificador',
      forgetTitle: 'Esquecer o identificador de retoma do Happier',
      forgetSubtitle: 'Remove o identificador da conversa do fornecedor guardado pelo Happier. Isto não elimina a conversa nem os dados retidos pela xAI.',
      forgotten: 'O Happier removeu o identificador da conversa do fornecedor guardado.',
      unsupported: 'O Happier não pode remover desta sessão o identificador da conversa do fornecedor guardado.',
      failed: 'O Happier não conseguiu remover o identificador da conversa do fornecedor guardado. Tente novamente.',
    },
  },
  ca: {
    openai: { privacyDisclosure: 'L’àudio i el contingut de la conversa s’envien des d’aquest dispositiu a OpenAI mitjançant WebRTC. Quan les funcions corresponents estan activades o s’utilitzen, OpenAI també pot rebre des d’aquest dispositiu actualitzacions acotades del context de Voice, crides a eines del client i els seus resultats. Happier utilitza la clau de Voice API desada, el servei connectat d’OpenAI o el compte experimental Codex OAuth seleccionats per obtenir autenticació de client de curta durada; els comptes connectats s’utilitzen mitjançant la màquina seleccionada. OpenAI processa la conversa al compte seleccionat i pot conservar les dades rebudes segons la configuració del compte i els termes d’OpenAI. El servidor i el relay de Happier no transporten l’àudio en directe. Els controls per compartir context de Voice són independents d’aquest tractament del proveïdor.' },
    xai: { privacyDisclosure: 'L’àudio i el contingut de la conversa s’envien des d’aquest dispositiu a xAI mitjançant la connexió xAI Realtime. Quan les funcions corresponents estan activades o s’utilitzen, xAI també pot rebre des d’aquest dispositiu actualitzacions acotades del context de Voice, crides a eines del client i els seus resultats. Happier utilitza la clau API d’xAI desada als secrets del teu compte de Happier només per a les operacions acotades d’autenticació de client i catàleg de veus. xAI processa la conversa en aquest compte i pot conservar les dades rebudes segons la configuració del compte i els termes d’xAI. Si la represa està activada, Happier desa l’identificador de conversa del proveïdor; oblidar-lo elimina l’identificador desat per Happier i no elimina les dades conservades per xAI. El servidor i el relay de Happier no transporten l’àudio en directe. Els controls per compartir context de Voice són independents d’aquest tractament del proveïdor.' },
    google: { privacyDisclosure: 'L’àudio enviat per transcriure és processat per Google Gemini i el text enviat per generar veu per Google Cloud Text-to-Speech. Happier envia aquestes sol·licituds mitjançant la màquina seleccionada usant-ne la credencial de Google API. Google pot conservar les dades rebudes segons la configuració del compte de Google seleccionat i els termes de Google.' },
    speechProcessing: {
      openaiCompatStt: 'L’àudio per transcriure s’envia a l’endpoint extern compatible amb OpenAI configurat. Aquest servei processa l’àudio i pot conservar les dades rebudes segons la seva configuració i els seus termes.',
      openaiCompatTts: 'El text de la resposta per sintetitzar veu s’envia a l’endpoint extern compatible amb OpenAI configurat. Aquest servei processa el text i pot conservar les dades rebudes segons la seva configuració i els seus termes.',
      deviceStt: 'L’àudio és processat pel servei de reconeixement de veu del navegador o del sistema operatiu. Segons la plataforma i el servei configurat, el processament pot tenir lloc fora del dispositiu.',
      deviceTts: 'El text de la resposta és processat pel servei de síntesi de veu del navegador o del sistema operatiu. Segons la plataforma i el servei configurat, el processament pot tenir lloc fora del dispositiu.',
    },
    fields: {
      resumption: {
        title: 'Desa l’identificador de represa d’xAI',
        subtitle: 'Permet que Happier desi l’identificador temporal de conversa d’xAI per tornar a connectar.',
      },
    },
    resumption: {
      confirmTitle: 'Vols desar l’identificador de represa d’xAI?',
      confirmBody: 'Happier desarà l’identificador de conversa d’xAI durant un màxim de {minutes} minuts per poder reprendre una conversa interrompuda. Això no modifica ni elimina les dades conservades per xAI.',
      confirmAction: 'Desa l’identificador',
      forgetTitle: 'Oblida l’identificador de represa de Happier',
      forgetSubtitle: 'Elimina l’identificador de conversa del proveïdor desat per Happier. Això no elimina la conversa ni les dades conservades per xAI.',
      forgotten: 'Happier ha eliminat l’identificador de conversa del proveïdor desat.',
      unsupported: 'Happier no pot eliminar d’aquesta sessió l’identificador de conversa del proveïdor desat.',
      failed: 'Happier no ha pogut eliminar l’identificador de conversa del proveïdor desat. Torna-ho a provar.',
    },
  },
  'zh-Hans': {
    openai: { privacyDisclosure: '音频和对话内容会通过 WebRTC 从此设备发送到 OpenAI。启用或使用相应功能时，OpenAI 还可能从此设备接收有限的 Voice 上下文更新、客户端工具调用及其结果。Happier 使用所选的已保存 Voice API 密钥、OpenAI 已连接服务或实验性 Codex OAuth 账户来获取短期客户端身份验证；已连接账户通过所选机器使用。OpenAI 会在所选账户下处理实时对话，并可能根据该账户设置和 OpenAI 条款保留收到的数据。Happier 的服务器和中继不承载实时音频。Voice 上下文共享控制与此提供商处理相互独立。' },
    xai: { privacyDisclosure: '音频和对话内容会通过 xAI Realtime 连接从此设备发送到 xAI。启用或使用相应功能时，xAI 还可能从此设备接收有限的 Voice 上下文更新、客户端工具调用及其结果。Happier 仅将保存在 Happier 账户密钥中的 xAI API 密钥用于有限的客户端身份验证和语音目录操作。xAI 会在该账户下处理实时对话，并可能根据账户设置和 xAI 条款保留收到的数据。启用续接后，Happier 会保存提供商对话标识符；忘记操作只会移除 Happier 保存的标识符，不会删除 xAI 持有的数据。Happier 的服务器和中继不承载实时音频。Voice 上下文共享控制与此提供商处理相互独立。' },
    google: { privacyDisclosure: '发送用于转写的音频由 Google Gemini 处理，发送用于语音合成的文本由 Google Cloud Text-to-Speech 处理。Happier 通过所选执行机器并使用该机器的 Google API 凭据发送这些请求。Google 可能根据所选 Google 账户设置和 Google 条款保留收到的数据。' },
    speechProcessing: {
      openaiCompatStt: '用于转写的音频会发送到已配置的外部 OpenAI 兼容端点。该服务会处理音频，并可能根据其配置和条款保留收到的数据。',
      openaiCompatTts: '用于语音合成的回复文本会发送到已配置的外部 OpenAI 兼容端点。该服务会处理文本，并可能根据其配置和条款保留收到的数据。',
      deviceStt: '音频由浏览器或操作系统的语音识别服务处理。根据平台和已配置的服务，处理可能在设备外进行。',
      deviceTts: '回复文本由浏览器或操作系统的语音合成服务处理。根据平台和已配置的服务，处理可能在设备外进行。',
    },
    fields: {
      resumption: {
        title: '保存 xAI 续接标识符',
        subtitle: '允许 Happier 保存 xAI 的短期提供商对话标识符，以便重新连接。',
      },
    },
    resumption: {
      confirmTitle: '保存 xAI 续接标识符？',
      confirmBody: 'Happier 会将 xAI 的提供商对话标识符保存最多 {minutes} 分钟，以便重新连接中断的对话。这不会更改或删除 xAI 持有的数据。',
      confirmAction: '保存标识符',
      forgetTitle: '忘记 Happier 续接标识符',
      forgetSubtitle: '移除 Happier 保存的提供商对话标识符。这不会删除对话或 xAI 持有的数据。',
      forgotten: 'Happier 已移除保存的提供商对话标识符。',
      unsupported: 'Happier 无法从此会话中移除保存的提供商对话标识符。',
      failed: 'Happier 无法移除保存的提供商对话标识符。请重试。',
    },
  },
  'zh-Hant': {
    openai: { privacyDisclosure: '音訊與對話內容會透過 WebRTC 從此裝置傳送至 OpenAI。啟用或使用相關功能時，OpenAI 也可能從此裝置接收有限的 Voice 脈絡更新、用戶端工具呼叫及其結果。Happier 使用所選的已儲存 Voice API 金鑰、OpenAI 已連線服務或實驗性 Codex OAuth 帳戶取得短期用戶端驗證；已連線帳戶會透過所選機器使用。OpenAI 會在所選帳戶下處理即時對話，並可能依該帳戶設定與 OpenAI 條款保留收到的資料。Happier 的伺服器與中繼不承載即時音訊。Voice 脈絡分享控制與此提供者處理彼此獨立。' },
    xai: { privacyDisclosure: '音訊與對話內容會透過 xAI Realtime 連線從此裝置傳送至 xAI。啟用或使用相關功能時，xAI 也可能從此裝置接收有限的 Voice 脈絡更新、用戶端工具呼叫及其結果。Happier 僅將儲存在 Happier 帳戶祕密中的 xAI API 金鑰用於有限的用戶端驗證與語音目錄操作。xAI 會在該帳戶下處理即時對話，並可能依帳戶設定與 xAI 條款保留收到的資料。啟用續接後，Happier 會儲存提供者對話識別碼；忘記操作只會移除 Happier 儲存的識別碼，不會刪除 xAI 持有的資料。Happier 的伺服器與中繼不承載即時音訊。Voice 脈絡分享控制與此提供者處理彼此獨立。' },
    google: { privacyDisclosure: '送出以供轉錄的音訊由 Google Gemini 處理，送出以供語音合成的文字由 Google Cloud Text-to-Speech 處理。Happier 會透過所選執行機器並使用該機器的 Google API 憑證送出這些要求。Google 可能依所選 Google 帳戶設定與 Google 條款保留收到的資料。' },
    speechProcessing: {
      openaiCompatStt: '用於轉錄的音訊會傳送到已設定的外部 OpenAI 相容端點。該服務會處理音訊，並可能依其設定與條款保留收到的資料。',
      openaiCompatTts: '用於語音合成的回覆文字會傳送到已設定的外部 OpenAI 相容端點。該服務會處理文字，並可能依其設定與條款保留收到的資料。',
      deviceStt: '音訊由瀏覽器或作業系統的語音辨識服務處理。視平台與已設定的服務而定，處理可能在裝置外進行。',
      deviceTts: '回覆文字由瀏覽器或作業系統的語音合成服務處理。視平台與已設定的服務而定，處理可能在裝置外進行。',
    },
    fields: {
      resumption: {
        title: '儲存 xAI 續接識別碼',
        subtitle: '允許 Happier 儲存 xAI 的短期提供者對話識別碼，以便重新連線。',
      },
    },
    resumption: {
      confirmTitle: '儲存 xAI 續接識別碼？',
      confirmBody: 'Happier 會將 xAI 的提供者對話識別碼儲存最多 {minutes} 分鐘，以便重新連線中斷的對話。這不會變更或刪除 xAI 持有的資料。',
      confirmAction: '儲存識別碼',
      forgetTitle: '忘記 Happier 續接識別碼',
      forgetSubtitle: '移除 Happier 儲存的提供者對話識別碼。這不會刪除對話或 xAI 持有的資料。',
      forgotten: 'Happier 已移除儲存的提供者對話識別碼。',
      unsupported: 'Happier 無法從此工作階段移除儲存的提供者對話識別碼。',
      failed: 'Happier 無法移除儲存的提供者對話識別碼。請再試一次。',
    },
  },
  ja: {
    openai: { privacyDisclosure: '音声と会話内容は WebRTC を使ってこのデバイスから OpenAI に送信されます。対応する機能が有効または使用されている場合、OpenAI はこのデバイスから限定的な Voice コンテキスト更新、クライアントツールの呼び出しとその結果も受信する場合があります。Happier は、選択された保存済み Voice API キー、OpenAI 接続サービス、または実験的な Codex OAuth アカウントを使って短期クライアント認証を取得します。接続アカウントは選択したマシン経由で使用されます。OpenAI は選択したアカウントで会話を処理し、そのアカウント設定と OpenAI の規約に従って受信データを保持する場合があります。Happier のサーバーとリレーはライブ音声を中継しません。Voice のコンテキスト共有設定は、このプロバイダーによる処理とは別です。' },
    xai: { privacyDisclosure: '音声と会話内容は xAI Realtime 接続を通じてこのデバイスから xAI に送信されます。対応する機能が有効または使用されている場合、xAI はこのデバイスから限定的な Voice コンテキスト更新、クライアントツールの呼び出しとその結果も受信する場合があります。Happier は Happier アカウントのシークレットに保存された xAI API キーを、限定されたクライアント認証と音声カタログ操作にだけ使用します。xAI はそのアカウントで会話を処理し、アカウント設定と xAI の規約に従って受信データを保持する場合があります。再開を有効にすると Happier はプロバイダー会話 ID を保存します。忘れる操作は Happier が保存した ID だけを削除し、xAI が保持するデータは削除しません。Happier のサーバーとリレーはライブ音声を中継しません。Voice のコンテキスト共有設定は、このプロバイダーによる処理とは別です。' },
    google: { privacyDisclosure: '文字起こし用に送信された音声は Google Gemini が処理し、音声合成用に送信されたテキストは Google Cloud Text-to-Speech が処理します。Happier は選択した実行マシンとそのマシンの Google API 認証情報を使ってこれらのリクエストを送信します。Google は選択した Google アカウント設定と Google の規約に従って受信データを保持する場合があります。' },
    speechProcessing: {
      openaiCompatStt: '文字起こし用の音声は、設定された外部の OpenAI 互換エンドポイントに送信されます。そのサービスが音声を処理し、設定と規約に従って受信データを保持する場合があります。',
      openaiCompatTts: '音声合成用の応答テキストは、設定された外部の OpenAI 互換エンドポイントに送信されます。そのサービスがテキストを処理し、設定と規約に従って受信データを保持する場合があります。',
      deviceStt: '音声はブラウザーまたはオペレーティングシステムの音声認識サービスで処理されます。プラットフォームと設定されたサービスによっては、デバイス外で処理される場合があります。',
      deviceTts: '応答テキストはブラウザーまたはオペレーティングシステムの音声合成サービスで処理されます。プラットフォームと設定されたサービスによっては、デバイス外で処理される場合があります。',
    },
    fields: {
      resumption: {
        title: 'xAI の再開 ID を保存',
        subtitle: '再接続のため、xAI の短期プロバイダー会話 ID を Happier に保存することを許可します。',
      },
    },
    resumption: {
      confirmTitle: 'xAI の再開 ID を保存しますか？',
      confirmBody: '中断した会話に再接続できるよう、Happier は xAI のプロバイダー会話 ID を最大 {minutes} 分間保存します。xAI が保持するデータを変更または削除することはありません。',
      confirmAction: 'ID を保存',
      forgetTitle: 'Happier の再開 ID を忘れる',
      forgetSubtitle: 'Happier が保存したプロバイダー会話 ID を削除します。会話や xAI が保持するデータは削除しません。',
      forgotten: 'Happier が保存したプロバイダー会話 ID を削除しました。',
      unsupported: 'このセッションから Happier が保存したプロバイダー会話 ID を削除できません。',
      failed: 'Happier が保存したプロバイダー会話 ID を削除できませんでした。もう一度お試しください。',
    },
  },
} as const;
