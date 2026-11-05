

export type ConnectedServicesSetupTranslation = Readonly<{
    connectMoreTitle: string;
    connectMoreDescription: string;
    connectMoreNothingNew: string;
    serviceSignInInstead: (params: Readonly<{ agents: string }>) => string;
    serviceCanUse: (params: Readonly<{ agents: string }>) => string;
    moreServicesTitle: string;
    moreServicesTools: (params: Readonly<{ names: string }>) => string;
    moreServicesAll: string;
    browse: string;
    notNow: (params: Readonly<{ service: string }>) => string;
    notNowTooltip: string;
    back: string;
    homeCatalogTitle: string;
    homeCatalogPurpose: string;
    homeNextSubtitle: (params: Readonly<{ agents: string }>) => string;
    firstRunMore: string;
    settleAddToPoolWhy: (params: Readonly<{ pool: string; agent: string; active: string }>) => string;
    settleAddToPoolShort: (params: Readonly<{ pool: string }>) => string;
    settleAddToPool: (params: Readonly<{ pool: string }>) => string;
    deviceStepCopy: string;
    deviceStepOpen: (params: Readonly<{ service: string }>) => string;
    deviceStepOpenWhere: (params: Readonly<{ where: string }>) => string;
    deviceStepApprove: (params: Readonly<{ service: string }>) => string;
    deviceCheckNow: string;
    keyNew: string;
    keySaved: string;
    keyUse: (params: Readonly<{ name: string }>) => string;
    keyOwnerApprovesFirst: (params: Readonly<{ owner: string }>) => string;
    keyHowToAdd: string;
    keyInUseHere: string;
    keyUsedElsewhereForThis: string;
    keySearch: string;
    accountNew: string;
    accountSaved: string;
    keyTitle: string;
    sheetUnavailable: string;
    sheetPurposeUnavailable: string;
    sheetSelectionRequired: string;
    sheetProfileUnavailable: string;
}>;


export const connectedServicesSetupTranslationsEnglish = { en: {
        connectMoreTitle: 'Connect more',
        connectMoreDescription: 'Services the agents on your machines accept that you haven’t connected.',
        connectMoreNothingNew: 'Add another account, or a code host or tool.',
        serviceSignInInstead: ({ agents }) => `${agents} can sign in with it instead of each machine’s own login.`,
        serviceCanUse: ({ agents }) => `${agents} can use it.`,
        moreServicesTitle: 'More services',
        moreServicesTools: ({ names }) => `${names} and more, for code and tools.`,
        moreServicesAll: 'Everything your agents and tools accept.',
        browse: 'Browse',
        notNow: ({ service }) => `Not now: ${service}`,
        notNowTooltip: 'Not now · still in Browse',
        back: 'All services',
        homeCatalogTitle: 'Connect an account',
        homeCatalogPurpose: 'Your agents use it on every machine, and Home shows what’s left.',
        homeNextSubtitle: ({ agents }) => `${agents} can use it instead of each machine’s own login.`,
        firstRunMore: 'API keys, code hosts and tools',
        settleAddToPoolWhy: ({ pool, agent, active }) => `Add it to ${pool}, so ${agent} moves to it when ${active} runs out?`,
        settleAddToPoolShort: ({ pool }) => `Add it to ${pool}?`,
        settleAddToPool: ({ pool }) => `Add to ${pool}`,
        deviceStepCopy: 'Copy this code',
        deviceStepOpen: ({ service }) => `Open ${service} and enter it`,
        deviceStepOpenWhere: ({ where }) => `${where}, signed in to the account you want to use`,
        deviceStepApprove: ({ service }) => `Approve Happier in ${service}`,
        deviceCheckNow: 'Check now',
        keyNew: 'New key',
        keySaved: 'Saved key',
        keyUse: ({ name }) => `Use ${name}`,
        keyOwnerApprovesFirst: ({ owner }) => `${owner} approves first`,
        keyHowToAdd: 'How to add the key',
        keyInUseHere: 'In use here',
        keyUsedElsewhereForThis: 'Used elsewhere for this',
        keySearch: 'Search keys',
        accountNew: 'Add account',
        accountSaved: 'Your accounts',
        keyTitle: 'Add a key',
        sheetUnavailable: 'This sign-in belongs to another account, so it can’t be changed here.',
        sheetPurposeUnavailable: 'This plugin’s account purpose is unavailable. Reopen the source after the plugin loads.',
        sheetSelectionRequired: 'Choose this account from the machine setup that requested it.',
        sheetProfileUnavailable: 'The loaded credentials belong to a different account. Reopen Credentials in the current account.',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "en">;