export function resolveTranscriptToolVisibility(input: Readonly<{
    sessionOverride?: boolean;
    isBot: boolean;
    accountShowToolCalls?: boolean;
    groupToolCalls?: boolean;
    collapsedPreviewCount?: number;
}>) {
    const showToolCalls = typeof input.sessionOverride === 'boolean'
        ? input.sessionOverride
        : input.isBot ? false : input.accountShowToolCalls !== false;
    return {
        showToolCalls,
        groupToolCalls: !showToolCalls || input.groupToolCalls === true,
        collapsedPreviewCount: showToolCalls ? input.collapsedPreviewCount ?? 0 : 0,
        autoExpand: showToolCalls,
    };
}
