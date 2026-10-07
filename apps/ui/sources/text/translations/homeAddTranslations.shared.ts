

export type HomeAddTranslation = Readonly<{
    addressIsSignInService: string;
    mixedContent: string;
    connectedToHome: (params: Readonly<{ home: string }>) => string;
    openHome: (params: Readonly<{ home: string }>) => string;
    showAllHomes: string;
    otherSignInService: string;
    otherSignInServiceSubtitle: string;
    signInServiceAddress: string;
}>;



export const en: HomeAddTranslation = {
    addressIsSignInService: 'This address is a sign-in service. Sign in through it to find your Homes.',
    mixedContent: 'This browser cannot connect to an HTTP Home from an HTTPS page. Open Happier over HTTP or use an HTTPS Home address.',
    connectedToHome: ({ home }) => `${home} is connected to this device.`,
    openHome: ({ home }) => `Open ${home}`,
    showAllHomes: 'Show All Homes',
    otherSignInService: 'Another sign-in service',
    otherSignInServiceSubtitle: 'A self-hosted or company service',
    signInServiceAddress: 'Service address',
};


export const homeAddTranslationsEnglish = { en } satisfies Pick<Record<string, HomeAddTranslation>, "en">;