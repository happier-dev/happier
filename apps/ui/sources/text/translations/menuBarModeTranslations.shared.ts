

export type RelayParams = { relay: string };



export type DetailParams = { detail: string };



export type CountParams = { count: string };



export type DesktopTrayTranslation = typeof en;



export type DesktopLoginStartTranslation = typeof enLoginStart;



export const en = {
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



export const enLoginStart = {
    title: 'Start at login',
    subtitle: 'Keeps this computer reachable from your phone and browser: its background services start when you sign in and keep running after you quit Happier. When this is off, quitting Happier stops them.',
    unknown: 'Happier can’t tell yet whether this computer’s background services start at login.',
    notSetUp: 'Available once this computer is set up.',
};


export const menuBarModeTranslationsEnglish = { en: { tray: en, loginStart: enLoginStart } };