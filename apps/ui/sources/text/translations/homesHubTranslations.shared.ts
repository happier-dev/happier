

export type HomesHubTranslation = Readonly<{
    /** The one way to add a Home or sign in: the Homes page primary, the account popover row, the sheet title. */
    addHomeOrSignIn: string;
    sheetDescription: string;
    continueWithService: (params: Readonly<{ service: string }>) => string;
    continueWithServiceSubtitle: string;
    /** The service card when the Home in use is its own sign-in service and has no name. */
    continueWithThisHome: string;
    serviceUnavailable: (params: Readonly<{ service: string }>) => string;
    serviceUnsupported: (params: Readonly<{ service: string }>) => string;
    /** The same two states when the service has no name to offer: a sentence of their own. */
    serviceUnavailableUnnamed: string;
    serviceUnsupportedUnnamed: string;
    scanOrPaste: string;
    scanOrPasteSubtitle: string;
    createPersonalHome: string;
    createPersonalHomeSubtitle: string;
    /** The Home this device opens first (its device default). */
    opensFirst: string;
}>;


export const homesHubTranslationsEnglish = { en: {
        addHomeOrSignIn: 'Add a Home / Sign in',
        sheetDescription: 'Connect this device to another Home, or find yours.',
        continueWithService: ({ service }) => `Continue with ${service}`,
        continueWithThisHome: 'Continue with this Home',
        continueWithServiceSubtitle: 'Find your Homes and make this one available on your other devices.',
        serviceUnavailable: ({ service }) => `${service} is unavailable right now.`,
        serviceUnsupported: ({ service }) => `${service} doesn’t offer account sign-in.`,
        serviceUnavailableUnnamed: 'Your sign-in service is unavailable right now.',
        serviceUnsupportedUnnamed: 'Your sign-in service doesn’t offer account sign-in.',
        scanOrPaste: 'Scan or paste a Home link',
        scanOrPasteSubtitle: 'Join a Home from a QR code or link.',
        createPersonalHome: 'Create a Personal Home on this computer',
        createPersonalHomeSubtitle: 'Run a Home here for your own machines and devices.',
        opensFirst: 'Opens first',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "en">;