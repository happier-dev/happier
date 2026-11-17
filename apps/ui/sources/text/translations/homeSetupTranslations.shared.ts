

export type HomeSetupTranslation = Readonly<{
    dismiss: (params: Readonly<{ title: string }>) => string;
    dismissTooltip: string;
    close: string;
    addPhoneSubtitle: string;
    addPhoneAction: string;
    addMachineSubtitle: string;
    installComputerTitle: string;
    installComputerSubtitle: string;
    installComputerAction: string;
    connectComputerTitle: string;
    connectComputerSubtitle: string;
    connectComputerHint: string;
    phoneAddMachineSubtitle: string;
    phoneAddMachineAction: string;
    thisHome: string;
    pairingPhoneTitle: string;
    pairingPhoneBody: (params: Readonly<{ home: string }>) => string;
    pairingPhoneStepInstall: string;
    pairingPhoneStepScan: string;
    pairingPhoneStepJoin: string;
    pairingComputerTitle: string;
    pairingComputerBody: (params: Readonly<{ home: string }>) => string;
    pairingComputerStepInstall: string;
    pairingComputerStepOpen: string;
    pairingComputerStepJoin: string;
    pairingComputerStepInstallTitle: string;
    pairingComputerStepInstallDetail: string;
    pairingComputerStepOpenTitle: string;
    pairingComputerStepJoinTitle: string;
    pairingScanTitle: string;
    pairingScanBody: string;
    shareLink: string;
    appStore: string;
    googlePlay: string;
    getDesktopApp: string;
    copyLink: string;
    waitingForPhone: string;
    waitingForComputer: string;
    newCodeIn: (params: Readonly<{ time: string }>) => string;
    makingCode: string;
    addingDevice: (params: Readonly<{ device: string }>) => string;
    deviceJoined: (params: Readonly<{ device: string; home: string }>) => string;
    codeFailed: string;
    codeFailedUnreachable: (params: Readonly<{ home: string }>) => string;
    codeFailedIdentity: (params: Readonly<{ home: string }>) => string;
    codeFailedSignedOut: (params: Readonly<{ home: string }>) => string;
    codeFailedTooLarge: string;
    codeFailedRefused: (params: Readonly<{ home: string }>) => string;
    codeFailedUnexpected: string;
    cancelCode: string;
    newCode: string;
    qrLabel: (params: Readonly<{ home: string }>) => string;
    storeQrLabel: (params: Readonly<{ store: string }>) => string;
    getTheApp: string;
    connectServicesTitle: (params: Readonly<{ first: string; second: string | null }>) => string;
    connectServicesSubtitle: string;
    addNameSubtitle: string;
    addNameAction: string;
    notNow: string;
    teamSetupTitle: (params: Readonly<{ team: string }>) => string;
    teamSetupSubtitle: string;
    teamSetupAction: string;
    teamSetupHint: (params: Readonly<{ team: string }>) => string;
}>;


export const homeSetupTranslationsEnglish = { en: {
        dismiss: ({ title }) => `Hide “${title}”`,
        dismissTooltip: 'Hide · restore from Customize',
        close: 'Close',
        addPhoneSubtitle: 'Follow sessions and answer approvals from anywhere.',
        addPhoneAction: 'Show QR code',
        addMachineSubtitle: 'A machine or dev box that runs agents, set up over SSH or with one command.',
        installComputerTitle: 'Install on another machine',
        installComputerSubtitle: 'Get the desktop app there and join this Home with a link.',
        installComputerAction: 'Get the link',
        connectComputerTitle: 'Connect a machine',
        connectComputerSubtitle: 'Scan the code Happier shows in your machine’s terminal.',
        connectComputerHint: 'Point the camera at the code Happier shows in your machine’s terminal.',
        phoneAddMachineSubtitle: 'Set up a machine or dev box to run your agents.',
        phoneAddMachineAction: 'Add',
        thisHome: 'this Home',
        pairingPhoneTitle: 'Scan with your phone',
        pairingPhoneBody: ({ home }) => `Point your phone’s camera at the code. Happier opens and joins ${home}.`,
        pairingPhoneStepInstall: 'Install Happier on your phone.',
        pairingPhoneStepScan: 'Open the camera and scan the code.',
        pairingPhoneStepJoin: 'Keep this open: your phone joins as soon as it scans.',
        pairingComputerTitle: 'Join from another machine',
        pairingComputerBody: ({ home }) => `Send this link to your other machine. Opening it in Happier joins ${home}.`,
        pairingComputerStepInstall: 'Get the desktop app on the other machine.',
        pairingComputerStepOpen: 'Open the link there, or paste it into Happier when it asks how to connect.',
        pairingComputerStepJoin: 'Keep this open: the machine joins as soon as it opens the link.',
        pairingComputerStepInstallTitle: 'Install Happier there',
        pairingComputerStepInstallDetail: 'On the Mac, Windows or Linux computer you want to add.',
        pairingComputerStepOpenTitle: 'Open this link on it',
        pairingComputerStepJoinTitle: 'It shows up in Machines',
        pairingScanTitle: 'Or scan it',
        pairingScanBody: 'From a phone or tablet with a camera.',
        shareLink: 'Share',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: 'Get the desktop app',
        copyLink: 'Copy link',
        waitingForPhone: 'Waiting for your phone…',
        waitingForComputer: 'Waiting for your machine…',
        newCodeIn: ({ time }) => `New code in ${time}`,
        makingCode: 'Making a code…',
        addingDevice: ({ device }) => `Adding ${device}…`,
        deviceJoined: ({ device, home }) => `${device} joined ${home}`,
        codeFailed: 'Couldn’t make a code for this Home.',
        codeFailedUnreachable: ({ home }) => `${home} didn’t answer from this device.`,
        codeFailedIdentity: ({ home }) => `This device’s record of ${home} doesn’t match its answer; open Homes to reconnect it.`,
        codeFailedSignedOut: ({ home }) => `This device isn’t signed in to ${home}.`,
        codeFailedTooLarge: 'It has too many addresses to fit in a code.',
        codeFailedRefused: ({ home }) => `${home} turned the request down.`,
        codeFailedUnexpected: 'Something went wrong; try again.',
        cancelCode: 'Cancel code',
        newCode: 'New code',
        qrLabel: ({ home }) => `QR code that adds a device to ${home}`,
        storeQrLabel: ({ store }) => `QR code for Happier on ${store}`,
        getTheApp: 'Get the app',
        connectServicesTitle: ({ first, second }) => (second ? `Connect ${first} or ${second}` : `Connect ${first}`),
        connectServicesSubtitle: 'Use the plan you already pay for, on every machine, and see what’s left.',
        addNameSubtitle: 'So people you work with see your name.',
        addNameAction: 'Add name',
        notNow: 'Not now',
        teamSetupTitle: ({ team }) => `Set up for ${team}`,
        teamSetupSubtitle: "The Team’s tools, repositories and agents, on a machine you choose. You see each step first.",
        teamSetupAction: 'Set up',
        teamSetupHint: ({ team }) => `${team} shares a setup for this repository`,
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "en">;
