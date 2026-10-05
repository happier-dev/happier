type Service = Readonly<{ service: string }>;
type Home = Readonly<{ home: string }>;

/**
 * The Homes journeys (Direction B, "start now, reconcile later"): the "Already use Happier?"
 * doorway on Home, the reconcile sheet after a sign-in finds Homes, using the configured service
 * as a Home, Add a Home, the honest Personal Home label and the laptop nudge. Every service name
 * is the configured service's own (`accountServiceDisplayName`), never a product constant.
 */
type HomesJourneysTranslation = Readonly<{
    phone: Readonly<{
        reconcileTitle: string;
        reconcileLead: string;
        showMySessions: string;
        scanComputerCode: string;
        serviceLead: string;
        serviceAsHomeLead: (params: Service) => string;
        factAlwaysOnDetail: string;
        factAgents: string;
        factAgentsDetail: string;
        fromDeviceHelp: string;
        scan: string;
    }>;
    /** The portable identity on the default service. */
    happierAccount: string;
    /** …and on any other sign-in service. */
    serviceAccount: (params: Service) => string;

    // "Already use Happier?" at rest.
    alreadyUseTitle: string;
    alreadyUseDescription: string;
    signIn: string;
    /** The service beside Sign in; pressing it changes the service. */
    withService: (params: Service) => string;
    changeServiceLabel: (params: Service) => string;
    connectToHome: string;
    hostedPrompt: string;
    useServiceAsAHome: (params: Service) => string;
    dismiss: string;

    // The three paths.
    pathServiceTitle: (params: Service) => string;
    pathServiceSubtitle: string;
    pathOtherServiceTitle: string;
    pathOtherServiceSubtitle: string;
    pathDirectTitle: string;
    pathDirectSubtitle: string;

    // (a) the configured service.
    serviceLead: string;
    defaultServiceFact: string;
    serviceMethodsHelp: (params: Service) => string;

    // (b) another service.
    otherServiceLead: string;
    serviceAddressLabel: string;
    serviceFound: string;
    useThisService: (params: Service) => string;
    addressIsNotAService: string;
    connectAsHome: string;
    backToService: (params: Service) => string;

    // (c) a Home directly.
    directLead: string;
    fromDeviceLabel: string;
    fromDeviceHelp: string;
    homeLinkLabel: string;
    homeLinkPlaceholder: string;
    useCamera: string;
    openLink: string;
    byAddressLabel: string;
    homeAddressPlaceholder: string;
    connect: string;
    byAddressHelp: string;
    notAHomeLink: string;
    homeUnreachable: string;

    // (d) the Home's own sign-in.
    anotherWay: string;
    homeReachable: string;
    connected: string;
    signInToHomeTitle: string;
    signInToHomeLead: string;

    // Reconcile after a sign-in finds Homes.
    reconcileTitle: string;
    reconcileLead: (params: Readonly<{ count: number }>) => string;
    reconcileFound: string;
    reconcileThisComputer: string;
    runSessionsIn: string;
    runSessionsInDescription: string;
    removeEmptyPersonalHome: string;
    removeEmptyPersonalHomeDescription: string;
    changeLater: string;
    keepBoth: string;
    useHome: (params: Home) => string;
    reconcileSetupTitle: string;
    reconcileSetupSubtitle: (params: Home) => string;
    reconcileSetupAction: string;

    // Using the configured service as the Home.
    serviceAsHomeTitle: (params: Service) => string;
    serviceAsHomeLead: (params: Service) => string;
    factAlwaysOn: string;
    factAlwaysOnDetail: string;
    factAgents: string;
    factAgentsDetail: string;
    storageE2ee: string;
    storageE2eeDetail: (params: Service) => string;
    storagePlain: (params: Service) => string;
    storagePlainDetail: string;
    storageE2eeByDefault: string;
    storagePlainByDefault: (params: Service) => string;
    storageChoiceDetail: string;
    removeEmptyOfferedDetail: string;
    signInOrCreate: (params: Readonly<{ account: string }>) => string;
    alreadyUseServiceAsHome: (params: Service) => string;

    // Add a Home.
    addHomeTitle: string;
    addHomeDescription: string;
    addSignIn: (params: Readonly<{ account: string }>) => string;
    addSignInSubtitle: string;
    addServiceAsHomeSubtitle: string;
    addLinkOrQr: string;
    addLinkOrQrSubtitle: string;
    addServerHome: string;
    addServerHomeSubtitle: string;
    haveHomeAddress: string;
    enterIt: string;

    // Where a Home lives.
    livesOnThisComputer: string;
    availableWhileAwake: string;
    /** The Personal Home while this computer is still starting it. */
    gettingReady: string;
    /** The phone welcome's quiet row for someone with no computer set up. */
    noComputerYet: string;
    aboutYourHome: string;

    // The laptop nudge.
    nudgeTitle: (params: Readonly<{ count: number }>) => string;
    nudgeBody: string;
    nudgeDismiss: string;
    moveHome: string;
    useService: (params: Service) => string;
}>;

const en: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Your Homes are here",
        reconcileLead: "This phone now follows your Homes together.",
        showMySessions: "Show my sessions",
        scanComputerCode: "Scan the code on your computer",
        serviceLead: "Your Homes are found after you sign in. This phone then follows them all.",
        serviceAsHomeLead: ({ service }) => `Your sessions live on ${service}, always reachable. Add a computer to run agents whenever you’re ready.`,
        factAlwaysOnDetail: "Reach your sessions any time.",
        factAgents: "Your computers run the agents",
        factAgentsDetail: "Add one later with a QR code.",
        fromDeviceHelp: "On it, open Settings → Add your phone, then scan its code with this phone’s camera or paste its Home link.",
        scan: "Scan",
    },
    happierAccount: 'Happier account',
    serviceAccount: ({ service }) => `${service} account`,

    alreadyUseTitle: 'Already use Happier?',
    alreadyUseDescription: 'Find your Homes with your account, or connect straight to a Home you run. Nothing on this computer changes until you choose.',
    signIn: 'Sign in',
    withService: ({ service }) => `with ${service}`,
    changeServiceLabel: ({ service }) => `Sign-in service: ${service}. Change`,
    connectToHome: 'Connect to a Home…',
    hostedPrompt: 'Rather have it hosted?',
    useServiceAsAHome: ({ service }) => `Use ${service} as a Home`,
    dismiss: 'Dismiss',

    pathServiceTitle: ({ service }) => `Sign in with ${service}`,
    pathServiceSubtitle: 'Find the Homes linked to your account',
    pathOtherServiceTitle: 'Sign in with another service',
    pathOtherServiceSubtitle: 'Your own or your company’s sign-in',
    pathDirectTitle: 'Connect to a Home directly',
    pathDirectSubtitle: 'A link or an address · no account',

    serviceLead: 'Your Homes are found after you sign in and show up together. This computer’s Personal Home stays until you decide.',
    defaultServiceFact: 'the default sign-in service',
    serviceMethodsHelp: ({ service }) => `Only the methods ${service} offers are shown. New here? The same buttons create your account.`,

    otherServiceLead: 'If you or your team run your own sign-in service, enter its address. Happier checks what it offers before anything else.',
    serviceAddressLabel: 'Sign-in service address',
    serviceFound: 'Found',
    useThisService: ({ service }) => `Sign in with ${service}`,
    addressIsNotAService: 'This address doesn’t offer account sign-in. If it’s a Home, connect to it directly instead.',
    connectAsHome: 'Connect to it as a Home',
    backToService: ({ service }) => `Back to ${service}`,

    directLead: 'For a Home you run yourself, with or without an account service. No Happier account needed.',
    fromDeviceLabel: 'From a device that’s already connected',
    fromDeviceHelp: 'On it, open Settings → Add your phone, then scan its code with this computer’s camera or paste its Home link.',
    homeLinkLabel: 'Home link',
    homeLinkPlaceholder: 'Paste a Home link',
    useCamera: 'Use camera',
    openLink: 'Open',
    byAddressLabel: 'By address',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Connect',
    byAddressHelp: 'Happier checks the Home answers, then you sign in with that Home’s own methods.',
    notAHomeLink: 'That isn’t a Home link. Copy it again from the other device.',
    homeUnreachable: 'Happier couldn’t reach a Home at that address. Check the address and that the Home is running.',

    anotherWay: 'Another way',
    homeReachable: 'Reachable',
    connected: 'Connected',
    signInToHomeTitle: 'Sign in to this Home',
    signInToHomeLead: 'These are the ways this Home offers.',

    reconcileTitle: 'Your Homes are connected',
    reconcileLead: ({ count }) => count === 1
        ? 'This computer now has two Homes. They show together under All Homes.'
        : `This computer now has ${count + 1} Homes. They show together under All Homes.`,
    reconcileFound: 'Found',
    reconcileThisComputer: 'This computer',
    runSessionsIn: 'Run this computer’s sessions in',
    runSessionsInDescription: 'New sessions started here are saved in this Home.',
    removeEmptyPersonalHome: 'Remove the empty Personal Home',
    removeEmptyPersonalHomeDescription: 'It was created when you installed Happier and holds nothing yet — no sessions, people, Teams or invitations.',
    changeLater: 'Change this later in Settings → Homes.',
    keepBoth: 'Keep both',
    useHome: ({ home }) => `Use ${home}`,
    reconcileSetupTitle: 'Choose where this computer’s sessions go',
    reconcileSetupSubtitle: ({ home }) => `You connected ${home}. Keep both Homes, or run this computer’s sessions there.`,
    reconcileSetupAction: 'Choose…',

    serviceAsHomeTitle: ({ service }) => `Use ${service} as your Home`,
    serviceAsHomeLead: ({ service }) => `Your sessions and settings live on ${service} instead of this computer.`,
    factAlwaysOn: 'Always on',
    factAlwaysOnDetail: 'Your phone reaches your sessions while this computer sleeps.',
    factAgents: 'This computer keeps running your agents',
    factAgentsDetail: 'Nothing changes about where code runs.',
    storageE2ee: 'End-to-end encrypted',
    storageE2eeDetail: ({ service }) => `${service} stores your sessions but can’t read them.`,
    storagePlain: ({ service }) => `Stored by ${service}`,
    storagePlainDetail: 'Not end-to-end encrypted: the service can read what it stores.',
    storageE2eeByDefault: 'End-to-end encrypted by default',
    storagePlainByDefault: ({ service }) => `Stored by ${service}, readable by default`,
    storageChoiceDetail: 'You choose when you create your account.',
    removeEmptyOfferedDetail: 'It holds nothing yet. Only offered because it’s empty.',
    signInOrCreate: ({ account }) => `Sign in or create your ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Already use ${service} as your Home? Signing in connects it directly.`,

    addHomeTitle: 'Add a Home',
    addHomeDescription: 'A Home keeps your sessions and settings. Connect one you already use, or start one somewhere new.',
    addSignIn: ({ account }) => `Sign in with your ${account}`,
    addSignInSubtitle: 'Find the Homes you already use and connect them.',
    addServiceAsHomeSubtitle: 'Hosted for you and always on.',
    addLinkOrQr: 'Connect with a link or QR code',
    addLinkOrQrSubtitle: 'No account needed. Get it from a device that’s already connected.',
    addServerHome: 'Set up a Home on a server',
    addServerHomeSubtitle: 'A dev box or VPS you control, set up over SSH.',
    haveHomeAddress: 'Have a Home address?',
    enterIt: 'Enter it',

    livesOnThisComputer: 'Lives on this computer',
    availableWhileAwake: 'available while it’s awake',
    gettingReady: 'getting ready',
    noComputerYet: 'No computer yet?',
    aboutYourHome: 'About your Home',

    nudgeTitle: ({ count }) => `Home unreachable ${count} times this week — move Home?`,
    nudgeBody: 'If this Home runs on a computer that sleeps, moving it to an always-on host can help.',
    nudgeDismiss: 'Dismiss forever on this device',
    moveHome: 'Move Home…',
    useService: ({ service }) => `Use ${service}`,
};

const ca: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Els teus Homes són aquí",
        reconcileLead: "Aquest telèfon ara segueix els teus Homes junts.",
        showMySessions: "Mostra les meves sessions",
        scanComputerCode: "Escaneja el codi del teu ordinador",
        serviceLead: "Els teus Homes es troben quan inicies sessió. Aquest telèfon els segueix tots.",
        serviceAsHomeLead: ({ service }) => `Les teves sessions són a ${service}, sempre accessibles. Afegeix un ordinador per executar agents quan vulguis.`,
        factAlwaysOnDetail: "Accedeix a les teves sessions en qualsevol moment.",
        factAgents: "Els teus ordinadors executen els agents",
        factAgentsDetail: "Afegeix-ne un més tard amb un codi QR.",
        fromDeviceHelp: "Obre-hi Configuració → Afegeix el teu telèfon i escaneja’n el codi amb la càmera d’aquest telèfon o enganxa’n l’enllaç del Home.",
        scan: "Escaneja",
    },
    happierAccount: 'compte de Happier',
    serviceAccount: ({ service }) => `compte de ${service}`,

    alreadyUseTitle: 'Ja fas servir Happier?',
    alreadyUseDescription: 'Troba els teus Homes amb el teu compte o connecta’t directament a un Home que gestiones. No canvia res en aquest ordinador fins que triïs.',
    signIn: 'Inicia sessió',
    withService: ({ service }) => `amb ${service}`,
    changeServiceLabel: ({ service }) => `Servei d’inici de sessió: ${service}. Canvia’l`,
    connectToHome: 'Connecta’t a un Home…',
    hostedPrompt: 'Prefereixes que te l’allotgin?',
    useServiceAsAHome: ({ service }) => `Fes servir ${service} com a Home`,
    dismiss: 'Descarta',

    pathServiceTitle: ({ service }) => `Inicia sessió amb ${service}`,
    pathServiceSubtitle: 'Troba els Homes enllaçats al teu compte',
    pathOtherServiceTitle: 'Inicia sessió amb un altre servei',
    pathOtherServiceSubtitle: 'El teu propi inici de sessió o el de la teva empresa',
    pathDirectTitle: 'Connecta’t directament a un Home',
    pathDirectSubtitle: 'Un enllaç o una adreça · sense compte',

    serviceLead: 'Els teus Homes apareixen junts quan inicies sessió. El Home personal d’aquest ordinador es manté fins que decideixis.',
    defaultServiceFact: 'el servei d’inici de sessió predeterminat',
    serviceMethodsHelp: ({ service }) => `Només es mostren els mètodes que ofereix ${service}. Ets nou? Els mateixos botons creen el teu compte.`,

    otherServiceLead: 'Si tu o el teu equip gestioneu el vostre propi servei d’inici de sessió, introdueix-ne l’adreça. Happier comprova què ofereix abans de res.',
    serviceAddressLabel: 'Adreça del servei d’inici de sessió',
    serviceFound: 'Trobat',
    useThisService: ({ service }) => `Inicia sessió amb ${service}`,
    addressIsNotAService: 'Aquesta adreça no ofereix inici de sessió amb compte. Si és un Home, connecta-t’hi directament.',
    connectAsHome: 'Connecta-t’hi com a Home',
    backToService: ({ service }) => `Torna a ${service}`,

    directLead: 'Per a un Home que gestiones tu mateix, amb servei de comptes o sense. No cal cap compte de Happier.',
    fromDeviceLabel: 'Des d’un dispositiu que ja està connectat',
    fromDeviceHelp: 'Obre-hi Configuració → Afegeix el teu telèfon i escaneja’n el codi amb la càmera d’aquest ordinador o enganxa’n l’enllaç del Home.',
    homeLinkLabel: 'Enllaç del Home',
    homeLinkPlaceholder: 'Enganxa un enllaç de Home',
    useCamera: 'Fes servir la càmera',
    openLink: 'Obre',
    byAddressLabel: 'Per adreça',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Connecta',
    byAddressHelp: 'Happier comprova que el Home respon i després inicies sessió amb els mètodes d’aquell Home.',
    notAHomeLink: 'Això no és un enllaç de Home. Torna’l a copiar de l’altre dispositiu.',
    homeUnreachable: 'Happier no ha pogut arribar a cap Home en aquesta adreça. Comprova l’adreça i que el Home estigui en marxa.',

    anotherWay: 'Una altra manera',
    homeReachable: 'Accessible',
    connected: 'Connectat',
    signInToHomeTitle: 'Inicia sessió en aquest Home',
    signInToHomeLead: 'Aquestes són les maneres que ofereix aquest Home.',

    reconcileTitle: 'Els teus Homes estan connectats',
    reconcileLead: ({ count }) => count === 1
        ? 'Ara aquest ordinador té dos Homes. Es mostren junts a Totes les Homes.'
        : `Ara aquest ordinador té ${count + 1} Homes. Es mostren junts a Totes les Homes.`,
    reconcileFound: 'Trobats',
    reconcileThisComputer: 'Aquest ordinador',
    runSessionsIn: 'Executa les sessions d’aquest ordinador a',
    runSessionsInDescription: 'Les sessions noves iniciades aquí es desen en aquest Home.',
    removeEmptyPersonalHome: 'Elimina el Home personal buit',
    removeEmptyPersonalHomeDescription: 'Es va crear quan vas instal·lar Happier i encara no conté res: ni sessions, ni persones, ni equips, ni invitacions.',
    changeLater: 'Pots canviar-ho més tard a Configuració → Homes.',
    keepBoth: 'Conserva’ls tots dos',
    useHome: ({ home }) => `Fes servir ${home}`,
    reconcileSetupTitle: 'Tria on van les sessions d’aquest ordinador',
    reconcileSetupSubtitle: ({ home }) => `Has connectat ${home}. Conserva els dos Homes o executa-hi les sessions d’aquest ordinador.`,
    reconcileSetupAction: 'Tria…',

    serviceAsHomeTitle: ({ service }) => `Fes servir ${service} com a Home`,
    serviceAsHomeLead: ({ service }) => `Les teves sessions i la configuració es desen a ${service} en lloc d’aquest ordinador.`,
    factAlwaysOn: 'Sempre disponible',
    factAlwaysOnDetail: 'El teu telèfon arriba a les sessions mentre aquest ordinador dorm.',
    factAgents: 'Aquest ordinador continua executant els teus agents',
    factAgentsDetail: 'No canvia res d’on s’executa el codi.',
    storageE2ee: 'Xifrat d’extrem a extrem',
    storageE2eeDetail: ({ service }) => `${service} desa les teves sessions però no les pot llegir.`,
    storagePlain: ({ service }) => `Desat per ${service}`,
    storagePlainDetail: 'Sense xifratge d’extrem a extrem: el servei pot llegir el que desa.',
    storageE2eeByDefault: 'Xifrat d’extrem a extrem per defecte',
    storagePlainByDefault: ({ service }) => `Desat per ${service}, llegible per defecte`,
    storageChoiceDetail: 'Ho tries en crear el compte.',
    removeEmptyOfferedDetail: 'Encara no conté res. Només s’ofereix perquè és buit.',
    signInOrCreate: ({ account }) => `Inicia sessió o crea el teu ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Ja fas servir ${service} com a Home? En iniciar sessió s’hi connecta directament.`,

    addHomeTitle: 'Afegeix un Home',
    addHomeDescription: 'Un Home desa les teves sessions i la configuració. Connecta’n un que ja facis servir o comença’n un en un altre lloc.',
    addSignIn: ({ account }) => `Inicia sessió amb el teu ${account}`,
    addSignInSubtitle: 'Troba els Homes que ja fas servir i connecta’ls.',
    addServiceAsHomeSubtitle: 'Allotjat per a tu i sempre disponible.',
    addLinkOrQr: 'Connecta’t amb un enllaç o un codi QR',
    addLinkOrQrSubtitle: 'No cal cap compte. Obtén-lo d’un dispositiu que ja estigui connectat.',
    addServerHome: 'Configura un Home en un servidor',
    addServerHomeSubtitle: 'Un entorn de desenvolupament o un VPS que controles, configurat per SSH.',
    haveHomeAddress: 'Tens l’adreça d’un Home?',
    enterIt: 'Introdueix-la',

    livesOnThisComputer: 'És en aquest ordinador',
    availableWhileAwake: 'disponible mentre està despert',
    gettingReady: 's’està preparant',
    noComputerYet: 'Encara no tens ordinador?',
    aboutYourHome: 'Quant al teu Home',

    nudgeTitle: ({ count }) => `Home inaccessible ${count} vegades aquesta setmana — el vols moure?`,
    nudgeBody: 'Si aquest Home funciona en un ordinador que dorm, moure’l a un servidor sempre encès pot ajudar.',
    nudgeDismiss: 'Descarta-ho per sempre en aquest dispositiu',
    moveHome: 'Mou el Home…',
    useService: ({ service }) => `Fes servir ${service}`,
};

const de: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Deine Homes sind hier",
        reconcileLead: "Dieses Telefon folgt jetzt deinen Homes gemeinsam.",
        showMySessions: "Meine Sitzungen anzeigen",
        scanComputerCode: "Scanne den Code auf deinem Computer",
        serviceLead: "Nach der Anmeldung werden deine Homes gefunden. Dieses Telefon folgt dann allen.",
        serviceAsHomeLead: ({ service }) => `Deine Sitzungen liegen auf ${service} und sind jederzeit erreichbar. Füge einen Computer für Agenten hinzu, wenn du bereit bist.`,
        factAlwaysOnDetail: "Erreiche deine Sitzungen jederzeit.",
        factAgents: "Deine Computer führen die Agenten aus",
        factAgentsDetail: "Füge später einen mit einem QR-Code hinzu.",
        fromDeviceHelp: "Öffne dort Einstellungen → Telefon hinzufügen und scanne den Code mit der Kamera dieses Telefons oder füge den Home-Link ein.",
        scan: "Scannen",
    },
    happierAccount: 'Happier-Konto',
    serviceAccount: ({ service }) => `${service}-Konto`,

    alreadyUseTitle: 'Nutzt du Happier schon?',
    alreadyUseDescription: 'Finde deine Homes mit deinem Konto oder verbinde dich direkt mit einem Home, das du betreibst. Auf diesem Computer ändert sich nichts, bis du dich entscheidest.',
    signIn: 'Anmelden',
    withService: ({ service }) => `mit ${service}`,
    changeServiceLabel: ({ service }) => `Anmeldedienst: ${service}. Ändern`,
    connectToHome: 'Mit einem Home verbinden…',
    hostedPrompt: 'Lieber gehostet?',
    useServiceAsAHome: ({ service }) => `${service} als Home nutzen`,
    dismiss: 'Ausblenden',

    pathServiceTitle: ({ service }) => `Mit ${service} anmelden`,
    pathServiceSubtitle: 'Die mit deinem Konto verknüpften Homes finden',
    pathOtherServiceTitle: 'Mit einem anderen Dienst anmelden',
    pathOtherServiceSubtitle: 'Deine eigene Anmeldung oder die deiner Firma',
    pathDirectTitle: 'Direkt mit einem Home verbinden',
    pathDirectSubtitle: 'Ein Link oder eine Adresse · kein Konto',

    serviceLead: 'Nach der Anmeldung werden deine Homes gefunden und gemeinsam angezeigt. Das persönliche Home dieses Computers bleibt, bis du entscheidest.',
    defaultServiceFact: 'der Standard-Anmeldedienst',
    serviceMethodsHelp: ({ service }) => `Es werden nur die Methoden angezeigt, die ${service} anbietet. Neu hier? Dieselben Buttons legen dein Konto an.`,

    otherServiceLead: 'Wenn du oder dein Team einen eigenen Anmeldedienst betreibt, gib seine Adresse ein. Happier prüft zuerst, was er anbietet.',
    serviceAddressLabel: 'Adresse des Anmeldedienstes',
    serviceFound: 'Gefunden',
    useThisService: ({ service }) => `Mit ${service} anmelden`,
    addressIsNotAService: 'Diese Adresse bietet keine Kontoanmeldung. Wenn es ein Home ist, verbinde dich stattdessen direkt damit.',
    connectAsHome: 'Als Home verbinden',
    backToService: ({ service }) => `Zurück zu ${service}`,

    directLead: 'Für ein Home, das du selbst betreibst, mit oder ohne Kontodienst. Kein Happier-Konto nötig.',
    fromDeviceLabel: 'Von einem bereits verbundenen Gerät',
    fromDeviceHelp: 'Öffne dort Einstellungen → Telefon hinzufügen und scanne den Code mit der Kamera dieses Computers oder füge den Home-Link ein.',
    homeLinkLabel: 'Home-Link',
    homeLinkPlaceholder: 'Home-Link einfügen',
    useCamera: 'Kamera verwenden',
    openLink: 'Öffnen',
    byAddressLabel: 'Per Adresse',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Verbinden',
    byAddressHelp: 'Happier prüft, ob das Home antwortet; danach meldest du dich mit den Methoden dieses Homes an.',
    notAHomeLink: 'Das ist kein Home-Link. Kopiere ihn noch einmal vom anderen Gerät.',
    homeUnreachable: 'Happier hat unter dieser Adresse kein Home erreicht. Prüfe die Adresse und ob das Home läuft.',

    anotherWay: 'Anderer Weg',
    homeReachable: 'Erreichbar',
    connected: 'Verbunden',
    signInToHomeTitle: 'Bei diesem Home anmelden',
    signInToHomeLead: 'Diese Wege bietet dieses Home an.',

    reconcileTitle: 'Deine Homes sind verbunden',
    reconcileLead: ({ count }) => count === 1
        ? 'Dieser Computer hat jetzt zwei Homes. Sie erscheinen gemeinsam unter „Alle Homes“.'
        : `Dieser Computer hat jetzt ${count + 1} Homes. Sie erscheinen gemeinsam unter „Alle Homes“.`,
    reconcileFound: 'Gefunden',
    reconcileThisComputer: 'Dieser Computer',
    runSessionsIn: 'Sitzungen dieses Computers ausführen in',
    runSessionsInDescription: 'Neue Sitzungen, die hier gestartet werden, werden in diesem Home gespeichert.',
    removeEmptyPersonalHome: 'Leeres persönliches Home entfernen',
    removeEmptyPersonalHomeDescription: 'Es wurde bei der Installation von Happier angelegt und enthält noch nichts – keine Sitzungen, Personen, Teams oder Einladungen.',
    changeLater: 'Du kannst das später unter Einstellungen → Homes ändern.',
    keepBoth: 'Beide behalten',
    useHome: ({ home }) => `${home} verwenden`,
    reconcileSetupTitle: 'Wähle, wohin die Sitzungen dieses Computers gehen',
    reconcileSetupSubtitle: ({ home }) => `Du hast ${home} verbunden. Behalte beide Homes oder führe die Sitzungen dieses Computers dort aus.`,
    reconcileSetupAction: 'Auswählen…',

    serviceAsHomeTitle: ({ service }) => `${service} als dein Home nutzen`,
    serviceAsHomeLead: ({ service }) => `Deine Sitzungen und Einstellungen liegen dann bei ${service} statt auf diesem Computer.`,
    factAlwaysOn: 'Immer erreichbar',
    factAlwaysOnDetail: 'Dein Telefon erreicht deine Sitzungen, während dieser Computer schläft.',
    factAgents: 'Dieser Computer führt weiter deine Agents aus',
    factAgentsDetail: 'Wo Code läuft, ändert sich nicht.',
    storageE2ee: 'Ende-zu-Ende-verschlüsselt',
    storageE2eeDetail: ({ service }) => `${service} speichert deine Sitzungen, kann sie aber nicht lesen.`,
    storagePlain: ({ service }) => `Gespeichert bei ${service}`,
    storagePlainDetail: 'Nicht Ende-zu-Ende-verschlüsselt: Der Dienst kann lesen, was er speichert.',
    storageE2eeByDefault: 'Standardmäßig Ende-zu-Ende-verschlüsselt',
    storagePlainByDefault: ({ service }) => `Gespeichert bei ${service}, standardmäßig lesbar`,
    storageChoiceDetail: 'Du entscheidest beim Anlegen deines Kontos.',
    removeEmptyOfferedDetail: 'Es enthält noch nichts. Wird nur angeboten, weil es leer ist.',
    signInOrCreate: ({ account }) => `Melde dich an oder lege dein ${account} an`,
    alreadyUseServiceAsHome: ({ service }) => `Nutzt du ${service} schon als Home? Die Anmeldung verbindet es direkt.`,

    addHomeTitle: 'Home hinzufügen',
    addHomeDescription: 'Ein Home speichert deine Sitzungen und Einstellungen. Verbinde eines, das du schon nutzt, oder starte ein neues an einem anderen Ort.',
    addSignIn: ({ account }) => `Mit deinem ${account} anmelden`,
    addSignInSubtitle: 'Finde die Homes, die du schon nutzt, und verbinde sie.',
    addServiceAsHomeSubtitle: 'Für dich gehostet und immer erreichbar.',
    addLinkOrQr: 'Mit Link oder QR-Code verbinden',
    addLinkOrQrSubtitle: 'Kein Konto nötig. Hol ihn dir von einem bereits verbundenen Gerät.',
    addServerHome: 'Home auf einem Server einrichten',
    addServerHomeSubtitle: 'Eine Dev-Box oder ein VPS unter deiner Kontrolle, per SSH eingerichtet.',
    haveHomeAddress: 'Hast du eine Home-Adresse?',
    enterIt: 'Eingeben',

    livesOnThisComputer: 'Liegt auf diesem Computer',
    availableWhileAwake: 'erreichbar, solange er wach ist',
    gettingReady: 'wird vorbereitet',
    noComputerYet: 'Noch kein Computer?',
    aboutYourHome: 'Über dein Home',

    nudgeTitle: ({ count }) => `Home diese Woche ${count}-mal nicht erreichbar — Home verschieben?`,
    nudgeBody: 'Wenn dieses Home auf einem Computer läuft, der in den Ruhezustand geht, kann ein ständig eingeschalteter Host helfen.',
    nudgeDismiss: 'Auf diesem Gerät dauerhaft ausblenden',
    moveHome: 'Home verschieben…',
    useService: ({ service }) => `${service} nutzen`,
};

const es: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Tus Homes están aquí",
        reconcileLead: "Este teléfono ahora sigue tus Homes juntos.",
        showMySessions: "Mostrar mis sesiones",
        scanComputerCode: "Escanea el código de tu ordenador",
        serviceLead: "Tus Homes se encuentran al iniciar sesión. Este teléfono los sigue a todos.",
        serviceAsHomeLead: ({ service }) => `Tus sesiones están en ${service}, siempre accesibles. Añade un ordenador para ejecutar agentes cuando quieras.`,
        factAlwaysOnDetail: "Accede a tus sesiones en cualquier momento.",
        factAgents: "Tus ordenadores ejecutan los agentes",
        factAgentsDetail: "Añade uno después con un código QR.",
        fromDeviceHelp: "Abre allí Ajustes → Añade tu teléfono y escanea el código con la cámara de este teléfono o pega el enlace del Home.",
        scan: "Escanear",
    },
    happierAccount: 'cuenta de Happier',
    serviceAccount: ({ service }) => `cuenta de ${service}`,

    alreadyUseTitle: '¿Ya usas Happier?',
    alreadyUseDescription: 'Encuentra tus Homes con tu cuenta o conéctate directamente a un Home que gestionas. Nada cambia en este ordenador hasta que elijas.',
    signIn: 'Iniciar sesión',
    withService: ({ service }) => `con ${service}`,
    changeServiceLabel: ({ service }) => `Servicio de inicio de sesión: ${service}. Cambiar`,
    connectToHome: 'Conectarse a un Home…',
    hostedPrompt: '¿Prefieres que esté alojado?',
    useServiceAsAHome: ({ service }) => `Usar ${service} como Home`,
    dismiss: 'Descartar',

    pathServiceTitle: ({ service }) => `Iniciar sesión con ${service}`,
    pathServiceSubtitle: 'Encuentra los Homes vinculados a tu cuenta',
    pathOtherServiceTitle: 'Iniciar sesión con otro servicio',
    pathOtherServiceSubtitle: 'Tu propio inicio de sesión o el de tu empresa',
    pathDirectTitle: 'Conectarse directamente a un Home',
    pathDirectSubtitle: 'Un enlace o una dirección · sin cuenta',

    serviceLead: 'Tus Homes aparecen juntos cuando inicias sesión. El Home personal de este ordenador se mantiene hasta que decidas.',
    defaultServiceFact: 'el servicio de inicio de sesión predeterminado',
    serviceMethodsHelp: ({ service }) => `Solo se muestran los métodos que ofrece ${service}. ¿Eres nuevo? Los mismos botones crean tu cuenta.`,

    otherServiceLead: 'Si tú o tu equipo gestionáis vuestro propio servicio de inicio de sesión, introduce su dirección. Happier comprueba qué ofrece antes de nada.',
    serviceAddressLabel: 'Dirección del servicio de inicio de sesión',
    serviceFound: 'Encontrado',
    useThisService: ({ service }) => `Iniciar sesión con ${service}`,
    addressIsNotAService: 'Esta dirección no ofrece inicio de sesión con cuenta. Si es un Home, conéctate a él directamente.',
    connectAsHome: 'Conectarse como Home',
    backToService: ({ service }) => `Volver a ${service}`,

    directLead: 'Para un Home que gestionas tú mismo, con o sin servicio de cuentas. No necesitas una cuenta de Happier.',
    fromDeviceLabel: 'Desde un dispositivo que ya está conectado',
    fromDeviceHelp: 'En él, abre Ajustes → Añadir tu teléfono y escanea su código con la cámara de este ordenador o pega su enlace de Home.',
    homeLinkLabel: 'Enlace de Home',
    homeLinkPlaceholder: 'Pega un enlace de Home',
    useCamera: 'Usar la cámara',
    openLink: 'Abrir',
    byAddressLabel: 'Por dirección',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Conectar',
    byAddressHelp: 'Happier comprueba que el Home responde y después inicias sesión con los métodos de ese Home.',
    notAHomeLink: 'Eso no es un enlace de Home. Vuelve a copiarlo desde el otro dispositivo.',
    homeUnreachable: 'Happier no ha podido llegar a ningún Home en esa dirección. Comprueba la dirección y que el Home esté en marcha.',

    anotherWay: 'Otra forma',
    homeReachable: 'Accesible',
    connected: 'Conectado',
    signInToHomeTitle: 'Iniciar sesión en este Home',
    signInToHomeLead: 'Estas son las formas que ofrece este Home.',

    reconcileTitle: 'Tus Homes están conectados',
    reconcileLead: ({ count }) => count === 1
        ? 'Este ordenador tiene ahora dos Homes. Aparecen juntos en Todos los Homes.'
        : `Este ordenador tiene ahora ${count + 1} Homes. Aparecen juntos en Todos los Homes.`,
    reconcileFound: 'Encontrados',
    reconcileThisComputer: 'Este ordenador',
    runSessionsIn: 'Ejecutar las sesiones de este ordenador en',
    runSessionsInDescription: 'Las sesiones nuevas iniciadas aquí se guardan en este Home.',
    removeEmptyPersonalHome: 'Eliminar el Home personal vacío',
    removeEmptyPersonalHomeDescription: 'Se creó al instalar Happier y todavía no contiene nada: ni sesiones, ni personas, ni equipos, ni invitaciones.',
    changeLater: 'Puedes cambiarlo más tarde en Ajustes → Homes.',
    keepBoth: 'Conservar ambos',
    useHome: ({ home }) => `Usar ${home}`,
    reconcileSetupTitle: 'Elige adónde van las sesiones de este ordenador',
    reconcileSetupSubtitle: ({ home }) => `Has conectado ${home}. Conserva ambos Homes o ejecuta allí las sesiones de este ordenador.`,
    reconcileSetupAction: 'Elegir…',

    serviceAsHomeTitle: ({ service }) => `Usar ${service} como tu Home`,
    serviceAsHomeLead: ({ service }) => `Tus sesiones y ajustes se guardan en ${service} en lugar de en este ordenador.`,
    factAlwaysOn: 'Siempre disponible',
    factAlwaysOnDetail: 'Tu teléfono llega a tus sesiones mientras este ordenador duerme.',
    factAgents: 'Este ordenador sigue ejecutando tus agentes',
    factAgentsDetail: 'No cambia nada de dónde se ejecuta el código.',
    storageE2ee: 'Cifrado de extremo a extremo',
    storageE2eeDetail: ({ service }) => `${service} guarda tus sesiones, pero no puede leerlas.`,
    storagePlain: ({ service }) => `Guardado por ${service}`,
    storagePlainDetail: 'Sin cifrado de extremo a extremo: el servicio puede leer lo que guarda.',
    storageE2eeByDefault: 'Cifrado de extremo a extremo por defecto',
    storagePlainByDefault: ({ service }) => `Guardado por ${service}, legible por defecto`,
    storageChoiceDetail: 'Lo eliges al crear tu cuenta.',
    removeEmptyOfferedDetail: 'Todavía no contiene nada. Solo se ofrece porque está vacío.',
    signInOrCreate: ({ account }) => `Inicia sesión o crea tu ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `¿Ya usas ${service} como tu Home? Al iniciar sesión se conecta directamente.`,

    addHomeTitle: 'Añadir un Home',
    addHomeDescription: 'Un Home guarda tus sesiones y ajustes. Conecta uno que ya uses o empieza uno nuevo en otro lugar.',
    addSignIn: ({ account }) => `Iniciar sesión con tu ${account}`,
    addSignInSubtitle: 'Encuentra los Homes que ya usas y conéctalos.',
    addServiceAsHomeSubtitle: 'Alojado para ti y siempre disponible.',
    addLinkOrQr: 'Conectarse con un enlace o un código QR',
    addLinkOrQrSubtitle: 'No necesitas cuenta. Obtenlo de un dispositivo que ya esté conectado.',
    addServerHome: 'Configurar un Home en un servidor',
    addServerHomeSubtitle: 'Una máquina de desarrollo o un VPS que controlas, configurado por SSH.',
    haveHomeAddress: '¿Tienes la dirección de un Home?',
    enterIt: 'Introdúcela',

    livesOnThisComputer: 'Está en este ordenador',
    availableWhileAwake: 'disponible mientras está activo',
    gettingReady: 'preparándose',
    noComputerYet: '¿Todavía no tienes ordenador?',
    aboutYourHome: 'Acerca de tu Home',

    nudgeTitle: ({ count }) => `Home inaccesible ${count} veces esta semana — ¿mover el Home?`,
    nudgeBody: 'Si este Home funciona en un ordenador que entra en reposo, moverlo a un servidor siempre encendido puede ayudar.',
    nudgeDismiss: 'Descartar para siempre en este dispositivo',
    moveHome: 'Mover el Home…',
    useService: ({ service }) => `Usar ${service}`,
};

const fr: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Tes Homes sont ici",
        reconcileLead: "Ce téléphone suit maintenant tous tes Homes.",
        showMySessions: "Afficher mes sessions",
        scanComputerCode: "Scanne le code sur ton ordinateur",
        serviceLead: "Tes Homes sont trouvés après la connexion. Ce téléphone les suit tous.",
        serviceAsHomeLead: ({ service }) => `Tes sessions sont sur ${service}, toujours accessibles. Ajoute un ordinateur pour exécuter les agents quand tu veux.`,
        factAlwaysOnDetail: "Accède à tes sessions à tout moment.",
        factAgents: "Tes ordinateurs exécutent les agents",
        factAgentsDetail: "Ajoutes-en un plus tard avec un code QR.",
        fromDeviceHelp: "Ouvre Réglages → Ajouter ton téléphone sur cet appareil, puis scanne son code avec la caméra de ce téléphone ou colle son lien Home.",
        scan: "Scanner",
    },
    happierAccount: 'compte Happier',
    serviceAccount: ({ service }) => `compte ${service}`,

    alreadyUseTitle: 'Tu utilises déjà Happier ?',
    alreadyUseDescription: 'Retrouve tes Homes avec ton compte, ou connecte-toi directement à un Home que tu gères. Rien ne change sur cet ordinateur tant que tu n’as pas choisi.',
    signIn: 'Se connecter',
    withService: ({ service }) => `avec ${service}`,
    changeServiceLabel: ({ service }) => `Service de connexion : ${service}. Modifier`,
    connectToHome: 'Se connecter à un Home…',
    hostedPrompt: 'Tu préfères un Home hébergé ?',
    useServiceAsAHome: ({ service }) => `Utiliser ${service} comme Home`,
    dismiss: 'Masquer',

    pathServiceTitle: ({ service }) => `Se connecter avec ${service}`,
    pathServiceSubtitle: 'Retrouver les Homes liés à ton compte',
    pathOtherServiceTitle: 'Se connecter avec un autre service',
    pathOtherServiceSubtitle: 'Ta propre connexion ou celle de ton entreprise',
    pathDirectTitle: 'Se connecter directement à un Home',
    pathDirectSubtitle: 'Un lien ou une adresse · sans compte',

    serviceLead: 'Tes Homes sont retrouvés après la connexion et s’affichent ensemble. Le Home personnel de cet ordinateur reste en place jusqu’à ce que tu décides.',
    defaultServiceFact: 'le service de connexion par défaut',
    serviceMethodsHelp: ({ service }) => `Seules les méthodes proposées par ${service} sont affichées. Nouveau ici ? Les mêmes boutons créent ton compte.`,

    otherServiceLead: 'Si toi ou ton équipe gérez votre propre service de connexion, saisis son adresse. Happier vérifie d’abord ce qu’il propose.',
    serviceAddressLabel: 'Adresse du service de connexion',
    serviceFound: 'Trouvé',
    useThisService: ({ service }) => `Se connecter avec ${service}`,
    addressIsNotAService: 'Cette adresse ne propose pas de connexion par compte. S’il s’agit d’un Home, connecte-toi directement à lui.',
    connectAsHome: 'S’y connecter comme Home',
    backToService: ({ service }) => `Revenir à ${service}`,

    directLead: 'Pour un Home que tu gères toi-même, avec ou sans service de comptes. Aucun compte Happier n’est nécessaire.',
    fromDeviceLabel: 'Depuis un appareil déjà connecté',
    fromDeviceHelp: 'Sur celui-ci, ouvre Réglages → Ajouter ton téléphone, puis scanne son code avec la caméra de cet ordinateur ou colle son lien de Home.',
    homeLinkLabel: 'Lien de Home',
    homeLinkPlaceholder: 'Colle un lien de Home',
    useCamera: 'Utiliser la caméra',
    openLink: 'Ouvrir',
    byAddressLabel: 'Par adresse',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Connecter',
    byAddressHelp: 'Happier vérifie que le Home répond, puis tu te connectes avec les méthodes de ce Home.',
    notAHomeLink: 'Ce n’est pas un lien de Home. Copie-le à nouveau depuis l’autre appareil.',
    homeUnreachable: 'Happier n’a pu joindre aucun Home à cette adresse. Vérifie l’adresse et que le Home est en marche.',

    anotherWay: 'Autre méthode',
    homeReachable: 'Joignable',
    connected: 'Connecté',
    signInToHomeTitle: 'Se connecter à ce Home',
    signInToHomeLead: 'Voici les méthodes proposées par ce Home.',

    reconcileTitle: 'Tes Homes sont connectés',
    reconcileLead: ({ count }) => count === 1
        ? 'Cet ordinateur a maintenant deux Homes. Ils s’affichent ensemble dans Tous les Homes.'
        : `Cet ordinateur a maintenant ${count + 1} Homes. Ils s’affichent ensemble dans Tous les Homes.`,
    reconcileFound: 'Trouvés',
    reconcileThisComputer: 'Cet ordinateur',
    runSessionsIn: 'Exécuter les sessions de cet ordinateur dans',
    runSessionsInDescription: 'Les nouvelles sessions lancées ici sont enregistrées dans ce Home.',
    removeEmptyPersonalHome: 'Supprimer le Home personnel vide',
    removeEmptyPersonalHomeDescription: 'Il a été créé à l’installation de Happier et ne contient encore rien : ni sessions, ni personnes, ni équipes, ni invitations.',
    changeLater: 'Tu pourras changer ça plus tard dans Réglages → Homes.',
    keepBoth: 'Garder les deux',
    useHome: ({ home }) => `Utiliser ${home}`,
    reconcileSetupTitle: 'Choisis où vont les sessions de cet ordinateur',
    reconcileSetupSubtitle: ({ home }) => `Tu as connecté ${home}. Garde les deux Homes, ou exécute-y les sessions de cet ordinateur.`,
    reconcileSetupAction: 'Choisir…',

    serviceAsHomeTitle: ({ service }) => `Utiliser ${service} comme Home`,
    serviceAsHomeLead: ({ service }) => `Tes sessions et réglages sont conservés sur ${service} plutôt que sur cet ordinateur.`,
    factAlwaysOn: 'Toujours disponible',
    factAlwaysOnDetail: 'Ton téléphone accède à tes sessions pendant que cet ordinateur est en veille.',
    factAgents: 'Cet ordinateur continue d’exécuter tes agents',
    factAgentsDetail: 'Rien ne change quant à l’endroit où le code s’exécute.',
    storageE2ee: 'Chiffré de bout en bout',
    storageE2eeDetail: ({ service }) => `${service} stocke tes sessions mais ne peut pas les lire.`,
    storagePlain: ({ service }) => `Stocké par ${service}`,
    storagePlainDetail: 'Pas de chiffrement de bout en bout : le service peut lire ce qu’il stocke.',
    storageE2eeByDefault: 'Chiffré de bout en bout par défaut',
    storagePlainByDefault: ({ service }) => `Stocké par ${service}, lisible par défaut`,
    storageChoiceDetail: 'Tu choisis en créant ton compte.',
    removeEmptyOfferedDetail: 'Il ne contient encore rien. Proposé uniquement parce qu’il est vide.',
    signInOrCreate: ({ account }) => `Connecte-toi ou crée ton ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Tu utilises déjà ${service} comme Home ? La connexion le relie directement.`,

    addHomeTitle: 'Ajouter un Home',
    addHomeDescription: 'Un Home conserve tes sessions et tes réglages. Connecte-en un que tu utilises déjà, ou lance-en un ailleurs.',
    addSignIn: ({ account }) => `Se connecter avec ton ${account}`,
    addSignInSubtitle: 'Retrouve les Homes que tu utilises déjà et connecte-les.',
    addServiceAsHomeSubtitle: 'Hébergé pour toi et toujours disponible.',
    addLinkOrQr: 'Se connecter avec un lien ou un code QR',
    addLinkOrQrSubtitle: 'Aucun compte nécessaire. Récupère-le depuis un appareil déjà connecté.',
    addServerHome: 'Configurer un Home sur un serveur',
    addServerHomeSubtitle: 'Une machine de dev ou un VPS que tu contrôles, configuré via SSH.',
    haveHomeAddress: 'Tu as l’adresse d’un Home ?',
    enterIt: 'La saisir',

    livesOnThisComputer: 'Sur cet ordinateur',
    availableWhileAwake: 'disponible tant qu’il est allumé',
    gettingReady: 'en préparation',
    noComputerYet: 'Pas encore d’ordinateur ?',
    aboutYourHome: 'À propos de ton Home',

    nudgeTitle: ({ count }) => `Home injoignable ${count} fois cette semaine — déplacer le Home ?`,
    nudgeBody: 'Si ce Home fonctionne sur un ordinateur qui se met en veille, le déplacer vers un serveur toujours allumé peut aider.',
    nudgeDismiss: 'Masquer définitivement sur cet appareil',
    moveHome: 'Déplacer le Home…',
    useService: ({ service }) => `Utiliser ${service}`,
};

const it: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "I tuoi Home sono qui",
        reconcileLead: "Questo telefono ora segue tutti i tuoi Home.",
        showMySessions: "Mostra le mie sessioni",
        scanComputerCode: "Scansiona il codice sul tuo computer",
        serviceLead: "I tuoi Home vengono trovati dopo l’accesso. Questo telefono li segue tutti.",
        serviceAsHomeLead: ({ service }) => `Le tue sessioni sono su ${service}, sempre raggiungibili. Aggiungi un computer per eseguire gli agenti quando vuoi.`,
        factAlwaysOnDetail: "Accedi alle tue sessioni in qualsiasi momento.",
        factAgents: "I tuoi computer eseguono gli agenti",
        factAgentsDetail: "Aggiungine uno più tardi con un codice QR.",
        fromDeviceHelp: "Su quel dispositivo apri Impostazioni → Aggiungi il tuo telefono, poi scansiona il codice con la fotocamera di questo telefono o incolla il link Home.",
        scan: "Scansiona",
    },
    happierAccount: 'account Happier',
    serviceAccount: ({ service }) => `account ${service}`,

    alreadyUseTitle: 'Usi già Happier?',
    alreadyUseDescription: 'Trova i tuoi Home con il tuo account oppure collegati direttamente a un Home che gestisci. Su questo computer non cambia nulla finché non scegli.',
    signIn: 'Accedi',
    withService: ({ service }) => `con ${service}`,
    changeServiceLabel: ({ service }) => `Servizio di accesso: ${service}. Cambia`,
    connectToHome: 'Collegati a un Home…',
    hostedPrompt: 'Preferisci un Home ospitato?',
    useServiceAsAHome: ({ service }) => `Usa ${service} come Home`,
    dismiss: 'Nascondi',

    pathServiceTitle: ({ service }) => `Accedi con ${service}`,
    pathServiceSubtitle: 'Trova gli Home collegati al tuo account',
    pathOtherServiceTitle: 'Accedi con un altro servizio',
    pathOtherServiceSubtitle: 'Il tuo accesso o quello della tua azienda',
    pathDirectTitle: 'Collegati direttamente a un Home',
    pathDirectSubtitle: 'Un link o un indirizzo · senza account',

    serviceLead: 'I tuoi Home vengono trovati dopo l’accesso e compaiono insieme. Il Home personale di questo computer resta finché non decidi.',
    defaultServiceFact: 'il servizio di accesso predefinito',
    serviceMethodsHelp: ({ service }) => `Sono mostrati solo i metodi offerti da ${service}. Sei nuovo? Gli stessi pulsanti creano il tuo account.`,

    otherServiceLead: 'Se tu o il tuo team gestite un vostro servizio di accesso, inserisci il suo indirizzo. Happier verifica prima cosa offre.',
    serviceAddressLabel: 'Indirizzo del servizio di accesso',
    serviceFound: 'Trovato',
    useThisService: ({ service }) => `Accedi con ${service}`,
    addressIsNotAService: 'Questo indirizzo non offre l’accesso con account. Se è un Home, collegati direttamente.',
    connectAsHome: 'Collegati come Home',
    backToService: ({ service }) => `Torna a ${service}`,

    directLead: 'Per un Home che gestisci tu, con o senza servizio di account. Non serve un account Happier.',
    fromDeviceLabel: 'Da un dispositivo già collegato',
    fromDeviceHelp: 'Su quel dispositivo apri Impostazioni → Aggiungi il tuo telefono, poi scansiona il codice con la fotocamera di questo computer o incolla il link del Home.',
    homeLinkLabel: 'Link del Home',
    homeLinkPlaceholder: 'Incolla un link di Home',
    useCamera: 'Usa la fotocamera',
    openLink: 'Apri',
    byAddressLabel: 'Tramite indirizzo',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Collega',
    byAddressHelp: 'Happier verifica che il Home risponda, poi accedi con i metodi di quel Home.',
    notAHomeLink: 'Questo non è un link di Home. Copialo di nuovo dall’altro dispositivo.',
    homeUnreachable: 'Happier non ha raggiunto nessun Home a quell’indirizzo. Controlla l’indirizzo e che il Home sia in esecuzione.',

    anotherWay: 'Un altro modo',
    homeReachable: 'Raggiungibile',
    connected: 'Collegato',
    signInToHomeTitle: 'Accedi a questo Home',
    signInToHomeLead: 'Questi sono i modi offerti da questo Home.',

    reconcileTitle: 'I tuoi Home sono collegati',
    reconcileLead: ({ count }) => count === 1
        ? 'Ora questo computer ha due Home. Compaiono insieme in Tutte le Home.'
        : `Ora questo computer ha ${count + 1} Home. Compaiono insieme in Tutte le Home.`,
    reconcileFound: 'Trovati',
    reconcileThisComputer: 'Questo computer',
    runSessionsIn: 'Esegui le sessioni di questo computer in',
    runSessionsInDescription: 'Le nuove sessioni avviate qui vengono salvate in questo Home.',
    removeEmptyPersonalHome: 'Rimuovi il Home personale vuoto',
    removeEmptyPersonalHomeDescription: 'È stato creato quando hai installato Happier e non contiene ancora nulla: né sessioni, né persone, né team, né inviti.',
    changeLater: 'Puoi cambiarlo più tardi in Impostazioni → Home.',
    keepBoth: 'Tienili entrambi',
    useHome: ({ home }) => `Usa ${home}`,
    reconcileSetupTitle: 'Scegli dove vanno le sessioni di questo computer',
    reconcileSetupSubtitle: ({ home }) => `Hai collegato ${home}. Tieni entrambi gli Home oppure esegui lì le sessioni di questo computer.`,
    reconcileSetupAction: 'Scegli…',

    serviceAsHomeTitle: ({ service }) => `Usa ${service} come tuo Home`,
    serviceAsHomeLead: ({ service }) => `Le tue sessioni e impostazioni restano su ${service} invece che su questo computer.`,
    factAlwaysOn: 'Sempre attivo',
    factAlwaysOnDetail: 'Il tuo telefono raggiunge le sessioni mentre questo computer è in stop.',
    factAgents: 'Questo computer continua a eseguire i tuoi agenti',
    factAgentsDetail: 'Non cambia nulla su dove viene eseguito il codice.',
    storageE2ee: 'Crittografia end-to-end',
    storageE2eeDetail: ({ service }) => `${service} conserva le tue sessioni ma non può leggerle.`,
    storagePlain: ({ service }) => `Conservate da ${service}`,
    storagePlainDetail: 'Senza crittografia end-to-end: il servizio può leggere ciò che conserva.',
    storageE2eeByDefault: 'Crittografia end-to-end predefinita',
    storagePlainByDefault: ({ service }) => `Conservate da ${service}, leggibili per impostazione predefinita`,
    storageChoiceDetail: 'Lo scegli quando crei il tuo account.',
    removeEmptyOfferedDetail: 'Non contiene ancora nulla. Proposto solo perché è vuoto.',
    signInOrCreate: ({ account }) => `Accedi o crea il tuo ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Usi già ${service} come Home? L’accesso lo collega direttamente.`,

    addHomeTitle: 'Aggiungi un Home',
    addHomeDescription: 'Un Home conserva le tue sessioni e impostazioni. Collegane uno che usi già o avviane uno nuovo altrove.',
    addSignIn: ({ account }) => `Accedi con il tuo ${account}`,
    addSignInSubtitle: 'Trova gli Home che usi già e collegali.',
    addServiceAsHomeSubtitle: 'Ospitato per te e sempre attivo.',
    addLinkOrQr: 'Collegati con un link o un codice QR',
    addLinkOrQrSubtitle: 'Non serve un account. Ottienilo da un dispositivo già collegato.',
    addServerHome: 'Configura un Home su un server',
    addServerHomeSubtitle: 'Una macchina di sviluppo o una VPS che controlli, configurata via SSH.',
    haveHomeAddress: 'Hai l’indirizzo di un Home?',
    enterIt: 'Inseriscilo',

    livesOnThisComputer: 'Si trova su questo computer',
    availableWhileAwake: 'disponibile finché è attivo',
    gettingReady: 'in preparazione',
    noComputerYet: 'Non hai ancora un computer?',
    aboutYourHome: 'Informazioni sul tuo Home',

    nudgeTitle: ({ count }) => `Home non raggiungibile ${count} volte questa settimana — spostarlo?`,
    nudgeBody: 'Se questo Home funziona su un computer che va in stop, spostarlo su un server sempre acceso può aiutare.',
    nudgeDismiss: 'Nascondi per sempre su questo dispositivo',
    moveHome: 'Sposta Home…',
    useService: ({ service }) => `Usa ${service}`,
};

const pt: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Os teus Homes estão aqui",
        reconcileLead: "Este telefone acompanha agora todos os teus Homes.",
        showMySessions: "Mostrar as minhas sessões",
        scanComputerCode: "Lê o código no teu computador",
        serviceLead: "Os teus Homes são encontrados após iniciares sessão. Este telefone acompanha-os todos.",
        serviceAsHomeLead: ({ service }) => `As tuas sessões estão em ${service}, sempre acessíveis. Adiciona um computador para executar agentes quando quiseres.`,
        factAlwaysOnDetail: "Acede às tuas sessões a qualquer momento.",
        factAgents: "Os teus computadores executam os agentes",
        factAgentsDetail: "Adiciona um mais tarde com um código QR.",
        fromDeviceHelp: "Nesse dispositivo, abre Definições → Adicionar o teu telefone e lê o código com a câmara deste telefone ou cola o link do Home.",
        scan: "Ler código",
    },
    happierAccount: 'conta Happier',
    serviceAccount: ({ service }) => `conta ${service}`,

    alreadyUseTitle: 'Já usa o Happier?',
    alreadyUseDescription: 'Encontre os seus Homes com a sua conta ou ligue-se diretamente a um Home que gere. Nada muda neste computador até escolher.',
    signIn: 'Iniciar sessão',
    withService: ({ service }) => `com ${service}`,
    changeServiceLabel: ({ service }) => `Serviço de início de sessão: ${service}. Alterar`,
    connectToHome: 'Ligar a um Home…',
    hostedPrompt: 'Prefere que fique alojado?',
    useServiceAsAHome: ({ service }) => `Usar ${service} como Home`,
    dismiss: 'Ocultar',

    pathServiceTitle: ({ service }) => `Iniciar sessão com ${service}`,
    pathServiceSubtitle: 'Encontre os Homes ligados à sua conta',
    pathOtherServiceTitle: 'Iniciar sessão com outro serviço',
    pathOtherServiceSubtitle: 'O seu próprio início de sessão ou o da sua empresa',
    pathDirectTitle: 'Ligar diretamente a um Home',
    pathDirectSubtitle: 'Uma ligação ou um endereço · sem conta',

    serviceLead: 'Os seus Homes são encontrados depois de iniciar sessão e aparecem juntos. O Home pessoal deste computador mantém-se até decidir.',
    defaultServiceFact: 'o serviço de início de sessão predefinido',
    serviceMethodsHelp: ({ service }) => `Só são mostrados os métodos que ${service} oferece. É novo? Os mesmos botões criam a sua conta.`,

    otherServiceLead: 'Se você ou a sua equipa gerem o vosso próprio serviço de início de sessão, introduza o endereço. O Happier verifica primeiro o que oferece.',
    serviceAddressLabel: 'Endereço do serviço de início de sessão',
    serviceFound: 'Encontrado',
    useThisService: ({ service }) => `Iniciar sessão com ${service}`,
    addressIsNotAService: 'Este endereço não oferece início de sessão com conta. Se for um Home, ligue-se diretamente a ele.',
    connectAsHome: 'Ligar como Home',
    backToService: ({ service }) => `Voltar a ${service}`,

    directLead: 'Para um Home que gere por si, com ou sem serviço de contas. Não precisa de conta Happier.',
    fromDeviceLabel: 'A partir de um dispositivo já ligado',
    fromDeviceHelp: 'Nesse dispositivo, abra Definições → Adicionar o seu telemóvel e leia o código com a câmara deste computador ou cole a ligação do Home.',
    homeLinkLabel: 'Ligação do Home',
    homeLinkPlaceholder: 'Cole uma ligação de Home',
    useCamera: 'Usar a câmara',
    openLink: 'Abrir',
    byAddressLabel: 'Por endereço',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Ligar',
    byAddressHelp: 'O Happier verifica se o Home responde e depois inicia sessão com os métodos desse Home.',
    notAHomeLink: 'Isto não é uma ligação de Home. Copie-a novamente do outro dispositivo.',
    homeUnreachable: 'O Happier não conseguiu chegar a nenhum Home nesse endereço. Verifique o endereço e se o Home está em funcionamento.',

    anotherWay: 'Outra forma',
    homeReachable: 'Acessível',
    connected: 'Ligado',
    signInToHomeTitle: 'Iniciar sessão neste Home',
    signInToHomeLead: 'Estas são as formas que este Home oferece.',

    reconcileTitle: 'Os seus Homes estão ligados',
    reconcileLead: ({ count }) => count === 1
        ? 'Este computador tem agora dois Homes. Aparecem juntos em Todos os Homes.'
        : `Este computador tem agora ${count + 1} Homes. Aparecem juntos em Todos os Homes.`,
    reconcileFound: 'Encontrados',
    reconcileThisComputer: 'Este computador',
    runSessionsIn: 'Executar as sessões deste computador em',
    runSessionsInDescription: 'As novas sessões iniciadas aqui são guardadas neste Home.',
    removeEmptyPersonalHome: 'Remover o Home pessoal vazio',
    removeEmptyPersonalHomeDescription: 'Foi criado quando instalou o Happier e ainda não contém nada: nem sessões, nem pessoas, nem equipas, nem convites.',
    changeLater: 'Pode alterar isto mais tarde em Definições → Homes.',
    keepBoth: 'Manter ambos',
    useHome: ({ home }) => `Usar ${home}`,
    reconcileSetupTitle: 'Escolha para onde vão as sessões deste computador',
    reconcileSetupSubtitle: ({ home }) => `Ligou ${home}. Mantenha ambos os Homes ou execute lá as sessões deste computador.`,
    reconcileSetupAction: 'Escolher…',

    serviceAsHomeTitle: ({ service }) => `Usar ${service} como o seu Home`,
    serviceAsHomeLead: ({ service }) => `As suas sessões e definições ficam em ${service} em vez de neste computador.`,
    factAlwaysOn: 'Sempre disponível',
    factAlwaysOnDetail: 'O seu telemóvel chega às sessões enquanto este computador está em repouso.',
    factAgents: 'Este computador continua a executar os seus agentes',
    factAgentsDetail: 'Nada muda quanto ao sítio onde o código é executado.',
    storageE2ee: 'Encriptação ponto a ponto',
    storageE2eeDetail: ({ service }) => `${service} guarda as suas sessões, mas não as consegue ler.`,
    storagePlain: ({ service }) => `Guardado por ${service}`,
    storagePlainDetail: 'Sem encriptação ponto a ponto: o serviço pode ler o que guarda.',
    storageE2eeByDefault: 'Encriptação ponto a ponto por predefinição',
    storagePlainByDefault: ({ service }) => `Guardado por ${service}, legível por predefinição`,
    storageChoiceDetail: 'Escolhe ao criar a sua conta.',
    removeEmptyOfferedDetail: 'Ainda não contém nada. Só é proposto porque está vazio.',
    signInOrCreate: ({ account }) => `Inicie sessão ou crie a sua ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Já usa ${service} como Home? Ao iniciar sessão, fica ligado diretamente.`,

    addHomeTitle: 'Adicionar um Home',
    addHomeDescription: 'Um Home guarda as suas sessões e definições. Ligue um que já use ou comece um novo noutro sítio.',
    addSignIn: ({ account }) => `Iniciar sessão com a sua ${account}`,
    addSignInSubtitle: 'Encontre os Homes que já usa e ligue-os.',
    addServiceAsHomeSubtitle: 'Alojado para si e sempre disponível.',
    addLinkOrQr: 'Ligar com uma ligação ou código QR',
    addLinkOrQrSubtitle: 'Não precisa de conta. Obtenha-a num dispositivo já ligado.',
    addServerHome: 'Configurar um Home num servidor',
    addServerHomeSubtitle: 'Uma máquina de desenvolvimento ou VPS que controla, configurada por SSH.',
    haveHomeAddress: 'Tem o endereço de um Home?',
    enterIt: 'Introduza-o',

    livesOnThisComputer: 'Está neste computador',
    availableWhileAwake: 'disponível enquanto estiver ativo',
    gettingReady: 'a preparar-se',
    noComputerYet: 'Ainda não tem computador?',
    aboutYourHome: 'Sobre o seu Home',

    nudgeTitle: ({ count }) => `Home inacessível ${count} vezes esta semana — mover o Home?`,
    nudgeBody: 'Se este Home funciona num computador que entra em repouso, movê-lo para um servidor sempre ligado pode ajudar.',
    nudgeDismiss: 'Ocultar para sempre neste dispositivo',
    moveHome: 'Mover o Home…',
    useService: ({ service }) => `Usar ${service}`,
};

const ja: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Home が見つかりました",
        reconcileLead: "このスマートフォンですべての Home をまとめて確認できます。",
        showMySessions: "セッションを表示",
        scanComputerCode: "コンピューターのコードをスキャン",
        serviceLead: "サインインすると Home が見つかり、このスマートフォンですべてを確認できます。",
        serviceAsHomeLead: ({ service }) => `セッションは ${service} に保存され、いつでもアクセスできます。準備ができたらエージェントを実行するコンピューターを追加してください。`,
        factAlwaysOnDetail: "いつでもセッションにアクセスできます。",
        factAgents: "コンピューターがエージェントを実行します",
        factAgentsDetail: "後で QR コードを使って追加できます。",
        fromDeviceHelp: "接続済みの端末で「設定 → スマートフォンを追加」を開き、このスマートフォンのカメラでコードをスキャンするか、Home リンクを貼り付けてください。",
        scan: "スキャン",
    },
    happierAccount: 'Happier アカウント',
    serviceAccount: ({ service }) => `${service} アカウント`,

    alreadyUseTitle: 'すでに Happier を使っていますか？',
    alreadyUseDescription: 'アカウントで Home を見つけるか、自分で運用している Home に直接接続します。選ぶまで、このコンピューターでは何も変わりません。',
    signIn: 'サインイン',
    withService: ({ service }) => `${service} で`,
    changeServiceLabel: ({ service }) => `サインインサービス: ${service}。変更`,
    connectToHome: 'Home に接続…',
    hostedPrompt: 'ホスト型のほうがいいですか？',
    useServiceAsAHome: ({ service }) => `${service} を Home として使う`,
    dismiss: '非表示',

    pathServiceTitle: ({ service }) => `${service} でサインイン`,
    pathServiceSubtitle: 'アカウントにリンクされた Home を見つける',
    pathOtherServiceTitle: '別のサービスでサインイン',
    pathOtherServiceSubtitle: '自分または会社のサインイン',
    pathDirectTitle: 'Home に直接接続',
    pathDirectSubtitle: 'リンクまたはアドレス · アカウント不要',

    serviceLead: 'サインインすると Home が見つかり、まとめて表示されます。このコンピューターのパーソナル Home は、決めるまでそのまま残ります。',
    defaultServiceFact: '既定のサインインサービス',
    serviceMethodsHelp: ({ service }) => `${service} が提供する方法だけが表示されます。はじめてですか？同じボタンでアカウントを作成できます。`,

    otherServiceLead: '自分やチームで独自のサインインサービスを運用している場合は、そのアドレスを入力してください。Happier はまず何が提供されているかを確認します。',
    serviceAddressLabel: 'サインインサービスのアドレス',
    serviceFound: '見つかりました',
    useThisService: ({ service }) => `${service} でサインイン`,
    addressIsNotAService: 'このアドレスはアカウントのサインインを提供していません。Home であれば、直接接続してください。',
    connectAsHome: 'Home として接続',
    backToService: ({ service }) => `${service} に戻る`,

    directLead: '自分で運用している Home 向けです。アカウントサービスの有無は問いません。Happier アカウントは不要です。',
    fromDeviceLabel: 'すでに接続済みのデバイスから',
    fromDeviceHelp: 'そのデバイスで「設定 → スマートフォンを追加」を開き、このコンピューターのカメラでコードをスキャンするか、Home リンクを貼り付けます。',
    homeLinkLabel: 'Home リンク',
    homeLinkPlaceholder: 'Home リンクを貼り付け',
    useCamera: 'カメラを使う',
    openLink: '開く',
    byAddressLabel: 'アドレスで',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: '接続',
    byAddressHelp: 'Happier が Home の応答を確認したあと、その Home 独自の方法でサインインします。',
    notAHomeLink: 'これは Home リンクではありません。もう一方のデバイスからもう一度コピーしてください。',
    homeUnreachable: 'このアドレスで Home に接続できませんでした。アドレスと、Home が実行中かどうかを確認してください。',

    anotherWay: '別の方法',
    homeReachable: '接続可能',
    connected: '接続済み',
    signInToHomeTitle: 'この Home にサインイン',
    signInToHomeLead: 'この Home が提供する方法です。',

    reconcileTitle: 'Home が接続されました',
    reconcileLead: ({ count }) => `このコンピューターの Home は ${count + 1} 件になりました。「すべての Home」にまとめて表示されます。`,
    reconcileFound: '見つかった Home',
    reconcileThisComputer: 'このコンピューター',
    runSessionsIn: 'このコンピューターのセッションの実行先',
    runSessionsInDescription: 'ここで開始した新しいセッションはこの Home に保存されます。',
    removeEmptyPersonalHome: '空のパーソナル Home を削除',
    removeEmptyPersonalHomeDescription: 'Happier のインストール時に作成されたもので、まだ何も含まれていません（セッション、メンバー、チーム、招待のいずれもありません）。',
    changeLater: 'あとで「設定 → Home」で変更できます。',
    keepBoth: '両方残す',
    useHome: ({ home }) => `${home} を使う`,
    reconcileSetupTitle: 'このコンピューターのセッションの行き先を選ぶ',
    reconcileSetupSubtitle: ({ home }) => `${home} を接続しました。両方の Home を残すか、このコンピューターのセッションをそちらで実行します。`,
    reconcileSetupAction: '選択…',

    serviceAsHomeTitle: ({ service }) => `${service} を自分の Home として使う`,
    serviceAsHomeLead: ({ service }) => `セッションと設定は、このコンピューターではなく ${service} に保存されます。`,
    factAlwaysOn: '常時オン',
    factAlwaysOnDetail: 'このコンピューターがスリープ中でも、スマートフォンからセッションに届きます。',
    factAgents: 'エージェントは引き続きこのコンピューターで実行されます',
    factAgentsDetail: 'コードを実行する場所は変わりません。',
    storageE2ee: 'エンドツーエンド暗号化',
    storageE2eeDetail: ({ service }) => `${service} はセッションを保存しますが、読むことはできません。`,
    storagePlain: ({ service }) => `${service} が保存`,
    storagePlainDetail: 'エンドツーエンド暗号化されていません。サービスは保存内容を読めます。',
    storageE2eeByDefault: '既定でエンドツーエンド暗号化',
    storagePlainByDefault: ({ service }) => `${service} が保存（既定で読み取り可能）`,
    storageChoiceDetail: 'アカウント作成時に選べます。',
    removeEmptyOfferedDetail: 'まだ何も含まれていません。空のときだけ表示されます。',
    signInOrCreate: ({ account }) => `${account}にサインインまたは作成`,
    alreadyUseServiceAsHome: ({ service }) => `すでに ${service} を Home として使っていますか？サインインすると直接接続されます。`,

    addHomeTitle: 'Home を追加',
    addHomeDescription: 'Home にはセッションと設定が保存されます。使っている Home を接続するか、新しい場所で始めましょう。',
    addSignIn: ({ account }) => `${account}でサインイン`,
    addSignInSubtitle: '使っている Home を見つけて接続します。',
    addServiceAsHomeSubtitle: 'ホスト型で常時オン。',
    addLinkOrQr: 'リンクまたは QR コードで接続',
    addLinkOrQrSubtitle: 'アカウント不要。接続済みのデバイスから取得します。',
    addServerHome: 'サーバーに Home をセットアップ',
    addServerHomeSubtitle: '自分で管理する開発マシンや VPS に SSH でセットアップします。',
    haveHomeAddress: 'Home のアドレスをお持ちですか？',
    enterIt: '入力する',

    livesOnThisComputer: 'このコンピューター上にあります',
    availableWhileAwake: 'スリープしていない間は利用可能',
    gettingReady: '準備中',
    noComputerYet: 'まだコンピューターがありませんか？',
    aboutYourHome: 'Home について',

    nudgeTitle: ({ count }) => `今週 Home に ${count} 回接続できませんでした — Home を移動しますか？`,
    nudgeBody: 'この Home がスリープするコンピューターで動作している場合、常時稼働するホストへの移動が役立つことがあります。',
    nudgeDismiss: 'このデバイスでは今後表示しない',
    moveHome: 'Home を移動…',
    useService: ({ service }) => `${service} を使う`,
};

const pl: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Twoje Homes są tutaj",
        reconcileLead: "Ten telefon śledzi teraz wszystkie Twoje Homes.",
        showMySessions: "Pokaż moje sesje",
        scanComputerCode: "Zeskanuj kod na swoim komputerze",
        serviceLead: "Twoje Homes zostaną znalezione po zalogowaniu. Ten telefon będzie je wszystkie śledzić.",
        serviceAsHomeLead: ({ service }) => `Twoje sesje są na ${service}, zawsze dostępne. Dodaj komputer do uruchamiania agentów, gdy będziesz gotowy.`,
        factAlwaysOnDetail: "Korzystaj z sesji w dowolnej chwili.",
        factAgents: "Twoje komputery uruchamiają agentów",
        factAgentsDetail: "Dodaj komputer później za pomocą kodu QR.",
        fromDeviceHelp: "Otwórz na nim Ustawienia → Dodaj telefon, a następnie zeskanuj kod aparatem tego telefonu lub wklej link Home.",
        scan: "Skanuj",
    },
    happierAccount: 'konto Happier',
    serviceAccount: ({ service }) => `konto ${service}`,

    alreadyUseTitle: 'Już używasz Happier?',
    alreadyUseDescription: 'Znajdź swoje Home za pomocą konta albo połącz się bezpośrednio z Home, który prowadzisz. Na tym komputerze nic się nie zmieni, dopóki nie wybierzesz.',
    signIn: 'Zaloguj się',
    withService: ({ service }) => `przez ${service}`,
    changeServiceLabel: ({ service }) => `Usługa logowania: ${service}. Zmień`,
    connectToHome: 'Połącz z Home…',
    hostedPrompt: 'Wolisz hostowane Home?',
    useServiceAsAHome: ({ service }) => `Użyj ${service} jako Home`,
    dismiss: 'Ukryj',

    pathServiceTitle: ({ service }) => `Zaloguj się przez ${service}`,
    pathServiceSubtitle: 'Znajdź Home powiązane z Twoim kontem',
    pathOtherServiceTitle: 'Zaloguj się przez inną usługę',
    pathOtherServiceSubtitle: 'Własne logowanie lub logowanie Twojej firmy',
    pathDirectTitle: 'Połącz się bezpośrednio z Home',
    pathDirectSubtitle: 'Link lub adres · bez konta',

    serviceLead: 'Po zalogowaniu Twoje Home zostaną odnalezione i pokazane razem. Osobisty Home tego komputera zostaje, dopóki nie zdecydujesz.',
    defaultServiceFact: 'domyślna usługa logowania',
    serviceMethodsHelp: ({ service }) => `Widoczne są tylko metody oferowane przez ${service}. Jesteś tu nowy? Te same przyciski utworzą Twoje konto.`,

    otherServiceLead: 'Jeśli Ty lub Twój zespół prowadzicie własną usługę logowania, wpisz jej adres. Happier najpierw sprawdzi, co oferuje.',
    serviceAddressLabel: 'Adres usługi logowania',
    serviceFound: 'Znaleziono',
    useThisService: ({ service }) => `Zaloguj się przez ${service}`,
    addressIsNotAService: 'Ten adres nie oferuje logowania na konto. Jeśli to Home, połącz się z nim bezpośrednio.',
    connectAsHome: 'Połącz jako Home',
    backToService: ({ service }) => `Wróć do ${service}`,

    directLead: 'Dla Home, który prowadzisz samodzielnie, z usługą kont lub bez niej. Konto Happier nie jest potrzebne.',
    fromDeviceLabel: 'Z urządzenia, które jest już połączone',
    fromDeviceHelp: 'Otwórz na nim Ustawienia → Dodaj telefon, a następnie zeskanuj kod kamerą tego komputera albo wklej link do Home.',
    homeLinkLabel: 'Link do Home',
    homeLinkPlaceholder: 'Wklej link do Home',
    useCamera: 'Użyj kamery',
    openLink: 'Otwórz',
    byAddressLabel: 'Według adresu',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Połącz',
    byAddressHelp: 'Happier sprawdza, czy Home odpowiada, a potem logujesz się metodami tego Home.',
    notAHomeLink: 'To nie jest link do Home. Skopiuj go ponownie z drugiego urządzenia.',
    homeUnreachable: 'Happier nie połączył się z żadnym Home pod tym adresem. Sprawdź adres i czy Home działa.',

    anotherWay: 'Inny sposób',
    homeReachable: 'Osiągalny',
    connected: 'Połączono',
    signInToHomeTitle: 'Zaloguj się do tego Home',
    signInToHomeLead: 'Oto sposoby, które oferuje ten Home.',

    reconcileTitle: 'Twoje Home są połączone',
    reconcileLead: ({ count }) => count === 1
        ? 'Ten komputer ma teraz dwa Home. Są wyświetlane razem w widoku Wszystkie Home.'
        : `Ten komputer ma teraz ${count + 1} Home. Są wyświetlane razem w widoku Wszystkie Home.`,
    reconcileFound: 'Znalezione',
    reconcileThisComputer: 'Ten komputer',
    runSessionsIn: 'Uruchamiaj sesje tego komputera w',
    runSessionsInDescription: 'Nowe sesje rozpoczęte tutaj są zapisywane w tym Home.',
    removeEmptyPersonalHome: 'Usuń pusty osobisty Home',
    removeEmptyPersonalHomeDescription: 'Został utworzony podczas instalacji Happier i nie zawiera jeszcze niczego — żadnych sesji, osób, zespołów ani zaproszeń.',
    changeLater: 'Możesz to później zmienić w Ustawienia → Home.',
    keepBoth: 'Zachowaj oba',
    useHome: ({ home }) => `Użyj ${home}`,
    reconcileSetupTitle: 'Wybierz, dokąd trafiają sesje tego komputera',
    reconcileSetupSubtitle: ({ home }) => `Połączono ${home}. Zachowaj oba Home albo uruchamiaj tam sesje tego komputera.`,
    reconcileSetupAction: 'Wybierz…',

    serviceAsHomeTitle: ({ service }) => `Użyj ${service} jako swojego Home`,
    serviceAsHomeLead: ({ service }) => `Twoje sesje i ustawienia są przechowywane w ${service}, a nie na tym komputerze.`,
    factAlwaysOn: 'Zawsze dostępny',
    factAlwaysOnDetail: 'Telefon ma dostęp do sesji, gdy ten komputer śpi.',
    factAgents: 'Ten komputer nadal uruchamia Twoich agentów',
    factAgentsDetail: 'Miejsce uruchamiania kodu się nie zmienia.',
    storageE2ee: 'Szyfrowanie end-to-end',
    storageE2eeDetail: ({ service }) => `${service} przechowuje Twoje sesje, ale nie może ich odczytać.`,
    storagePlain: ({ service }) => `Przechowywane przez ${service}`,
    storagePlainDetail: 'Bez szyfrowania end-to-end: usługa może odczytać to, co przechowuje.',
    storageE2eeByDefault: 'Domyślnie szyfrowanie end-to-end',
    storagePlainByDefault: ({ service }) => `Przechowywane przez ${service}, domyślnie czytelne`,
    storageChoiceDetail: 'Wybierasz przy tworzeniu konta.',
    removeEmptyOfferedDetail: 'Nie zawiera jeszcze niczego. Proponowane tylko dlatego, że jest pusty.',
    signInOrCreate: ({ account }) => `Zaloguj się lub utwórz ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Już używasz ${service} jako Home? Zalogowanie połączy go bezpośrednio.`,

    addHomeTitle: 'Dodaj Home',
    addHomeDescription: 'Home przechowuje Twoje sesje i ustawienia. Połącz taki, którego już używasz, albo załóż nowy w innym miejscu.',
    addSignIn: ({ account }) => `Zaloguj się na ${account}`,
    addSignInSubtitle: 'Znajdź Home, których już używasz, i połącz je.',
    addServiceAsHomeSubtitle: 'Hostowany dla Ciebie i zawsze dostępny.',
    addLinkOrQr: 'Połącz linkiem lub kodem QR',
    addLinkOrQrSubtitle: 'Konto nie jest potrzebne. Pobierz go z urządzenia, które jest już połączone.',
    addServerHome: 'Skonfiguruj Home na serwerze',
    addServerHomeSubtitle: 'Maszyna deweloperska lub VPS pod Twoją kontrolą, skonfigurowane przez SSH.',
    haveHomeAddress: 'Masz adres Home?',
    enterIt: 'Wpisz go',

    livesOnThisComputer: 'Znajduje się na tym komputerze',
    availableWhileAwake: 'dostępny, gdy nie śpi',
    gettingReady: 'przygotowuje się',
    noComputerYet: 'Nie masz jeszcze komputera?',
    aboutYourHome: 'O Twoim Home',

    nudgeTitle: ({ count }) => `Home nieosiągalny ${count} ${count === 1 ? 'raz' : 'razy'} w tym tygodniu — przenieść Home?`,
    nudgeBody: 'Jeśli ten Home działa na komputerze, który przechodzi w stan uśpienia, przeniesienie go na stale włączony serwer może pomóc.',
    nudgeDismiss: 'Ukryj na zawsze na tym urządzeniu',
    moveHome: 'Przenieś Home…',
    useService: ({ service }) => `Użyj ${service}`,
};

function ruTimes(count: number): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'раза';
    return 'раз';
}

const ru: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Ваши Home найдены",
        reconcileLead: "Теперь этот телефон показывает все ваши Home вместе.",
        showMySessions: "Показать мои сессии",
        scanComputerCode: "Сканировать код на компьютере",
        serviceLead: "После входа будут найдены ваши Home. Этот телефон покажет их все.",
        serviceAsHomeLead: ({ service }) => `Ваши сессии хранятся в ${service} и всегда доступны. Добавьте компьютер для запуска агентов, когда будете готовы.`,
        factAlwaysOnDetail: "Доступ к сессиям в любое время.",
        factAgents: "Ваши компьютеры запускают агентов",
        factAgentsDetail: "Добавьте компьютер позже с помощью QR-кода.",
        fromDeviceHelp: "На подключённом устройстве откройте Настройки → Добавить телефон, затем сканируйте код камерой этого телефона или вставьте ссылку Home.",
        scan: "Сканировать",
    },
    happierAccount: 'аккаунт Happier',
    serviceAccount: ({ service }) => `аккаунт ${service}`,

    alreadyUseTitle: 'Уже пользуетесь Happier?',
    alreadyUseDescription: 'Найдите свои Home через аккаунт или подключитесь напрямую к Home, которым управляете сами. На этом компьютере ничего не изменится, пока вы не выберете.',
    signIn: 'Войти',
    withService: ({ service }) => `через ${service}`,
    changeServiceLabel: ({ service }) => `Сервис входа: ${service}. Изменить`,
    connectToHome: 'Подключиться к Home…',
    hostedPrompt: 'Предпочитаете хостинг?',
    useServiceAsAHome: ({ service }) => `Использовать ${service} как Home`,
    dismiss: 'Скрыть',

    pathServiceTitle: ({ service }) => `Войти через ${service}`,
    pathServiceSubtitle: 'Найти Home, связанные с вашим аккаунтом',
    pathOtherServiceTitle: 'Войти через другой сервис',
    pathOtherServiceSubtitle: 'Ваш собственный вход или вход вашей компании',
    pathDirectTitle: 'Подключиться к Home напрямую',
    pathDirectSubtitle: 'Ссылка или адрес · без аккаунта',

    serviceLead: 'После входа ваши Home будут найдены и показаны вместе. Личный Home этого компьютера останется, пока вы не решите.',
    defaultServiceFact: 'сервис входа по умолчанию',
    serviceMethodsHelp: ({ service }) => `Показаны только способы, которые предлагает ${service}. Вы здесь впервые? Те же кнопки создадут аккаунт.`,

    otherServiceLead: 'Если у вас или вашей команды есть собственный сервис входа, введите его адрес. Happier сначала проверит, что он предлагает.',
    serviceAddressLabel: 'Адрес сервиса входа',
    serviceFound: 'Найдено',
    useThisService: ({ service }) => `Войти через ${service}`,
    addressIsNotAService: 'Этот адрес не предлагает вход в аккаунт. Если это Home, подключитесь к нему напрямую.',
    connectAsHome: 'Подключиться как к Home',
    backToService: ({ service }) => `Назад к ${service}`,

    directLead: 'Для Home, которым вы управляете сами, с сервисом аккаунтов или без него. Аккаунт Happier не нужен.',
    fromDeviceLabel: 'С уже подключённого устройства',
    fromDeviceHelp: 'Откройте на нём Настройки → Добавить телефон, затем отсканируйте код камерой этого компьютера или вставьте ссылку на Home.',
    homeLinkLabel: 'Ссылка на Home',
    homeLinkPlaceholder: 'Вставьте ссылку на Home',
    useCamera: 'Использовать камеру',
    openLink: 'Открыть',
    byAddressLabel: 'По адресу',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Подключить',
    byAddressHelp: 'Happier проверит, что Home отвечает, после чего вы войдёте способами этого Home.',
    notAHomeLink: 'Это не ссылка на Home. Скопируйте её ещё раз на другом устройстве.',
    homeUnreachable: 'Happier не смог связаться с Home по этому адресу. Проверьте адрес и что Home запущен.',

    anotherWay: 'Другой способ',
    homeReachable: 'Доступен',
    connected: 'Подключено',
    signInToHomeTitle: 'Вход в этот Home',
    signInToHomeLead: 'Способы входа, которые предлагает этот Home.',

    reconcileTitle: 'Ваши Home подключены',
    reconcileLead: ({ count }) => count === 1
        ? 'Теперь у этого компьютера два Home. Они показаны вместе в разделе «Все Home».'
        : `Теперь у этого компьютера ${count + 1} Home. Они показаны вместе в разделе «Все Home».`,
    reconcileFound: 'Найдены',
    reconcileThisComputer: 'Этот компьютер',
    runSessionsIn: 'Запускать сессии этого компьютера в',
    runSessionsInDescription: 'Новые сессии, начатые здесь, сохраняются в этом Home.',
    removeEmptyPersonalHome: 'Удалить пустой личный Home',
    removeEmptyPersonalHomeDescription: 'Он был создан при установке Happier и пока ничего не содержит — ни сессий, ни людей, ни команд, ни приглашений.',
    changeLater: 'Это можно изменить позже в Настройки → Home.',
    keepBoth: 'Оставить оба',
    useHome: ({ home }) => `Использовать ${home}`,
    reconcileSetupTitle: 'Выберите, куда идут сессии этого компьютера',
    reconcileSetupSubtitle: ({ home }) => `Вы подключили ${home}. Оставьте оба Home или запускайте там сессии этого компьютера.`,
    reconcileSetupAction: 'Выбрать…',

    serviceAsHomeTitle: ({ service }) => `Использовать ${service} как ваш Home`,
    serviceAsHomeLead: ({ service }) => `Ваши сессии и настройки хранятся в ${service}, а не на этом компьютере.`,
    factAlwaysOn: 'Всегда доступен',
    factAlwaysOnDetail: 'Телефон видит ваши сессии, пока этот компьютер спит.',
    factAgents: 'Этот компьютер продолжает запускать ваших агентов',
    factAgentsDetail: 'Место выполнения кода не меняется.',
    storageE2ee: 'Сквозное шифрование',
    storageE2eeDetail: ({ service }) => `${service} хранит ваши сессии, но не может их прочитать.`,
    storagePlain: ({ service }) => `Хранится в ${service}`,
    storagePlainDetail: 'Без сквозного шифрования: сервис может читать то, что хранит.',
    storageE2eeByDefault: 'Сквозное шифрование по умолчанию',
    storagePlainByDefault: ({ service }) => `Хранится в ${service}, по умолчанию доступно для чтения`,
    storageChoiceDetail: 'Вы выбираете при создании аккаунта.',
    removeEmptyOfferedDetail: 'Пока ничего не содержит. Предлагается только потому, что он пуст.',
    signInOrCreate: ({ account }) => `Войдите или создайте ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Уже используете ${service} как Home? После входа он подключится напрямую.`,

    addHomeTitle: 'Добавить Home',
    addHomeDescription: 'Home хранит ваши сессии и настройки. Подключите тот, которым уже пользуетесь, или создайте новый в другом месте.',
    addSignIn: ({ account }) => `Войти в ${account}`,
    addSignInSubtitle: 'Найдите Home, которыми уже пользуетесь, и подключите их.',
    addServiceAsHomeSubtitle: 'Размещается для вас и всегда доступен.',
    addLinkOrQr: 'Подключиться по ссылке или QR-коду',
    addLinkOrQrSubtitle: 'Аккаунт не нужен. Получите её на уже подключённом устройстве.',
    addServerHome: 'Настроить Home на сервере',
    addServerHomeSubtitle: 'Машина для разработки или VPS под вашим управлением, настроенные по SSH.',
    haveHomeAddress: 'Есть адрес Home?',
    enterIt: 'Ввести',

    livesOnThisComputer: 'Находится на этом компьютере',
    availableWhileAwake: 'доступен, пока он не спит',
    gettingReady: 'готовится',
    noComputerYet: 'Ещё нет компьютера?',
    aboutYourHome: 'О вашем Home',

    nudgeTitle: ({ count }) => `Home недоступен ${count} ${ruTimes(count)} на этой неделе — перенести Home?`,
    nudgeBody: 'Если этот Home работает на компьютере, который переходит в спящий режим, перенос на постоянно включённый сервер может помочь.',
    nudgeDismiss: 'Больше не показывать на этом устройстве',
    moveHome: 'Перенести Home…',
    useService: ({ service }) => `Использовать ${service}`,
};

const zhHans: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "你的 Home 都在这里",
        reconcileLead: "这部手机现在可以一起查看你的所有 Home。",
        showMySessions: "显示我的会话",
        scanComputerCode: "扫描电脑上的二维码",
        serviceLead: "登录后即可找到你的 Home。这部手机随后可以查看它们全部。",
        serviceAsHomeLead: ({ service }) => `你的会话保存在 ${service}，随时可访问。准备好后，添加一台电脑来运行智能体。`,
        factAlwaysOnDetail: "随时访问你的会话。",
        factAgents: "你的电脑运行智能体",
        factAgentsDetail: "稍后通过二维码添加电脑。",
        fromDeviceHelp: "在已连接的设备上打开「设置 → 添加手机」，用这部手机的相机扫描二维码，或粘贴 Home 链接。",
        scan: "扫描",
    },
    happierAccount: 'Happier 账户',
    serviceAccount: ({ service }) => `${service} 账户`,

    alreadyUseTitle: '已经在用 Happier？',
    alreadyUseDescription: '用你的账户找到你的 Home，或直接连接到你自己运行的 Home。在你做出选择之前，这台电脑上不会有任何改变。',
    signIn: '登录',
    withService: ({ service }) => `使用 ${service}`,
    changeServiceLabel: ({ service }) => `登录服务：${service}。更改`,
    connectToHome: '连接到 Home…',
    hostedPrompt: '更想要托管的？',
    useServiceAsAHome: ({ service }) => `将 ${service} 用作 Home`,
    dismiss: '隐藏',

    pathServiceTitle: ({ service }) => `使用 ${service} 登录`,
    pathServiceSubtitle: '找到与你的账户关联的 Home',
    pathOtherServiceTitle: '使用其他服务登录',
    pathOtherServiceSubtitle: '你自己或公司的登录服务',
    pathDirectTitle: '直接连接到 Home',
    pathDirectSubtitle: '链接或地址 · 无需账户',

    serviceLead: '登录后会找到你的 Home 并一起显示。在你决定之前，这台电脑的个人 Home 会一直保留。',
    defaultServiceFact: '默认登录服务',
    serviceMethodsHelp: ({ service }) => `只显示 ${service} 提供的方式。第一次使用？同样的按钮会为你创建账户。`,

    otherServiceLead: '如果你或你的团队运行自己的登录服务，请输入它的地址。Happier 会先检查它提供什么。',
    serviceAddressLabel: '登录服务地址',
    serviceFound: '已找到',
    useThisService: ({ service }) => `使用 ${service} 登录`,
    addressIsNotAService: '此地址不提供账户登录。如果它是一个 Home，请直接连接。',
    connectAsHome: '作为 Home 连接',
    backToService: ({ service }) => `返回 ${service}`,

    directLead: '适用于你自己运行的 Home，有没有账户服务都可以。无需 Happier 账户。',
    fromDeviceLabel: '从已连接的设备',
    fromDeviceHelp: '在该设备上打开“设置 → 添加你的手机”，然后用这台电脑的摄像头扫描代码，或粘贴它的 Home 链接。',
    homeLinkLabel: 'Home 链接',
    homeLinkPlaceholder: '粘贴 Home 链接',
    useCamera: '使用摄像头',
    openLink: '打开',
    byAddressLabel: '通过地址',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: '连接',
    byAddressHelp: 'Happier 会检查 Home 是否响应，然后你使用该 Home 自己的方式登录。',
    notAHomeLink: '这不是 Home 链接。请从另一台设备重新复制。',
    homeUnreachable: 'Happier 无法在该地址连接到 Home。请检查地址以及 Home 是否正在运行。',

    anotherWay: '其他方式',
    homeReachable: '可访问',
    connected: '已连接',
    signInToHomeTitle: '登录此 Home',
    signInToHomeLead: '以下是此 Home 提供的方式。',

    reconcileTitle: '你的 Home 已连接',
    reconcileLead: ({ count }) => `这台电脑现在有 ${count + 1} 个 Home，它们会一起显示在“全部 Home”中。`,
    reconcileFound: '已找到',
    reconcileThisComputer: '这台电脑',
    runSessionsIn: '这台电脑的会话运行在',
    runSessionsInDescription: '在这里开始的新会话会保存到此 Home。',
    removeEmptyPersonalHome: '移除空的个人 Home',
    removeEmptyPersonalHomeDescription: '它在你安装 Happier 时创建，目前还没有任何内容——没有会话、成员、团队或邀请。',
    changeLater: '稍后可在“设置 → Home”中更改。',
    keepBoth: '两个都保留',
    useHome: ({ home }) => `使用 ${home}`,
    reconcileSetupTitle: '选择这台电脑的会话去向',
    reconcileSetupSubtitle: ({ home }) => `你已连接 ${home}。保留两个 Home，或在那里运行这台电脑的会话。`,
    reconcileSetupAction: '选择…',

    serviceAsHomeTitle: ({ service }) => `将 ${service} 用作你的 Home`,
    serviceAsHomeLead: ({ service }) => `你的会话和设置保存在 ${service}，而不是这台电脑上。`,
    factAlwaysOn: '始终在线',
    factAlwaysOnDetail: '这台电脑休眠时，你的手机也能访问会话。',
    factAgents: '这台电脑继续运行你的智能体',
    factAgentsDetail: '代码运行的位置不会改变。',
    storageE2ee: '端到端加密',
    storageE2eeDetail: ({ service }) => `${service} 保存你的会话，但无法读取。`,
    storagePlain: ({ service }) => `由 ${service} 保存`,
    storagePlainDetail: '未端到端加密：服务可以读取它保存的内容。',
    storageE2eeByDefault: '默认端到端加密',
    storagePlainByDefault: ({ service }) => `由 ${service} 保存，默认可读`,
    storageChoiceDetail: '创建账户时由你选择。',
    removeEmptyOfferedDetail: '它目前没有任何内容。仅因为它是空的才提供此选项。',
    signInOrCreate: ({ account }) => `登录或创建你的 ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `已经把 ${service} 用作 Home？登录后会直接连接。`,

    addHomeTitle: '添加 Home',
    addHomeDescription: 'Home 保存你的会话和设置。连接一个你已在用的 Home，或在新的地方创建一个。',
    addSignIn: ({ account }) => `使用你的 ${account} 登录`,
    addSignInSubtitle: '找到你已在用的 Home 并连接它们。',
    addServiceAsHomeSubtitle: '为你托管，始终在线。',
    addLinkOrQr: '通过链接或二维码连接',
    addLinkOrQrSubtitle: '无需账户。从已连接的设备获取。',
    addServerHome: '在服务器上设置 Home',
    addServerHomeSubtitle: '你掌控的开发机或 VPS，通过 SSH 设置。',
    haveHomeAddress: '有 Home 地址？',
    enterIt: '输入地址',

    livesOnThisComputer: '位于这台电脑上',
    availableWhileAwake: '唤醒时可用',
    gettingReady: '正在准备',
    noComputerYet: '还没有电脑？',
    aboutYourHome: '关于你的 Home',

    nudgeTitle: ({ count }) => `本周有 ${count} 次无法连接 Home — 移动 Home？`,
    nudgeBody: '如果此 Home 运行在会休眠的电脑上，将其移到始终开机的主机可能会有帮助。',
    nudgeDismiss: '在此设备上不再显示',
    moveHome: '移动 Home…',
    useService: ({ service }) => `使用 ${service}`,
};

const zhHant: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "你的 Home 都在這裡",
        reconcileLead: "這支手機現在可以一起查看你的所有 Home。",
        showMySessions: "顯示我的工作階段",
        scanComputerCode: "掃描電腦上的 QR 碼",
        serviceLead: "登入後即可找到你的 Home。這支手機隨後可以查看它們全部。",
        serviceAsHomeLead: ({ service }) => `你的工作階段儲存在 ${service}，隨時可存取。準備好後，新增一台電腦來執行代理。`,
        factAlwaysOnDetail: "隨時存取你的工作階段。",
        factAgents: "你的電腦執行代理",
        factAgentsDetail: "稍後透過 QR 碼新增電腦。",
        fromDeviceHelp: "在已連線的裝置上開啟「設定 → 新增手機」，用這支手機的相機掃描 QR 碼，或貼上 Home 連結。",
        scan: "掃描",
    },
    happierAccount: 'Happier 帳號',
    serviceAccount: ({ service }) => `${service} 帳號`,

    alreadyUseTitle: '已經在用 Happier？',
    alreadyUseDescription: '用你的帳號找到你的 Home，或直接連線到你自己執行的 Home。在你做出選擇之前，這台電腦上不會有任何變更。',
    signIn: '登入',
    withService: ({ service }) => `使用 ${service}`,
    changeServiceLabel: ({ service }) => `登入服務：${service}。變更`,
    connectToHome: '連線到 Home…',
    hostedPrompt: '比較想要代管的？',
    useServiceAsAHome: ({ service }) => `將 ${service} 用作 Home`,
    dismiss: '隱藏',

    pathServiceTitle: ({ service }) => `使用 ${service} 登入`,
    pathServiceSubtitle: '找到與你的帳號連結的 Home',
    pathOtherServiceTitle: '使用其他服務登入',
    pathOtherServiceSubtitle: '你自己或公司的登入服務',
    pathDirectTitle: '直接連線到 Home',
    pathDirectSubtitle: '連結或位址 · 不需要帳號',

    serviceLead: '登入後會找到你的 Home 並一起顯示。在你決定之前，這台電腦的個人 Home 會一直保留。',
    defaultServiceFact: '預設登入服務',
    serviceMethodsHelp: ({ service }) => `只會顯示 ${service} 提供的方式。第一次使用？同樣的按鈕會為你建立帳號。`,

    otherServiceLead: '如果你或你的團隊執行自己的登入服務，請輸入它的位址。Happier 會先檢查它提供哪些功能。',
    serviceAddressLabel: '登入服務位址',
    serviceFound: '已找到',
    useThisService: ({ service }) => `使用 ${service} 登入`,
    addressIsNotAService: '此位址不提供帳號登入。如果它是 Home，請直接連線。',
    connectAsHome: '以 Home 連線',
    backToService: ({ service }) => `返回 ${service}`,

    directLead: '適用於你自己執行的 Home，有沒有帳號服務都可以。不需要 Happier 帳號。',
    fromDeviceLabel: '從已連線的裝置',
    fromDeviceHelp: '在該裝置上開啟「設定 → 新增你的手機」，再用這台電腦的相機掃描代碼，或貼上它的 Home 連結。',
    homeLinkLabel: 'Home 連結',
    homeLinkPlaceholder: '貼上 Home 連結',
    useCamera: '使用相機',
    openLink: '開啟',
    byAddressLabel: '透過位址',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: '連線',
    byAddressHelp: 'Happier 會檢查 Home 是否回應，接著你用該 Home 自己的方式登入。',
    notAHomeLink: '這不是 Home 連結。請從另一台裝置重新複製。',
    homeUnreachable: 'Happier 無法在該位址連上 Home。請檢查位址以及 Home 是否正在執行。',

    anotherWay: '其他方式',
    homeReachable: '可連線',
    connected: '已連線',
    signInToHomeTitle: '登入此 Home',
    signInToHomeLead: '以下是此 Home 提供的方式。',

    reconcileTitle: '你的 Home 已連線',
    reconcileLead: ({ count }) => `這台電腦現在有 ${count + 1} 個 Home，它們會一起顯示在「全部 Home」中。`,
    reconcileFound: '已找到',
    reconcileThisComputer: '這台電腦',
    runSessionsIn: '這台電腦的工作階段執行於',
    runSessionsInDescription: '在這裡開始的新工作階段會儲存到此 Home。',
    removeEmptyPersonalHome: '移除空的個人 Home',
    removeEmptyPersonalHomeDescription: '它在你安裝 Happier 時建立，目前還沒有任何內容——沒有工作階段、成員、團隊或邀請。',
    changeLater: '稍後可在「設定 → Home」中變更。',
    keepBoth: '兩個都保留',
    useHome: ({ home }) => `使用 ${home}`,
    reconcileSetupTitle: '選擇這台電腦的工作階段去向',
    reconcileSetupSubtitle: ({ home }) => `你已連線 ${home}。保留兩個 Home，或在那裡執行這台電腦的工作階段。`,
    reconcileSetupAction: '選擇…',

    serviceAsHomeTitle: ({ service }) => `將 ${service} 用作你的 Home`,
    serviceAsHomeLead: ({ service }) => `你的工作階段和設定儲存在 ${service}，而不是這台電腦上。`,
    factAlwaysOn: '隨時在線',
    factAlwaysOnDetail: '這台電腦休眠時，你的手機也能存取工作階段。',
    factAgents: '這台電腦繼續執行你的代理',
    factAgentsDetail: '程式碼執行的位置不會改變。',
    storageE2ee: '端對端加密',
    storageE2eeDetail: ({ service }) => `${service} 儲存你的工作階段，但無法讀取。`,
    storagePlain: ({ service }) => `由 ${service} 儲存`,
    storagePlainDetail: '未端對端加密：服務可以讀取它儲存的內容。',
    storageE2eeByDefault: '預設端對端加密',
    storagePlainByDefault: ({ service }) => `由 ${service} 儲存，預設可讀取`,
    storageChoiceDetail: '建立帳號時由你選擇。',
    removeEmptyOfferedDetail: '它目前沒有任何內容。只因為它是空的才提供此選項。',
    signInOrCreate: ({ account }) => `登入或建立你的 ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `已經把 ${service} 用作 Home？登入後會直接連線。`,

    addHomeTitle: '新增 Home',
    addHomeDescription: 'Home 會儲存你的工作階段和設定。連線一個你已在用的 Home，或在新的地方建立一個。',
    addSignIn: ({ account }) => `使用你的 ${account} 登入`,
    addSignInSubtitle: '找到你已在用的 Home 並連線。',
    addServiceAsHomeSubtitle: '為你代管，隨時在線。',
    addLinkOrQr: '透過連結或 QR 碼連線',
    addLinkOrQrSubtitle: '不需要帳號。從已連線的裝置取得。',
    addServerHome: '在伺服器上設定 Home',
    addServerHomeSubtitle: '你掌控的開發機或 VPS，透過 SSH 設定。',
    haveHomeAddress: '有 Home 位址？',
    enterIt: '輸入位址',

    livesOnThisComputer: '位於這台電腦上',
    availableWhileAwake: '喚醒時可用',
    gettingReady: '正在準備',
    noComputerYet: '還沒有電腦？',
    aboutYourHome: '關於你的 Home',

    nudgeTitle: ({ count }) => `本週有 ${count} 次無法連線到 Home — 移動 Home？`,
    nudgeBody: '如果此 Home 執行於會休眠的電腦，將它移到持續開機的主機可能有幫助。',
    nudgeDismiss: '在此裝置上不再顯示',
    moveHome: '移動 Home…',
    useService: ({ service }) => `使用 ${service}`,
};

export const homesJourneysTranslations = {
    en,
    ca,
    de,
    es,
    fr,
    it,
    ja,
    pl,
    pt,
    ru,
    'zh-Hans': zhHans,
    'zh-Hant': zhHant,
} satisfies Readonly<Record<string, HomesJourneysTranslation>>;
