/**
 * Copy for menu-bar mode (R16): the desktop tray menu, the Quit that goes through the app, and the one login-start setting.
 *
 * The native menu cannot translate, so the web UI sends these strings to it and the native side
 * persists them for menu-bar mode, where no web UI runs (`desktop/tray/buildDesktopTrayState.ts`).
 * `{relay}` in the two Stop confirmations is a literal the native side fills with the Home's host;
 * the translations below are therefore run with `relay: '{relay}'`.
 *
 * Menu wording follows the platform conventions: an ellipsis marks an item that can ask before it
 * acts (a confirmation dialog), status rows pair the dot with its word, labels are sentence case.
 */

type RelayParams = { relay: string };
type DetailParams = { detail: string };
type CountParams = { count: string };

const en = {
    open: 'Open Happier',
    openInHappier: 'Open in Happier',
    settings: 'Settings…',
    startAtLogin: 'Start at login',
    quit: 'Quit Happier',
    stopServicesAndQuit: 'Stop background services and quit…',
    sessions: ({ count }: CountParams) => `${count} running`,
    start: 'Start',
    restart: 'Restart',
    stop: 'Stop…',
    userOwned: 'Managed outside Happier',
    checking: 'Checking background services…',
    readFailed: 'Couldn’t check background services',
    incomplete: 'Some background services couldn’t be checked',
    noServices: 'This computer isn’t set up yet',
    working: 'Working…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Stop Happier’s background service for ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Agent sessions running on this computer for ${relay} will end, and your phone and browser can’t reach it there until the service starts again.`,
    stopAllConfirmTitle: 'Stop Happier’s background services and quit?',
    stopAllConfirmBody: 'Agent sessions running on this computer will end, and your phone and browser can’t reach it until its background services start again.',
    stopConfirmAction: 'Stop',
    actionFailedTitle: 'That didn’t go through',
    loginItemFailed: 'Couldn’t update Happier’s login item',
    quitStopTitle: 'Agent sessions are still running',
    quitStopBody: 'Quitting stops this computer’s background services and ends the sessions running here.',
    quitStopUnknownTitle: 'Stop background services?',
    quitStopUnknownBody: 'Happier can’t see which sessions are running on this computer. Quitting stops its background services and ends any that are.',
    quitStopConfirm: 'Stop anyway',
    quitStopKeep: 'Leave them running',
    quitStopFailedTitle: 'Some background services didn’t stop',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier stays open so you can check the background services and try again.`,
};

export type DesktopTrayTranslation = typeof en;

const de: DesktopTrayTranslation = {
    open: 'Happier öffnen',
    openInHappier: 'In Happier öffnen',
    settings: 'Einstellungen…',
    startAtLogin: 'Beim Anmelden starten',
    quit: 'Happier beenden',
    stopServicesAndQuit: 'Hintergrunddienste stoppen und beenden…',
    sessions: ({ count }: CountParams) => `${count} aktiv`,
    start: 'Starten',
    restart: 'Neu starten',
    stop: 'Stoppen…',
    userOwned: 'Außerhalb von Happier verwaltet',
    checking: 'Hintergrunddienste werden geprüft…',
    readFailed: 'Hintergrunddienste konnten nicht geprüft werden',
    incomplete: 'Einige Hintergrunddienste konnten nicht geprüft werden',
    noServices: 'Dieser Computer ist noch nicht eingerichtet',
    working: 'Wird ausgeführt…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Happier-Hintergrunddienst für ${relay} stoppen?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Agent-Sitzungen, die auf diesem Computer für ${relay} laufen, werden beendet, und dein Telefon und dein Browser erreichen ihn dort erst wieder, wenn der Dienst neu startet.`,
    stopAllConfirmTitle: 'Happier-Hintergrunddienste stoppen und beenden?',
    stopAllConfirmBody: 'Agent-Sitzungen auf diesem Computer werden beendet, und dein Telefon und dein Browser erreichen ihn erst wieder, wenn seine Hintergrunddienste neu starten.',
    stopConfirmAction: 'Stoppen',
    actionFailedTitle: 'Das hat nicht geklappt',
    loginItemFailed: 'Das Anmeldeobjekt von Happier konnte nicht aktualisiert werden',
    quitStopTitle: 'Agent-Sitzungen laufen noch',
    quitStopBody: 'Beim Beenden werden die Hintergrunddienste dieses Computers gestoppt und die Sitzungen hier beendet.',
    quitStopUnknownTitle: 'Hintergrunddienste stoppen?',
    quitStopUnknownBody: 'Happier sieht nicht, welche Sitzungen auf diesem Computer laufen. Beim Beenden werden seine Hintergrunddienste gestoppt und laufende Sitzungen beendet.',
    quitStopConfirm: 'Trotzdem stoppen',
    quitStopKeep: 'Weiterlaufen lassen',
    quitStopFailedTitle: 'Einige Hintergrunddienste wurden nicht gestoppt',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier bleibt geöffnet, damit du die Hintergrunddienste prüfen und es erneut versuchen kannst.`,
};

const es: DesktopTrayTranslation = {
    open: 'Abrir Happier',
    openInHappier: 'Abrir en Happier',
    settings: 'Ajustes…',
    startAtLogin: 'Iniciar al acceder',
    quit: 'Salir de Happier',
    stopServicesAndQuit: 'Detener servicios en segundo plano y salir…',
    sessions: ({ count }: CountParams) => `${count} en curso`,
    start: 'Iniciar',
    restart: 'Reiniciar',
    stop: 'Detener…',
    userOwned: 'Gestionado fuera de Happier',
    checking: 'Comprobando servicios en segundo plano…',
    readFailed: 'No se pudieron comprobar los servicios en segundo plano',
    incomplete: 'Algunos servicios en segundo plano no se pudieron comprobar',
    noServices: 'Este ordenador aún no está configurado',
    working: 'Trabajando…',
    stopConfirmTitle: ({ relay }: RelayParams) => `¿Detener el servicio en segundo plano de Happier para ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Las sesiones de agente que se ejecutan en este ordenador para ${relay} terminarán, y tu teléfono y tu navegador no podrán acceder a él allí hasta que el servicio vuelva a iniciarse.`,
    stopAllConfirmTitle: '¿Detener los servicios en segundo plano de Happier y salir?',
    stopAllConfirmBody: 'Las sesiones de agente de este ordenador terminarán, y tu teléfono y tu navegador no podrán acceder a él hasta que sus servicios en segundo plano vuelvan a iniciarse.',
    stopConfirmAction: 'Detener',
    actionFailedTitle: 'No se pudo completar',
    loginItemFailed: 'No se pudo actualizar el elemento de inicio de Happier',
    quitStopTitle: 'Todavía hay sesiones de agente en ejecución',
    quitStopBody: 'Al salir se detienen los servicios en segundo plano de este ordenador y terminan las sesiones que se ejecutan aquí.',
    quitStopUnknownTitle: '¿Detener los servicios en segundo plano?',
    quitStopUnknownBody: 'Happier no puede ver qué sesiones se están ejecutando en este ordenador. Al salir se detienen sus servicios en segundo plano y terminan las que haya.',
    quitStopConfirm: 'Detener de todos modos',
    quitStopKeep: 'Dejarlos en marcha',
    quitStopFailedTitle: 'Algunos servicios en segundo plano no se detuvieron',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier permanece abierto para que puedas comprobar los servicios en segundo plano e intentarlo de nuevo.`,
};

const fr: DesktopTrayTranslation = {
    open: 'Ouvrir Happier',
    openInHappier: 'Ouvrir dans Happier',
    settings: 'Réglages…',
    startAtLogin: 'Lancer à la connexion',
    quit: 'Quitter Happier',
    stopServicesAndQuit: 'Arrêter les services en arrière-plan et quitter…',
    sessions: ({ count }: CountParams) => `${count} en cours`,
    start: 'Démarrer',
    restart: 'Redémarrer',
    stop: 'Arrêter…',
    userOwned: 'Géré en dehors de Happier',
    checking: 'Vérification des services en arrière-plan…',
    readFailed: 'Impossible de vérifier les services en arrière-plan',
    incomplete: 'Certains services en arrière-plan n’ont pas pu être vérifiés',
    noServices: 'Cet ordinateur n’est pas encore configuré',
    working: 'En cours…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Arrêter le service en arrière-plan de Happier pour ${relay} ?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Les sessions d’agent en cours sur cet ordinateur pour ${relay} vont s’arrêter, et ton téléphone et ton navigateur ne pourront plus l’y joindre tant que le service n’aura pas redémarré.`,
    stopAllConfirmTitle: 'Arrêter les services en arrière-plan de Happier et quitter ?',
    stopAllConfirmBody: 'Les sessions d’agent de cet ordinateur vont s’arrêter, et ton téléphone et ton navigateur ne pourront plus le joindre tant que ses services en arrière-plan n’auront pas redémarré.',
    stopConfirmAction: 'Arrêter',
    actionFailedTitle: 'Ça n’a pas abouti',
    loginItemFailed: 'Impossible de mettre à jour l’élément d’ouverture de Happier',
    quitStopTitle: 'Des sessions d’agent sont encore en cours',
    quitStopBody: 'Quitter arrête les services en arrière-plan de cet ordinateur et met fin aux sessions en cours ici.',
    quitStopUnknownTitle: 'Arrêter les services en arrière-plan ?',
    quitStopUnknownBody: 'Happier ne voit pas quelles sessions tournent sur cet ordinateur. Quitter arrête ses services en arrière-plan et met fin à celles qui tournent.',
    quitStopConfirm: 'Arrêter quand même',
    quitStopKeep: 'Les laisser tourner',
    quitStopFailedTitle: 'Certains services en arrière-plan ne se sont pas arrêtés',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier reste ouvert pour que tu puisses vérifier les services en arrière-plan et réessayer.`,
};

const it: DesktopTrayTranslation = {
    open: 'Apri Happier',
    openInHappier: 'Apri in Happier',
    settings: 'Impostazioni…',
    startAtLogin: 'Avvia all’accesso',
    quit: 'Esci da Happier',
    stopServicesAndQuit: 'Arresta i servizi in background ed esci…',
    sessions: ({ count }: CountParams) => `${count} in corso`,
    start: 'Avvia',
    restart: 'Riavvia',
    stop: 'Arresta…',
    userOwned: 'Gestito fuori da Happier',
    checking: 'Controllo dei servizi in background…',
    readFailed: 'Impossibile controllare i servizi in background',
    incomplete: 'Alcuni servizi in background non sono stati controllati',
    noServices: 'Questo computer non è ancora configurato',
    working: 'In corso…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Arrestare il servizio in background di Happier per ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Le sessioni degli agenti in esecuzione su questo computer per ${relay} termineranno, e telefono e browser non potranno raggiungerlo lì finché il servizio non ripartirà.`,
    stopAllConfirmTitle: 'Arrestare i servizi in background di Happier e uscire?',
    stopAllConfirmBody: 'Le sessioni degli agenti su questo computer termineranno, e telefono e browser non potranno raggiungerlo finché i suoi servizi in background non ripartiranno.',
    stopConfirmAction: 'Arresta',
    actionFailedTitle: 'Non è andata a buon fine',
    loginItemFailed: 'Impossibile aggiornare l’elemento di avvio di Happier',
    quitStopTitle: 'Ci sono ancora sessioni degli agenti in esecuzione',
    quitStopBody: 'Uscendo si arrestano i servizi in background di questo computer e terminano le sessioni in esecuzione qui.',
    quitStopUnknownTitle: 'Arrestare i servizi in background?',
    quitStopUnknownBody: 'Happier non vede quali sessioni sono in esecuzione su questo computer. Uscendo si arrestano i suoi servizi in background e terminano quelle in corso.',
    quitStopConfirm: 'Arresta comunque',
    quitStopKeep: 'Lasciali attivi',
    quitStopFailedTitle: 'Alcuni servizi in background non si sono arrestati',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier resta aperto così puoi controllare i servizi in background e riprovare.`,
};

const ja: DesktopTrayTranslation = {
    open: 'Happier を開く',
    openInHappier: 'Happier で開く',
    settings: '設定…',
    startAtLogin: 'ログイン時に起動',
    quit: 'Happier を終了',
    stopServicesAndQuit: 'バックグラウンドサービスを停止して終了…',
    sessions: ({ count }: CountParams) => `${count} 件実行中`,
    start: '起動',
    restart: '再起動',
    stop: '停止…',
    userOwned: 'Happier の外で管理されています',
    checking: 'バックグラウンドサービスを確認しています…',
    readFailed: 'バックグラウンドサービスを確認できませんでした',
    incomplete: '一部のバックグラウンドサービスを確認できませんでした',
    noServices: 'このコンピューターはまだセットアップされていません',
    working: '処理中…',
    stopConfirmTitle: ({ relay }: RelayParams) => `${relay} 用の Happier のバックグラウンドサービスを停止しますか？`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `このコンピューターで ${relay} 用に実行中のエージェントセッションは終了し、サービスが再び起動するまで、スマートフォンやブラウザからそこでこのコンピューターに接続できなくなります。`,
    stopAllConfirmTitle: 'Happier のバックグラウンドサービスを停止して終了しますか？',
    stopAllConfirmBody: 'このコンピューターのエージェントセッションは終了し、バックグラウンドサービスが再び起動するまで、スマートフォンやブラウザから接続できなくなります。',
    stopConfirmAction: '停止',
    actionFailedTitle: '完了できませんでした',
    loginItemFailed: 'Happier のログイン項目を更新できませんでした',
    quitStopTitle: 'エージェントセッションがまだ実行中です',
    quitStopBody: '終了すると、このコンピューターのバックグラウンドサービスが停止し、ここで実行中のセッションが終了します。',
    quitStopUnknownTitle: 'バックグラウンドサービスを停止しますか？',
    quitStopUnknownBody: 'Happier はこのコンピューターで実行中のセッションを確認できません。終了するとバックグラウンドサービスが停止し、実行中のセッションは終了します。',
    quitStopConfirm: '停止する',
    quitStopKeep: '実行したままにする',
    quitStopFailedTitle: '一部のバックグラウンドサービスが停止しませんでした',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier は開いたままなので、バックグラウンドサービスを確認して再試行できます。`,
};

const pl: DesktopTrayTranslation = {
    open: 'Otwórz Happier',
    openInHappier: 'Otwórz w Happier',
    settings: 'Ustawienia…',
    startAtLogin: 'Uruchamiaj przy logowaniu',
    quit: 'Zakończ Happier',
    stopServicesAndQuit: 'Zatrzymaj usługi w tle i zakończ…',
    sessions: ({ count }: CountParams) => `aktywne: ${count}`,
    start: 'Uruchom',
    restart: 'Uruchom ponownie',
    stop: 'Zatrzymaj…',
    userOwned: 'Zarządzane poza Happier',
    checking: 'Sprawdzanie usług w tle…',
    readFailed: 'Nie udało się sprawdzić usług w tle',
    incomplete: 'Nie udało się sprawdzić niektórych usług w tle',
    noServices: 'Ten komputer nie jest jeszcze skonfigurowany',
    working: 'W toku…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Zatrzymać usługę Happier w tle dla ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Sesje agentów działające na tym komputerze dla ${relay} zostaną zakończone, a telefon i przeglądarka nie połączą się z nim tam, dopóki usługa nie uruchomi się ponownie.`,
    stopAllConfirmTitle: 'Zatrzymać usługi Happier w tle i zakończyć?',
    stopAllConfirmBody: 'Sesje agentów na tym komputerze zostaną zakończone, a telefon i przeglądarka nie połączą się z nim, dopóki jego usługi w tle nie uruchomią się ponownie.',
    stopConfirmAction: 'Zatrzymaj',
    actionFailedTitle: 'Nie udało się',
    loginItemFailed: 'Nie udało się zaktualizować elementu logowania Happier',
    quitStopTitle: 'Sesje agentów nadal działają',
    quitStopBody: 'Zakończenie zatrzymuje usługi w tle tego komputera i kończy działające tu sesje.',
    quitStopUnknownTitle: 'Zatrzymać usługi w tle?',
    quitStopUnknownBody: 'Happier nie widzi, które sesje działają na tym komputerze. Zakończenie zatrzymuje jego usługi w tle i kończy te, które działają.',
    quitStopConfirm: 'Zatrzymaj mimo to',
    quitStopKeep: 'Pozostaw uruchomione',
    quitStopFailedTitle: 'Niektóre usługi w tle nie zostały zatrzymane',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier pozostaje otwarty, aby można było sprawdzić usługi w tle i spróbować ponownie.`,
};

const pt: DesktopTrayTranslation = {
    open: 'Abrir o Happier',
    openInHappier: 'Abrir no Happier',
    settings: 'Configurações…',
    startAtLogin: 'Iniciar ao entrar',
    quit: 'Sair do Happier',
    stopServicesAndQuit: 'Parar serviços em segundo plano e sair…',
    sessions: ({ count }: CountParams) => `${count} em execução`,
    start: 'Iniciar',
    restart: 'Reiniciar',
    stop: 'Parar…',
    userOwned: 'Gerenciado fora do Happier',
    checking: 'Verificando serviços em segundo plano…',
    readFailed: 'Não foi possível verificar os serviços em segundo plano',
    incomplete: 'Alguns serviços em segundo plano não puderam ser verificados',
    noServices: 'Este computador ainda não está configurado',
    working: 'Trabalhando…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Parar o serviço em segundo plano do Happier para ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `As sessões de agente em execução neste computador para ${relay} serão encerradas, e seu telefone e seu navegador não poderão alcançá-lo lá até que o serviço inicie novamente.`,
    stopAllConfirmTitle: 'Parar os serviços em segundo plano do Happier e sair?',
    stopAllConfirmBody: 'As sessões de agente deste computador serão encerradas, e seu telefone e seu navegador não poderão alcançá-lo até que seus serviços em segundo plano iniciem novamente.',
    stopConfirmAction: 'Parar',
    actionFailedTitle: 'Não deu certo',
    loginItemFailed: 'Não foi possível atualizar o item de início do Happier',
    quitStopTitle: 'Ainda há sessões de agente em execução',
    quitStopBody: 'Sair para os serviços em segundo plano deste computador e encerra as sessões em execução aqui.',
    quitStopUnknownTitle: 'Parar os serviços em segundo plano?',
    quitStopUnknownBody: 'O Happier não consegue ver quais sessões estão em execução neste computador. Sair para os serviços em segundo plano e encerra as que estiverem.',
    quitStopConfirm: 'Parar mesmo assim',
    quitStopKeep: 'Deixar em execução',
    quitStopFailedTitle: 'Alguns serviços em segundo plano não pararam',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} O Happier permanece aberto para você verificar os serviços em segundo plano e tentar novamente.`,
};

const ru: DesktopTrayTranslation = {
    open: 'Открыть Happier',
    openInHappier: 'Открыть в Happier',
    settings: 'Настройки…',
    startAtLogin: 'Запускать при входе',
    quit: 'Завершить Happier',
    stopServicesAndQuit: 'Остановить фоновые службы и завершить…',
    sessions: ({ count }: CountParams) => `активно: ${count}`,
    start: 'Запустить',
    restart: 'Перезапустить',
    stop: 'Остановить…',
    userOwned: 'Управляется вне Happier',
    checking: 'Проверка фоновых служб…',
    readFailed: 'Не удалось проверить фоновые службы',
    incomplete: 'Некоторые фоновые службы не удалось проверить',
    noServices: 'Этот компьютер ещё не настроен',
    working: 'Выполняется…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Остановить фоновую службу Happier для ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Сеансы агентов на этом компьютере для ${relay} завершатся, и телефон и браузер не смогут подключиться к нему там, пока служба снова не запустится.`,
    stopAllConfirmTitle: 'Остановить фоновые службы Happier и завершить?',
    stopAllConfirmBody: 'Сеансы агентов на этом компьютере завершатся, и телефон и браузер не смогут подключиться к нему, пока его фоновые службы снова не запустятся.',
    stopConfirmAction: 'Остановить',
    actionFailedTitle: 'Не получилось',
    loginItemFailed: 'Не удалось обновить объект входа Happier',
    quitStopTitle: 'Сеансы агентов ещё выполняются',
    quitStopBody: 'При завершении фоновые службы этого компьютера остановятся, а сеансы на нём завершатся.',
    quitStopUnknownTitle: 'Остановить фоновые службы?',
    quitStopUnknownBody: 'Happier не видит, какие сеансы выполняются на этом компьютере. При завершении его фоновые службы остановятся, а выполняющиеся сеансы завершатся.',
    quitStopConfirm: 'Всё равно остановить',
    quitStopKeep: 'Оставить работать',
    quitStopFailedTitle: 'Некоторые фоновые службы не остановились',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier остаётся открытым, чтобы можно было проверить фоновые службы и повторить попытку.`,
};

const ca: DesktopTrayTranslation = {
    open: 'Obre Happier',
    openInHappier: 'Obre a Happier',
    settings: 'Configuració…',
    startAtLogin: 'Inicia en entrar',
    quit: 'Surt de Happier',
    stopServicesAndQuit: 'Atura els serveis en segon pla i surt…',
    sessions: ({ count }: CountParams) => `${count} en curs`,
    start: 'Inicia',
    restart: 'Reinicia',
    stop: 'Atura…',
    userOwned: 'Gestionat fora de Happier',
    checking: 'Comprovant els serveis en segon pla…',
    readFailed: 'No s’han pogut comprovar els serveis en segon pla',
    incomplete: 'Alguns serveis en segon pla no s’han pogut comprovar',
    noServices: 'Aquest ordinador encara no està configurat',
    working: 'Treballant…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Vols aturar el servei en segon pla de Happier per a ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Les sessions d’agent que s’executen en aquest ordinador per a ${relay} acabaran, i el telèfon i el navegador no hi podran accedir allà fins que el servei torni a iniciar-se.`,
    stopAllConfirmTitle: 'Vols aturar els serveis en segon pla de Happier i sortir?',
    stopAllConfirmBody: 'Les sessions d’agent d’aquest ordinador acabaran, i el telèfon i el navegador no hi podran accedir fins que els seus serveis en segon pla tornin a iniciar-se.',
    stopConfirmAction: 'Atura',
    actionFailedTitle: 'No s’ha pogut completar',
    loginItemFailed: 'No s’ha pogut actualitzar l’element d’inici de Happier',
    quitStopTitle: 'Encara hi ha sessions d’agent en execució',
    quitStopBody: 'En sortir s’aturen els serveis en segon pla d’aquest ordinador i acaben les sessions que s’hi executen.',
    quitStopUnknownTitle: 'Vols aturar els serveis en segon pla?',
    quitStopUnknownBody: 'Happier no veu quines sessions s’executen en aquest ordinador. En sortir s’aturen els seus serveis en segon pla i acaben les que hi hagi.',
    quitStopConfirm: 'Atura igualment',
    quitStopKeep: 'Deixa’ls en marxa',
    quitStopFailedTitle: 'Alguns serveis en segon pla no s’han aturat',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier es manté obert perquè puguis comprovar els serveis en segon pla i tornar-ho a provar.`,
};

const zhHans: DesktopTrayTranslation = {
    open: '打开 Happier',
    openInHappier: '在 Happier 中打开',
    settings: '设置…',
    startAtLogin: '登录时启动',
    quit: '退出 Happier',
    stopServicesAndQuit: '停止后台服务并退出…',
    sessions: ({ count }: CountParams) => `${count} 个运行中`,
    start: '启动',
    restart: '重新启动',
    stop: '停止…',
    userOwned: '在 Happier 之外管理',
    checking: '正在检查后台服务…',
    readFailed: '无法检查后台服务',
    incomplete: '部分后台服务无法检查',
    noServices: '这台电脑尚未设置',
    working: '正在处理…',
    stopConfirmTitle: ({ relay }: RelayParams) => `停止用于 ${relay} 的 Happier 后台服务？`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `这台电脑上为 ${relay} 运行的智能体会话将结束，在服务再次启动之前，你的手机和浏览器无法在那里访问这台电脑。`,
    stopAllConfirmTitle: '停止 Happier 后台服务并退出？',
    stopAllConfirmBody: '这台电脑上的智能体会话将结束，在其后台服务再次启动之前，你的手机和浏览器无法访问这台电脑。',
    stopConfirmAction: '停止',
    actionFailedTitle: '操作未完成',
    loginItemFailed: '无法更新 Happier 的登录项',
    quitStopTitle: '智能体会话仍在运行',
    quitStopBody: '退出会停止这台电脑的后台服务，并结束在这里运行的会话。',
    quitStopUnknownTitle: '停止后台服务？',
    quitStopUnknownBody: 'Happier 无法看到这台电脑上正在运行哪些会话。退出会停止其后台服务，并结束正在运行的会话。',
    quitStopConfirm: '仍然停止',
    quitStopKeep: '保持运行',
    quitStopFailedTitle: '部分后台服务未能停止',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier 会保持运行，方便你检查后台服务并重试。`,
};

const zhHant: DesktopTrayTranslation = {
    open: '打開 Happier',
    openInHappier: '在 Happier 中打開',
    settings: '設定…',
    startAtLogin: '登入時啟動',
    quit: '結束 Happier',
    stopServicesAndQuit: '停止背景服務並結束…',
    sessions: ({ count }: CountParams) => `${count} 個執行中`,
    start: '啟動',
    restart: '重新啟動',
    stop: '停止…',
    userOwned: '在 Happier 之外管理',
    checking: '正在檢查背景服務…',
    readFailed: '無法檢查背景服務',
    incomplete: '部分背景服務無法檢查',
    noServices: '這台電腦尚未設定',
    working: '正在處理…',
    stopConfirmTitle: ({ relay }: RelayParams) => `停止用於 ${relay} 的 Happier 背景服務？`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `這台電腦上為 ${relay} 執行的代理工作階段將結束，在服務再次啟動之前，你的手機和瀏覽器無法在那裡連到這台電腦。`,
    stopAllConfirmTitle: '停止 Happier 背景服務並結束？',
    stopAllConfirmBody: '這台電腦上的代理工作階段將結束，在其背景服務再次啟動之前，你的手機和瀏覽器無法連到這台電腦。',
    stopConfirmAction: '停止',
    actionFailedTitle: '操作未完成',
    loginItemFailed: '無法更新 Happier 的登入項目',
    quitStopTitle: '代理工作階段仍在執行',
    quitStopBody: '結束會停止這台電腦的背景服務，並結束在這裡執行的工作階段。',
    quitStopUnknownTitle: '停止背景服務？',
    quitStopUnknownBody: 'Happier 無法看到這台電腦上正在執行哪些工作階段。結束會停止其背景服務，並結束正在執行的工作階段。',
    quitStopConfirm: '仍然停止',
    quitStopKeep: '保持執行',
    quitStopFailedTitle: '部分背景服務未能停止',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier 會保持執行，方便你檢查背景服務並重試。`,
};


/** The one login-start setting (R16 b), in Settings › Desktop app. */
const enLoginStart = {
    title: 'Start at login',
    subtitle: 'Keeps this computer reachable from your phone and browser: its background services start when you sign in and keep running after you quit Happier. When this is off, quitting Happier stops them.',
    unknown: 'Happier can’t tell yet whether this computer’s background services start at login.',
    notSetUp: 'Available once this computer is set up.',
};

export type DesktopLoginStartTranslation = typeof enLoginStart;

const deLoginStart: DesktopLoginStartTranslation = {
    title: 'Beim Anmelden starten',
    subtitle: 'Hält diesen Computer für dein Telefon und deinen Browser erreichbar: Seine Hintergrunddienste starten beim Anmelden und laufen nach dem Beenden von Happier weiter. Ist dies aus, stoppt das Beenden von Happier diese Dienste.',
    unknown: 'Happier kann noch nicht erkennen, ob die Hintergrunddienste dieses Computers beim Anmelden starten.',
    notSetUp: 'Verfügbar, sobald dieser Computer eingerichtet ist.',
};

const esLoginStart: DesktopLoginStartTranslation = {
    title: 'Iniciar al acceder',
    subtitle: 'Mantiene este ordenador accesible desde tu teléfono y tu navegador: sus servicios en segundo plano se inician al acceder y siguen funcionando después de salir de Happier. Si está desactivado, salir de Happier los detiene.',
    unknown: 'Happier aún no sabe si los servicios en segundo plano de este ordenador se inician al acceder.',
    notSetUp: 'Disponible cuando este ordenador esté configurado.',
};

const frLoginStart: DesktopLoginStartTranslation = {
    title: 'Lancer à la connexion',
    subtitle: 'Garde cet ordinateur joignable depuis ton téléphone et ton navigateur : ses services en arrière-plan démarrent à la connexion et continuent après avoir quitté Happier. Désactivé, quitter Happier les arrête.',
    unknown: 'Happier ne sait pas encore si les services en arrière-plan de cet ordinateur démarrent à la connexion.',
    notSetUp: 'Disponible une fois cet ordinateur configuré.',
};

const itLoginStart: DesktopLoginStartTranslation = {
    title: 'Avvia all’accesso',
    subtitle: 'Mantiene questo computer raggiungibile da telefono e browser: i suoi servizi in background si avviano all’accesso e continuano dopo l’uscita da Happier. Se è disattivato, uscire da Happier li arresta.',
    unknown: 'Happier non sa ancora se i servizi in background di questo computer si avviano all’accesso.',
    notSetUp: 'Disponibile quando questo computer sarà configurato.',
};

const jaLoginStart: DesktopLoginStartTranslation = {
    title: 'ログイン時に起動',
    subtitle: 'スマートフォンやブラウザからこのコンピューターに接続できる状態を保ちます。ログイン時にバックグラウンドサービスが起動し、Happier の終了後も動作し続けます。オフにすると、Happier の終了時にサービスも停止します。',
    unknown: 'このコンピューターのバックグラウンドサービスがログイン時に起動するかどうか、まだ確認できません。',
    notSetUp: 'このコンピューターのセットアップ後に利用できます。',
};

const plLoginStart: DesktopLoginStartTranslation = {
    title: 'Uruchamiaj przy logowaniu',
    subtitle: 'Utrzymuje ten komputer dostępny z telefonu i przeglądarki: jego usługi w tle uruchamiają się przy logowaniu i działają po zamknięciu Happier. Gdy ta opcja jest wyłączona, zamknięcie Happier je zatrzymuje.',
    unknown: 'Happier nie wie jeszcze, czy usługi w tle tego komputera uruchamiają się przy logowaniu.',
    notSetUp: 'Dostępne po skonfigurowaniu tego komputera.',
};

const ptLoginStart: DesktopLoginStartTranslation = {
    title: 'Iniciar ao entrar',
    subtitle: 'Mantém este computador acessível pelo seu telefone e navegador: seus serviços em segundo plano iniciam ao entrar e continuam funcionando depois de sair do Happier. Desativado, sair do Happier para esses serviços.',
    unknown: 'O Happier ainda não sabe se os serviços em segundo plano deste computador iniciam ao entrar.',
    notSetUp: 'Disponível quando este computador estiver configurado.',
};

const ruLoginStart: DesktopLoginStartTranslation = {
    title: 'Запускать при входе',
    subtitle: 'Этот компьютер остаётся доступным с телефона и в браузере: его фоновые службы запускаются при входе и продолжают работать после завершения Happier. Если выключено, завершение Happier останавливает эти службы.',
    unknown: 'Happier пока не знает, запускаются ли фоновые службы этого компьютера при входе.',
    notSetUp: 'Будет доступно после настройки этого компьютера.',
};

const caLoginStart: DesktopLoginStartTranslation = {
    title: 'Inicia en entrar',
    subtitle: 'Manté aquest ordinador accessible des del telèfon i el navegador: els seus serveis en segon pla s’inicien quan entres i continuen després de sortir de Happier. Si està desactivat, sortir de Happier els atura.',
    unknown: 'Happier encara no sap si els serveis en segon pla d’aquest ordinador s’inicien en entrar.',
    notSetUp: 'Disponible quan aquest ordinador estigui configurat.',
};

const zhHansLoginStart: DesktopLoginStartTranslation = {
    title: '登录时启动',
    subtitle: '让你的手机和浏览器可以访问这台电脑：后台服务会在登录时启动，并在退出 Happier 后继续运行。关闭后，退出 Happier 会停止这些服务。',
    unknown: 'Happier 暂时无法确定这台电脑的后台服务是否会在登录时启动。',
    notSetUp: '设置好这台电脑后即可使用。',
};

const zhHantLoginStart: DesktopLoginStartTranslation = {
    title: '登入時啟動',
    subtitle: '讓你的手機和瀏覽器可以連到這台電腦：背景服務會在登入時啟動，並在結束 Happier 後繼續執行。關閉後，結束 Happier 會停止這些服務。',
    unknown: 'Happier 暫時無法確定這台電腦的背景服務是否會在登入時啟動。',
    notSetUp: '設定好這台電腦後即可使用。',
};

/** Mounted by spread inside `settingsDesktop`: `settingsDesktop.tray.*` and `settingsDesktop.loginStart.*`. */
export const menuBarModeTranslations = {
    en: { tray: en, loginStart: enLoginStart },
    de: { tray: de, loginStart: deLoginStart },
    es: { tray: es, loginStart: esLoginStart },
    fr: { tray: fr, loginStart: frLoginStart },
    it: { tray: it, loginStart: itLoginStart },
    ja: { tray: ja, loginStart: jaLoginStart },
    pl: { tray: pl, loginStart: plLoginStart },
    pt: { tray: pt, loginStart: ptLoginStart },
    ru: { tray: ru, loginStart: ruLoginStart },
    ca: { tray: ca, loginStart: caLoginStart },
    zhHans: { tray: zhHans, loginStart: zhHansLoginStart },
    zhHant: { tray: zhHant, loginStart: zhHantLoginStart },
};
