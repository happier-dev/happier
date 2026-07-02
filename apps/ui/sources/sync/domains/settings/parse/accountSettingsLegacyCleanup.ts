export const DEPRECATED_SESSION_ONLY_SETTINGS_KEYS = new Set<string>([
    'toolViewDetailLevelDefaultActivityFeed',
    'toolViewExpandedDetailLevelDefaultActivityFeed',
    'toolViewCardDensity',
]);

export const DROPPED_ACCOUNT_SETTINGS_KEYS = new Set<string>([
    ...DEPRECATED_SESSION_ONLY_SETTINGS_KEYS,
    'defaultPermissionModeClaude',
    'defaultPermissionModeCodex',
    'defaultPermissionModeGemini',
    'experimentalAgents',
    'expCodexResume',
    'expCodexAcp',
    'codexResumeInstallSpec',
    'expVoiceAuthFlow',
    'codexAcpInstallSpec',
    'expUsageReporting',
    'expFileViewer',
    'expScmOperations',
    'expShowThinkingMessages',
    'expSessionType',
    'expAutomations',
    'expZen',
    'expInboxFriends',
    'experimentalFeatureToggles',
    'sessionMruOrderV1',
    'transcriptMessageTimestampsEnabled',
]);

export function isDroppedLegacyServerSelectionKey(key: string): boolean {
    if (key.startsWith('multiServer')) return true;
    if (!key.startsWith('activeServerTarget')) return false;
    return key.endsWith('Kind') || key.endsWith('Id');
}

export function stripDeprecatedSessionOnlyKeys<TSettings extends Record<string, unknown>>(settings: TSettings): TSettings {
    const next = { ...settings };
    for (const key of DEPRECATED_SESSION_ONLY_SETTINGS_KEYS) {
        if (key in next) {
            delete next[key];
        }
    }
    return next;
}
