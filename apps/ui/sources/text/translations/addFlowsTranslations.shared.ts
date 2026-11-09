

export type AddFlowsTranslation = Readonly<{
    addHome: string;
    addHomeSubtitle: string;
    addHomeDescription: string;
    newGroup: string;
    newGroupSubtitle: string;
    groupsTitle: string;
    homesInUse: string;
    thisDeviceTitle: string;
    thisDeviceSubtitle: string;
    thisDeviceDescription: string;
    newHomeDraft: string;
    homeMissingTitle: string;
    homeMissingDescription: string;
    homeManageTitle: string;
    homeAdministrationSubtitle: string;
    groupMissingTitle: string;
    groupMissingDescription: string;
    discard: string;
    sshSignInAgent: string;
    sshSignInKeyFile: string;
    sshSignInPassword: string;
    addMachineMenuSubtitle: string;
    addPresetMenuSubtitle: string;
    addPoolMenuSubtitle: string;
    addMachineDescription: string;
    machineJoinsHome: (params: Readonly<{ home: string; }>) => string;
    pathThisComputerTitle: string;
    pathThisComputerTask: string;
    pathThisComputerCommand: string;
    pathSshTitle: string;
    pathSshChip: string;
    pathSshSubtitle: string;
    pathAnotherTitle: string;
    pathAnotherSubtitle: string;
    pathAnotherLead: string;
    machinePoolPrompt: string;
    thisComputerCommandLead: (params: Readonly<{ home: string; }>) => string;
    thisComputerTaskLead: (params: Readonly<{ machine: string; home: string; }>) => string;
    setUpThisComputer: string;
    desktopAppHint: string;
    desktopAppLink: string;
    thisComputerRunningLead: (params: Readonly<{ machine: string; }>) => string;
    onAnotherHomeTitle: (params: Readonly<{ machine: string; }>) => string;
    onAnotherHomeBody: (params: Readonly<{ home: string; }>) => string;
    moveToHome: (params: Readonly<{ home: string; }>) => string;
    keepOnOtherHome: string;
    sshLeadTask: (params: Readonly<{ home: string; }>) => string;
    sshLeadCommand: (params: Readonly<{ home: string; }>) => string;
    setUpHost: (params: Readonly<{ host: string; }>) => string;
    sshSavedNote: string;
    sshRunningTitle: (params: Readonly<{ host: string; }>) => string;
    sshRunningLead: string;
    sshRunningLeadPhone: string;
    sshKeepOpen: (params: Readonly<{ host: string; }>) => string;
    hostKeyTitle: string;
    hostKeyBody: (params: Readonly<{ host: string; }>) => string;
    hostKeyFingerprint: (params: Readonly<{ type: string; }>) => string;
    hostKeyFingerprintPlain: string;
    hostKeyTrust: string;
    hostKeyChangedTitle: (params: Readonly<{ host: string; }>) => string;
    hostKeyChangedBody: string;
    anotherLead: (params: Readonly<{ home: string; }>) => string;
    anotherTerminalAction: string;
    machineWatching: (params: Readonly<{ subject: string; }>) => string;
    subjectThisComputer: string;
    subjectAnotherComputer: string;
    machineNotSeeingTitle: (params: Readonly<{ subject: string; }>) => string;
    machineNotSeeingBody: (params: Readonly<{ home: string; }>) => string;
    machineArrived: (params: Readonly<{ machine: string; }>) => string;
    machineConnectedJustNow: string;
    machineStartSession: (params: Readonly<{ machine: string; }>) => string;
    machineAddAnother: string;
    cancelSetup: string;
    detectedOs: string;
    sshSuggestionsTitle: string;
    connectingToHome: (params: Readonly<{ address: string; }>) => string;
    pathThisComputerConnected: string;
    sshConnectFromTitle: string;
    sshConnectFromSubtitle: string;
    sshConnectFromThisDevice: string;
    sshRunsAsTitle: string;
    sshRunsAsSubtitle: string;
    sshRunsAsSubtitleUser: (params: Readonly<{ user: string; }>) => string;
    sshSeparateUsersTitle: string;
    sshSeparateUsersSubtitle: string;
    sshSeparateUsersOff: string;
    sshConnectAndInstall: string;
    sshRunItYourself: string;
    sshRunItYourselfLead: (params: Readonly<{ home: string; }>) => string;
    sshNeedsAddress: string;
    sshOnServerTitle: string;
}>;


export const addFlowsTranslationsEnglish = { en: {
        addHome: 'Add a Home',
        addHomeSubtitle: 'Sign in, connect by address or have one hosted',
        addHomeDescription: 'Connect a Home you already use, or have one hosted for you.',
        newGroup: 'New Home set',
        newGroupSubtitle: 'See several Homes’ sessions together',
        groupsTitle: 'Home sets',
        homesInUse: 'In use here',
        thisDeviceTitle: 'This device',
        thisDeviceSubtitle: 'How it reaches its Homes',
        thisDeviceDescription: 'How this device reaches its Homes: devices waiting to join, the connection it uses and the Home it runs.',
        newHomeDraft: 'New Home',
        homeMissingTitle: 'This Home isn’t on this device',
        homeMissingDescription: 'It was removed, or it was saved on another device.',
        homeManageTitle: 'Manage',
        homeAdministrationSubtitle: 'People, sign-in, reach and data for this Home',
        groupMissingTitle: 'This group no longer exists',
        groupMissingDescription: 'It was removed. Your Homes are unchanged.',
        discard: 'Discard',
        sshSignInAgent: 'Your SSH agent on this machine',
        sshSignInKeyFile: 'A private key file on this machine',
        sshSignInPassword: 'Used once to connect; never saved',
        addMachineMenuSubtitle: 'A local or remote machine',
        addPresetMenuSubtitle: 'Reusable choices for new machines',
        addPoolMenuSubtitle: 'A preferred machine with fallbacks',
        addMachineDescription: 'Add a machine so agents can run your sessions on it.',
        machineJoinsHome: ({ home }) => `Joins ${home}`,
        pathThisComputerTitle: 'This machine',
        pathThisComputerTask: 'Set it up in one step',
        pathThisComputerCommand: 'One command in your terminal',
        pathSshTitle: 'A machine over SSH',
        pathSshChip: 'Over SSH',
        pathSshSubtitle: 'A dev box, VM or cloud machine',
        pathAnotherTitle: 'Another machine',
        pathAnotherSubtitle: 'Open a Home link on that machine',
        pathAnotherLead: 'Run agents on another computer.',
        machinePoolPrompt: 'Want sessions to fall back between machines?',
        thisComputerCommandLead: ({ home }) => `Run this in a terminal on this machine. It installs Happier and joins ${home}; this page notices as soon as it’s ready.`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} runs agents for ${home}. Happier installs a small background service that starts with the machine.`,
        setUpThisComputer: 'Set up this machine',
        desktopAppHint: 'Would rather click than type?',
        desktopAppLink: 'Get the desktop app — it sets this machine up by itself.',
        thisComputerRunningLead: ({ machine }) => `Setting up ${machine}. You can keep using Happier.`,
        onAnotherHomeTitle: ({ machine }) => `${machine} is connected to another Home`,
        onAnotherHomeBody: ({ home }) => `Its Happier service runs sessions for another Home. Moving it to ${home} keeps its settings; sessions already there stay there.`,
        moveToHome: ({ home }) => `Move it to ${home}`,
        keepOnOtherHome: 'Keep it where it is',
        sshLeadTask: ({ home }) => `A dev box, VM or cloud machine you can already reach with SSH. This machine connects to it, installs Happier and joins ${home}.`,
        sshLeadCommand: ({ home }) => `A dev box, VM or cloud machine you can already reach with SSH. A browser can’t open that connection itself, so run the command on a machine that can reach it; it installs Happier and joins ${home}.`,
        setUpHost: ({ host }) => `Set up ${host}`,
        sshSavedNote: 'The host is saved to Remote hosts; passwords never are.',
        sshRunningTitle: ({ host }) => `Setting up ${host}`,
        sshRunningLead: 'Running over SSH from this machine. You can leave; the Machines list shows its progress and tells you when it’s done.',
        sshRunningLeadPhone: 'Running over SSH from this phone.',
        sshKeepOpen: ({ host }) => `Keep Happier open until ${host} joins.`,
        hostKeyTitle: 'Is this your server?',
        hostKeyBody: ({ host }) => `You haven’t connected to ${host} from here before. Compare this fingerprint with the one your server’s provider shows.`,
        hostKeyFingerprint: ({ type }) => `${type} fingerprint`,
        hostKeyFingerprintPlain: 'Fingerprint',
        hostKeyTrust: 'Trust and continue',
        hostKeyChangedTitle: ({ host }) => `${host} has a different host key`,
        hostKeyChangedBody: 'If you didn’t rebuild this server, someone may be intercepting the connection. Compare the new fingerprint with your provider before trusting it.',
        anotherLead: ({ home }) => `Run this in a terminal on that machine. It installs Happier and joins ${home}.`,
        anotherTerminalAction: 'Use a terminal command instead',
        machineWatching: ({ subject }) => `Watching for ${subject} on `,
        subjectThisComputer: 'this machine',
        subjectAnotherComputer: 'the machine',
        machineNotSeeingTitle: ({ subject }) => `Not seeing ${subject} yet?`,
        machineNotSeeingBody: ({ home }) => `Happier is still watching. Usually setup stopped with an error, the machine can’t reach ${home}, or it was set up for another Home.`,
        machineArrived: ({ machine }) => `${machine} is connected`,
        machineConnectedJustNow: 'connected just now',
        machineStartSession: ({ machine }) => `Start a session on ${machine}`,
        machineAddAnother: 'Add another',
        cancelSetup: 'Cancel',
        detectedOs: 'Detected',
        sshSuggestionsTitle: 'From your SSH config and saved hosts',
        connectingToHome: ({ address }) => `Connecting to ${address}…`,
        pathThisComputerConnected: 'Connected · see its agents',
        sshConnectFromTitle: 'Connect from',
        sshConnectFromSubtitle: 'The SSH connection runs from here',
        sshConnectFromThisDevice: 'This device',
        sshRunsAsTitle: 'Runs as',
        sshRunsAsSubtitle: 'Happier and its agents run as the user you sign in as',
        sshRunsAsSubtitleUser: ({ user }) => `Happier and its agents run as ${user} on the server`,
        sshSeparateUsersTitle: 'Separate users',
        sshSeparateUsersSubtitle: 'Turn them on later in the machine’s Security tab',
        sshSeparateUsersOff: 'Off',
        sshConnectAndInstall: 'Connect and install',
        sshRunItYourself: 'Run it yourself',
        sshRunItYourselfLead: ({ home }) => `Run this in a terminal on a machine that can reach the server. It installs Happier and joins ${home}.`,
        sshNeedsAddress: 'Enter the server’s address to connect.',
        sshOnServerTitle: 'On the server',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "en">;
