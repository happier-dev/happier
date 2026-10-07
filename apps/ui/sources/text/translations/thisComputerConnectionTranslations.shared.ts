

export type HomeParams = { home: string };



export type OtherHomeParams = { home: string; daemonHome: string };



export type AccountParams = { home: string; daemonAccount: string; appAccount: string };



export type RemovalServiceParams = { home: string; service: string };



export type MoveParams = { home: string; daemonHome: string; daemonAccount: string; appAccount: string };



export type ThisComputerConnectionTranslation = typeof en;



export const en = {
    connectHome: {
        title: ({ home }: HomeParams) => `Connect this computer to ${home}?`,
        body: ({ home }: HomeParams) => `${home} will be able to start sessions on this computer. Your terminal’s Home and other Home connections stay in place.`,
        connect: 'Connect',
        keep: 'Keep current connections',
    },
    setupAlreadyRunning: 'Setup is already running. Wait for it to finish.',
    title: {
        daemon_url_mismatch: 'Background service is on another Home',
        daemon_account_mismatch: 'Background service uses another account',
        daemon_needs_auth: 'Background service needs to sign in',
        daemon_not_configured: 'Background service isn’t connected yet',
        daemon_not_installed: 'Background service isn’t installed',
        daemon_not_running: 'Background service is stopped',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `It’s connected to ${daemonHome}, not ${home}.`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `It’s signed in to ${home} as ${daemonAccount}, not as ${appAccount}.`,
        daemon_needs_auth: ({ home }: HomeParams) => `It’s connected to ${home} but hasn’t been approved yet.`,
        daemon_not_configured: ({ home }: HomeParams) => `It hasn’t finished connecting to ${home}.`,
        daemon_not_installed: ({ home }: HomeParams) => `Install it to connect this computer to ${home}.`,
        daemon_not_running: ({ home }: HomeParams) => `Start it to reconnect to ${home}.`,
    },
    action: {
        daemon_url_mismatch: 'Connect to this Home',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `Switch to ${appAccount}`,
        daemon_needs_auth: 'Sign in',
        daemon_not_configured: 'Connect to this Home',
        daemon_not_installed: 'Install background service',
        daemon_not_running: 'Start background service',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `Connected to ${home} as ${appAccount}.`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} has no computers on ${home} yet.`,
    openThisComputer: 'Review this computer',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `Switch this computer to ${appAccount}?`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `Its background service is signed in to ${daemonHome} as ${daemonAccount}. After switching, it works for ${appAccount} on ${home}, and ${daemonAccount} no longer sees this computer.`,
        confirm: 'Switch',
    },
    cli: {
        title: 'Happier CLI',
        version: ({ version }: { version: string }) => `Version ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `Version ${version} · ${latestVersion} is available`,
        update: 'Update',
        progressTitle: 'Updating the Happier CLI',
        notManaged: ({ origin }: { origin: string }) => `Installed outside Happier: ${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `Happier CLI ${version} is already installed`,
        titleUnknownVersion: 'The Happier CLI is already installed',
        titleMissing: 'Your Happier CLI is no longer installed',
        body: ({ path }: { path: string }) => `It’s at ${path}. Happier can install its own copy, keep it up to date and put it first on your PATH, or keep using this one.`,
        bodyOutdated: ({ path }: { path: string }) => `It’s at ${path}, and it’s too old for setup. Happier can install its own up-to-date copy and put it first on your PATH, or you can keep yours and update it yourself.`,
        bodyMissing: ({ path }: { path: string }) => `You chose to keep the one at ${path}, and it isn’t there anymore. Happier can install its own copy and keep it up to date, or you can reinstall yours and keep using it.`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `It’s at ${path}, but new terminals run Happier’s own CLI first through ${link}, which Happier didn’t add. Let Happier manage the command line, or remove ${link} and run setup again to keep yours.`,
        notNow: 'Not now',
        manage: 'Let Happier manage it',
        keep: 'Keep my own',
        unanswered: 'Setup stopped before changing anything. Choose who manages the command line to continue.',
        ownMissing: 'The command line you kept isn’t installed anymore. Reinstall it, or let Happier manage the command line.',
        managed: 'Managed by Happier',
        own: ({ path }: { path: string }) => `Your own — ${path}`,
        change: 'Change who manages the command line',
        keptUpdateTitle: 'Update your command line',
        keptUpdate: ({ command }: { command: string }) => `A newer version is available. Update it with ${command}`,
        oldCopyTitle: 'Old command line',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `Still installed at ${path}. Remove it with ${command}`,
        oldCopyPath: ({ path }: { path: string }) => `Still installed at ${path}.`,
    },
    servers: {
        title: 'Homes this computer serves',
        connected: 'Connected',
        offline: 'Set up · Offline',
        attention: 'Needs attention',
        currentHome: ({ home }: HomeParams) => `${home} · this Home`,
    },
    removal: {
        uninstallFailedTitle: 'Couldn’t disconnect this computer',
        uninstallFailedBody: ({ home }: HomeParams) => `This computer’s background service for ${home} couldn’t be removed, so ${home} was kept. Try again, or remove the service from Settings › This computer.`,
        inventoryUnavailableTitle: 'Couldn’t check this computer',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier couldn’t read this computer’s background services, so it can’t tell whether this computer still serves ${home}. Remove it from Happier anyway?`,
        removeAnyway: 'Remove anyway',
        userOwnedTitle: 'This computer keeps serving it',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} was installed outside Happier, so it keeps running for ${home}. Remove it from the terminal if you no longer need it.`,
    },
};


export const thisComputerConnectionTranslationsEnglish = { en };