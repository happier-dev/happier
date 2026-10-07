

export type ActionConfirmationTranslations = Readonly<{
    requestedByAgent: string;
    homeTarget: (params: Readonly<{ serverId: string }>) => string;
    sessionTarget: (params: Readonly<{ sessionId: string }>) => string;
    oneShotConsequence: string;
    homeUnavailable: string;
}>;


export const actionConfirmationTranslationsEnglish = { en: {
        requestedByAgent: 'Action requested by the session Agent',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `Target session: ${sessionId}`,
        oneShotConsequence: 'Approval applies only to this request. It does not grant future Action or native permissions.',
        homeUnavailable: 'This approval belongs to a Home that is unavailable on this device. Reconnect that Home to decide it.',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "en">;