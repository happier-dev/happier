

export const en = {
    title: 'Sign in to find your Homes',
    cancelNote: 'Canceling won’t sign you out of your existing Homes.',
    focusedHomePreserved: 'Your focused Home won’t change.',
    stages: {
        signingIn: 'Signing in',
        findingHomes: 'Finding your Homes',
        waitingApproval: 'Waiting for Home approval',
    },
    errors: {
        provider: { title: 'The provider did not complete sign-in', body: 'Start the sign-in again.' },
        expired: { title: 'This sign-in request expired', body: 'Start the sign-in again.' },
        identityChanged: { title: 'The sign-in service identity changed', body: 'Check that this is the sign-in service you meant to use before connecting again.' },
        unavailable: { title: 'The sign-in service is unavailable', body: 'Check the service and try again. Your existing Homes are unchanged.' },
        exchange: { title: 'Sign-in could not be completed', body: 'No sign-in service credential was saved. Start the sign-in again.' },
        storage: { title: 'Sign-in could not be saved', body: 'Your existing Home credentials are unchanged. Start the sign-in again.' },
        homeLink: { title: 'Signed in, but this Home could not be linked', body: 'Your sign-in is saved. Try linking this Home again.' },
        directoryRefresh: { title: 'Signed in, but we couldn’t refresh your Home list', body: 'Your sign-in service connection is ready. Try refreshing your Home list again.' },
        homeEnrollment: { title: 'Signed in, but your Personal Home was not added', body: 'Your sign-in is saved. Try adding the Home again.' },
        invalid: { title: 'This sign-in request is no longer valid', body: 'Start the sign-in again.' }, accountDisabled: { title: 'This account is disabled', body: 'Contact the administrator of your sign-in service. Your existing Homes are unchanged.' },
    },
    actions: {
        startAgain: 'Start again',
        openHome: ({ homeName }: { homeName: string }) => `Open ${homeName}`,
    },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} is connected`, body: 'Your sign-in is saved and this Home is ready to use.' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} isn’t linked to this account yet`, signInAction: ({ homeName }: { homeName: string }) => `Sign in to ${homeName}`, body: ({ homeName }: { homeName: string }) => `Sign in to ${homeName} directly, or scan its QR code or paste its Home link.`, scanBody: ({ homeName }: { homeName: string }) => `Scan the QR code of ${homeName} or paste its Home link to connect it.` },
    noHomes: { body: 'This account has no Homes yet. Refresh after adding one elsewhere, or scan a Home’s QR code or paste its Home link.' },
    approvalWait: {
        waitingBody: 'Approve this sign-in from your other signed-in device.',
        cancelledTitle: 'Stopped waiting for approval',
        cancelledBody: 'Your sign-in is still saved and your existing Homes are unchanged.',
    },
} as const;


export const accountServiceOAuthTranslationsEnglish = { en } as const;