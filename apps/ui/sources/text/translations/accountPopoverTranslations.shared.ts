

export type AccountPopoverTranslation = Readonly<{
    /** The phone page that shows the same content as the desktop popover. */
    pageTitle: string;
    homesTitle: string;
    /** The identity row's service line while this device holds no sign-in to it. */
    notLinkedTo: (params: Readonly<{ service: string }>) => string;
    /** The identity row's service line while the service does not answer. */
    serviceUnavailable: (params: Readonly<{ service: string }>) => string;
    /** The identity row's service line when the Home is its own sign-in service. */
    signedInToThisHome: string;
    /** The identity row's service line while the Home's sign-in policy is not read yet. */
    checkingSignIn: string;
    /** …once the policy cannot be read now (read failed, or the Home does not answer). */
    signInStatusUnavailable: string;
    machinesOnline: (params: Readonly<{ online: number; total: number }>) => string;
    noMachines: string;
    /** Connected, but none of its machines is online. */
    connectedNoMachinesOnline: string;
    cantReach: string;
    signedOut: string;
    signIn: string;
    link: string;
    linkSubtitle: string;
    manageHomes: string;
    connectionDetails: string;
    /** The selection that shows every saved Home together, grouped by Home. */
    allHomes: string;
    /** Its line: how many Homes it gathers. */
    allHomesSubtitle: (params: Readonly<{ count: number }>) => string;
    /** The row that opens "Add a Home". */
    addHome: string;
    addDevice: string;
}>;


export const accountPopoverTranslationsEnglish = { en: {
        pageTitle: 'Account & Homes',
        homesTitle: 'Homes',
        notLinkedTo: ({ service }) => `Not linked to ${service}`,
        serviceUnavailable: ({ service }) => `Can't reach ${service}`,
        signedInToThisHome: 'Signed in to this Home',
        checkingSignIn: 'Checking sign-in…',
        signInStatusUnavailable: 'Sign-in status unavailable',
        machinesOnline: ({ online, total }) => `${online} of ${total} ${total === 1 ? 'machine' : 'machines'} online`,
        noMachines: 'No machines yet',
        connectedNoMachinesOnline: 'Connected · no machines online',
        cantReach: "Can't reach it",
        signedOut: 'Signed out',
        signIn: 'Sign in',
        link: 'Link',
        linkSubtitle: 'Find your Homes on every device',
        manageHomes: 'Manage Homes',
        connectionDetails: 'Connection details',
        allHomes: 'All Homes',
        allHomesSubtitle: ({ count }) => `${count} Homes · one list`,
        addHome: 'Add a Home…',
        addDevice: 'Add a device',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "en">;