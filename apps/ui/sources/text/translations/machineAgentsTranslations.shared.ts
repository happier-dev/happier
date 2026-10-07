

export type MachineAgentsTranslation = Readonly<{
    signedInWith: (params: Readonly<{ label: string }>) => string;
    signedInAs: (params: Readonly<{ label: string }>) => string;
    signedInHere: string;
    updateTo: (params: Readonly<{ version: string }>) => string;
    needsSignIn: string;
    waitingForSignIn: string;
    notInstalled: string;
    downloadSize: (params: Readonly<{ size: string }>) => string;
    installYourself: string;
    unsupportedOs: string;
    unsupportedArch: string;
    installing: string;
    progress: (params: Readonly<{ done: string; total: string }>) => string;
    checking: string;
    offlineSignedIn: string;
    offlineSignedOut: string;
    offlineNotInstalled: string;
    offlineUnknown: string;
    unknown: string;

    actionInstall: string;
    actionUpdate: string;
    actionSignIn: string;
    actionRetry: string;
    actionCancel: string;
    actionShowTerminal: string;
    actionGuide: string;

    installLeadManaged: (params: Readonly<{ agent: string; machine: string }>) => string;
    installLeadVendor: (params: Readonly<{ agent: string; machine: string }>) => string;
    installAlsoDownloads: (params: Readonly<{ what: string }>) => string;
    installThenSignIn: string;
    installAgent: (params: Readonly<{ agent: string }>) => string;
    installMyself: string;
    manualLead: (params: Readonly<{ agent: string; machine: string }>) => string;
    checkAgain: string;
    closeNote: (params: Readonly<{ machine: string }>) => string;
    stepCheck: string;
    stepSignIn: string;
    failedKept: string;
    installedLine: (params: Readonly<{ agent: string; version: string }>) => string;
    nowSignIn: string;
    signInHow: (params: Readonly<{ agent: string }>) => string;
    useService: (params: Readonly<{ service: string }>) => string;
    recommended: string;
    serviceConnected: (params: Readonly<{ profile: string }>) => string;
    serviceNotConnected: string;
    connect: string;
    signInOn: (params: Readonly<{ machine: string }>) => string;
    signInOnDetail: (params: Readonly<{ agent: string }>) => string;
    noNativeLogin: (params: Readonly<{ agent: string }>) => string;
    openSignInTerminal: string;
    useThisAccount: string;
    waitingLead: (params: Readonly<{ agent: string; machine: string }>) => string;
    readyLine: (params: Readonly<{ agent: string; machine: string }>) => string;
    startSessionWith: (params: Readonly<{ agent: string }>) => string;
    setUpAnother: string;
    unsupportedLead: (params: Readonly<{ agent: string; machine: string }>) => string;
    setupTitle: (params: Readonly<{ agent: string }>) => string;
    signInTitle: (params: Readonly<{ agent: string }>) => string;
    readyTitle: (params: Readonly<{ agent: string }>) => string;
    notOnMachineYet: (params: Readonly<{ machine: string }>) => string;
    onMachine: (params: Readonly<{ machine: string }>) => string;
    installingOn: (params: Readonly<{ machine: string }>) => string;
    cantRunOn: (params: Readonly<{ machine: string }>) => string;

    terminalTab: (params: Readonly<{ agent: string }>) => string;
    panelLead: string;
    open: string;
    openSignInPage: string;
    waitingEllipsis: string;
    signedInAlready: string;
    closeTerminal: string;
    showTheTerminal: string;
    phoneLead: (params: Readonly<{ agent: string; machine: string }>) => string;
    panelSignedInAs: (params: Readonly<{ account: string }>) => string;
    panelChecked: string;

    sectionTitle: string;
    sectionDescription: string;
    addTitle: string;
    addMore: (params: Readonly<{ count: number }>) => string;
    showAll: string;
    showFewer: string;
    emptyInstalled: string;
    offlineNote: (params: Readonly<{ machine: string }>) => string;

    firstTitle: string;
    firstLead: (params: Readonly<{ machine: string }>) => string;
    firstMore: (params: Readonly<{ count: number }>) => string;
    allAgents: string;
    setUp: string;
    choiceUsesService: (params: Readonly<{ service: string; profile: string }>) => string;
    choiceSignsInOn: string;
    dismissFirst: string;
    dismissTooltip: string;
    chooseAgent: string;

    blockNotInstalled: (params: Readonly<{ agent: string; machine: string }>) => string;
    blockSetUpToStart: string;
    blockSignedOut: (params: Readonly<{ agent: string; machine: string }>) => string;
    spawnCliMissing: (params: Readonly<{ agent: string; machine: string }>) => string;
    spawnSignedOut: (params: Readonly<{ agent: string; machine: string }>) => string;
    draftKept: string;
    alreadySetUp: (params: Readonly<{ machine: string; home: string }>) => string;
    startSession: string;
    openMachine: (params: Readonly<{ machine: string }>) => string;
}>;



export const en: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `Signed in with ${label}`,
    signedInAs: ({ label }) => `Signed in as ${label}`,
    signedInHere: 'Signed in on this machine',
    updateTo: ({ version }) => `Update to ${version}`,
    needsSignIn: 'Needs sign-in',
    waitingForSignIn: 'Waiting for sign-in in the terminal…',
    notInstalled: 'Not installed',
    downloadSize: ({ size }) => `${size} download`,
    installYourself: 'Install it yourself',
    unsupportedOs: 'Doesn’t run on this system',
    unsupportedArch: 'No build for this processor',
    installing: 'Installing…',
    progress: ({ done, total }) => `${done} of ${total}`,
    checking: 'Checking…',
    offlineSignedIn: 'Last seen signed in · machine offline',
    offlineSignedOut: 'Last seen signed out · machine offline',
    offlineNotInstalled: 'Not installed when last seen · machine offline',
    offlineUnknown: 'Machine offline',
    unknown: 'Couldn’t check this machine',

    actionInstall: 'Install',
    actionUpdate: 'Update',
    actionSignIn: 'Sign in',
    actionRetry: 'Try again',
    actionCancel: 'Cancel',
    actionShowTerminal: 'Show terminal',
    actionGuide: 'Setup guide',

    installLeadManaged: ({ agent, machine }) => `Happier installs ${agent} on ${machine} for Happier only. Your own terminal setup isn’t changed.`,
    installLeadVendor: ({ agent, machine }) => `Happier runs ${agent}’s own installer on ${machine}.`,
    installAlsoDownloads: ({ what }) => `It also downloads ${what} that sessions run.`,
    installThenSignIn: 'Then you sign in.',
    installAgent: ({ agent }) => `Install ${agent}`,
    installMyself: 'I’ll install it myself',
    manualLead: ({ agent, machine }) => `Happier can’t install ${agent} for you. Install it on ${machine} with its setup guide, then check again.`,
    checkAgain: 'Check again',
    closeNote: ({ machine }) => `You can close this; it keeps going on ${machine}.`,
    stepCheck: 'Check that it runs',
    stepSignIn: 'Sign in',
    failedKept: 'Nothing half-installed was kept.',
    installedLine: ({ agent, version }) => `${agent} ${version} is installed`,
    nowSignIn: 'now sign in',
    signInHow: ({ agent }) => `How ${agent} signs in`,
    useService: ({ service }) => `Use your ${service}`,
    recommended: 'Recommended',
    serviceConnected: ({ profile }) => `${profile} · already connected · works on every machine`,
    serviceNotConnected: 'Connect it once; every machine can use it.',
    connect: 'Connect',
    signInOn: ({ machine }) => `Sign in on ${machine}`,
    signInOnDetail: ({ agent }) => `Runs ${agent}’s own sign-in in a terminal there. Only this machine uses it.`,
    noNativeLogin: ({ agent }) => `${agent} has no sign-in of its own: it uses an API key or a connected account. Connect one once and every machine can use it.`,
    openSignInTerminal: 'Open sign-in in terminal',
    useThisAccount: 'Use this account',
    waitingLead: ({ agent, machine }) => `${agent}’s own sign-in is open in the terminal on ${machine}. This turns ready as soon as it reports you’re signed in.`,
    readyLine: ({ agent, machine }) => `${agent} is ready on ${machine}`,
    startSessionWith: ({ agent }) => `Start a session with ${agent}`,
    setUpAnother: 'Set up another agent',
    unsupportedLead: ({ agent, machine }) => `${agent} has no build for ${machine}, so it can’t run there.`,
    setupTitle: ({ agent }) => `Set up ${agent}`,
    signInTitle: ({ agent }) => `Sign in to ${agent}`,
    readyTitle: ({ agent }) => `${agent} is ready`,
    notOnMachineYet: ({ machine }) => `Not on ${machine} yet`,
    onMachine: ({ machine }) => `On ${machine}`,
    installingOn: ({ machine }) => `Installing on ${machine}`,
    cantRunOn: ({ machine }) => `Can’t run on ${machine}`,

    terminalTab: ({ agent }) => `Sign in · ${agent}`,
    panelLead: 'Finish in the browser that opened. On a different device? Open the link from there.',
    open: 'Open',
    openSignInPage: 'Open the sign-in page',
    waitingEllipsis: 'Waiting for sign-in…',
    signedInAlready: 'Signed in already?',
    closeTerminal: 'Close terminal',
    showTheTerminal: 'Show the terminal',
    phoneLead: ({ agent, machine }) => `${agent} is asking you to sign in. Open the page here, finish, and ${machine} picks it up.`,
    panelSignedInAs: ({ account }) => `Signed in as ${account}.`,
    panelChecked: 'Happier checked it a moment ago.',

    sectionTitle: 'Agents',
    sectionDescription: 'The coding agents on this machine and how each one signs in.',
    addTitle: 'Add an agent',
    addMore: ({ count }) => (count === 1 ? '1 more runs here' : `${count} more run here`),
    showAll: 'Show all',
    showFewer: 'Show fewer',
    emptyInstalled: 'No coding agent on this machine yet. Pick one below; Happier installs it and signs you in.',
    offlineNote: ({ machine }) => `${machine} is offline. This is what it last reported.`,

    firstTitle: 'Set up your first agent',
    firstLead: ({ machine }) => `${machine} is connected, but has no coding agent yet. Pick one; Happier installs it and signs you in.`,
    firstMore: ({ count }) => `Or choose from ${count} more agents.`,
    allAgents: 'All agents',
    setUp: 'Set up',
    choiceUsesService: ({ service, profile }) => `Uses your ${service}. Connected: ${profile}.`,
    choiceSignsInOn: 'Signs in on the machine.',
    dismissFirst: 'Hide “Set up your first agent”',
    dismissTooltip: 'Hide · restore from Customize',
    chooseAgent: 'Choose an agent',

    blockNotInstalled: ({ agent, machine }) => `${agent} isn’t on ${machine} yet.`,
    blockSetUpToStart: 'Set it up to start.',
    blockSignedOut: ({ agent, machine }) => `${agent} needs sign-in on ${machine}.`,
    spawnCliMissing: ({ agent, machine }) => `${agent} isn’t installed on ${machine}.`,
    spawnSignedOut: ({ agent, machine }) => `${agent} is signed out on ${machine}.`,
    draftKept: 'Your message is kept.',
    alreadySetUp: ({ machine, home }) => `${machine} is already connected to ${home}`,
    startSession: 'Start a session',
    openMachine: ({ machine }) => `Open ${machine}`,
};


export const machineAgentsTranslationsEnglish = { en } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "en">;