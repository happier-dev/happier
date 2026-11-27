

export type HomeParams = { home: string };



export type PersonalHomeDecisionTranslation = typeof en;



export const en = {
    homeIdentityAmbiguous: 'This Personal Home address matches more than one saved Home.',
    signedInHome: {
        body: ({ home }: HomeParams) => `This computer is signed in to ${home}. Keep using it, or set up a Personal Home here.`,
        keep: ({ home }: HomeParams) => `Keep using ${home}`,
        keepDetail: 'Your sessions and machines stay exactly as they are.',
        create: 'Set up a Personal Home',
        createDetail: 'Create a private Home on this computer and switch to it.',
    },
    existingRuntimeCredentials: {
        body: 'This app can’t open it without that Home’s recovery key. Sign in with the key, or use another Home.',
        signIn: 'Sign in with a recovery key',
        signInDetail: 'Use the recovery key saved for this local Home.',
    },
    setupState: {
        readyTitle: 'Your Personal Home is ready',
        readyStatus: 'Opening it now.',
        signedInTitle: 'You’re signed in to another Home',
        existingRuntimeTitle: 'A Home is already set up on this computer',
        existingRuntimeStatus: 'Use it as your Personal Home, or choose another Home.',
        credentialsTitle: 'This local Home belongs to another Happier app',
        existingRuntimeFailedTitle: 'This local Home didn’t open',
        existingRuntimeFailedStatus: 'Happier couldn’t connect to the Home on this computer. Try again, or use another Home.',
        failureTitle: 'Setup didn’t finish',
        erasedTitle: 'Your Personal Home was erased',
        erasedAction: 'Create a new Personal Home',
        copyDetails: 'Copy technical details',
        endpointUpdateRequiredTitle: 'The Home on this computer is an older version',
        endpointUpdateRequiredStatus: 'Update it from Settings, then try again. Or use another Home.',
        endpointUnreachableTitle: 'The Home on this computer isn’t answering',
        endpointUnreachableStatus: 'Check that its background service is running, then try again.',
    },
};


export const personalHomeDecisionTranslationsEnglish = { en };