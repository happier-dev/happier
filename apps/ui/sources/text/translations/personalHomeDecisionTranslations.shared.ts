

export type HomeParams = { home: string };



export type PersonalHomeDecisionTranslation = typeof en;



export const en = {
    homeIdentityAmbiguous: 'This Personal Home address matches more than one saved Home.',
    signedInHome: {
        status: 'You’re already signed in to another Home.',
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
};


export const personalHomeDecisionTranslationsEnglish = { en };