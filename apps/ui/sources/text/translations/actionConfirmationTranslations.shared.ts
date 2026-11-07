

export type ActionConfirmationTranslations = Readonly<{
    requestedByAgent: string;
    homeTarget: (params: Readonly<{ serverId: string }>) => string;
    sessionTarget: (params: Readonly<{ sessionId: string }>) => string;
    oneShotConsequence: string;
    homeUnavailable: string;
    turnedOffTitle: string;
    turnedOffMessage: string;
    turnedOffUnnamedMessage: string;
    turnedOffReadMessage: string;
    openActionSettings: string;
}>;


export const actionConfirmationTranslationsEnglish = { en: {
        requestedByAgent: 'Action requested by the session Agent',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `Target session: ${sessionId}`,
        oneShotConsequence: 'Approval applies only to this request. It does not grant future Action or native permissions.',
        homeUnavailable: 'This approval belongs to a Home that is unavailable on this device. Reconnect that Home to decide it.',
        turnedOffTitle: 'Action turned off',
        turnedOffMessage: 'This action is turned off, so nothing was changed. You can turn it back on in Settings → Actions.',
        turnedOffUnnamedMessage: 'This action is turned off. Turn it back on in Settings → Actions to use it here.',
        turnedOffReadMessage: 'This action is turned off, so nothing was loaded. You can turn it back on in Settings → Actions.',
        openActionSettings: 'Open Actions settings',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "en">;