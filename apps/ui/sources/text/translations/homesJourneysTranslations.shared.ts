

export type Service = Readonly<{ service: string }>;



export type Home = Readonly<{ home: string }>;



export type HomesJourneysTranslation = Readonly<{
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



export function ruTimes(count: number): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'раза';
    return 'раз';
}



export const en: HomesJourneysTranslation = {
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


export const homesJourneysTranslationsEnglish = { en } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "en">;