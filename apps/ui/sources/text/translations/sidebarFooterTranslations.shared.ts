

export type SidebarFooterTranslation = Readonly<{
    /** The account area when this device has no sign-in to the account service it names. */
    linkToService: (params: Readonly<{ service: string }>) => string;
    /** The same entry when the account service has no name to offer. */
    addHomeOrSignIn: string;
    usageNoAccounts: string;
    usageHealthy: string;
    /** The pane or list that is waiting for a Home that does not answer. */
    homeUnreachableTitle: (params: Readonly<{ home: string }>) => string;
    homeUnreachableBody: string;
    homeUnreachableLine: (params: Readonly<{ home: string }>) => string;
    availableWhenHomeAnswers: string;
    /** The Usage popover's footer: keys and tokens report no limits, so they are counted there. */
    usageKeysWithoutLimits: (params: Readonly<{ count: number }>) => string;
    /** An account that needs a new sign-in, beside its fix. */
    usageSignedOut: string;
    /** The Usage popover's privacy eye: the device setting "Hide account emails and IDs". */
    hideAccountIdentities: string;
    /** The eye's tooltip while identities are hidden. */
    accountIdentitiesHidden: string;
    /** The composer ring's popover heading: usage for this session only. */
    usageThisSession: string;
    /** Widens the session popover to every account. */
    usageAllAccounts: string;
    usageMoreAccounts: (params: Readonly<{ count: number }>) => string;
    /** How the session signs in: through a pool, with one account, or on its own. */
    usageSessionThroughPool: (params: Readonly<{ agent: string; pool: string }>) => string;
    usageSessionWithAccount: (params: Readonly<{ agent: string }>) => string;
    usageSessionOwnSignIn: (params: Readonly<{ agent: string }>) => string;
    /** A pool without a name of its own. */
    usagePoolFallback: string;
    /** What the session's pool does when its account runs out (the pool's policy, not a prediction). */
    usageNextInOrder: (params: Readonly<{ account: string }>) => string;
    usageNextMostLeft: (params: Readonly<{ account: string }>) => string;
    usageNextStays: (params: Readonly<{ pool: string; account: string }>) => string;
}>;


export const sidebarFooterTranslationsEnglish = { en: {
        linkToService: ({ service }) => `Link to ${service}`,
        addHomeOrSignIn: 'Add a Home or sign in',
        usageNoAccounts: 'Connect an account to see how much of its limits is left.',
        usageHealthy: 'Plenty of room left in every limit',
        homeUnreachableTitle: ({ home }) => `Can't reach ${home}`,
        homeUnreachableBody: 'Your machines and sessions appear here again once it answers.',
        homeUnreachableLine: ({ home }) => `Can't reach ${home}.`,
        availableWhenHomeAnswers: "Available when this Home answers.",
        usageKeysWithoutLimits: ({ count }) => count === 1 ? '1 key without limits' : `${count} keys without limits`,
        usageSignedOut: 'Signed out',
        hideAccountIdentities: 'Hide account emails and IDs',
        accountIdentitiesHidden: 'Emails and IDs hidden · for streaming and demos',
        usageThisSession: 'This session',
        usageAllAccounts: 'All accounts',
        usageMoreAccounts: ({ count }) => `${count} more`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} signs in through ${pool}`,
        usageSessionWithAccount: ({ agent }) => `${agent} signs in with this account`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} uses its own sign-in`,
        usagePoolFallback: 'its pool',
        usageNextInOrder: ({ account }) => `When ${account} runs out, the next turn moves to the next account in order`,
        usageNextMostLeft: ({ account }) => `When ${account} runs out, the next turn moves to the account with the most left`,
        usageNextStays: ({ pool, account }) => `${pool} stays on ${account} until you switch`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "en">;