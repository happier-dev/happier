export const DEPRECATED_SESSION_ONLY_SETTINGS_KEYS = new Set<string>([
    'toolViewDetailLevelDefaultActivityFeed',
    'toolViewExpandedDetailLevelDefaultActivityFeed',
    'toolViewCardDensity',
]);

export const MIGRATED_SESSION_ORGANIZATION_ACCOUNT_SETTING_KEYS = new Set<string>([
    'pinnedSessionKeysV1',
    'workspaceLabelsV1',
    'collapsedGroupKeysV1',
    'sessionTagsV1',
    'sessionListGroupOrderV1',
    'sessionWorkspaceOrderV1',
    'sessionFoldersV1',
]);

export const DROPPED_ACCOUNT_SETTINGS_KEYS = new Set<string>([
    ...DEPRECATED_SESSION_ONLY_SETTINGS_KEYS,
    ...MIGRATED_SESSION_ORGANIZATION_ACCOUNT_SETTING_KEYS,
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

export function stripMigratedSessionOrganizationSettings<TSettings extends Record<string, unknown>>(settings: TSettings): TSettings {
    const next = { ...settings };
    for (const key of MIGRATED_SESSION_ORGANIZATION_ACCOUNT_SETTING_KEYS) {
        if (key in next) {
            delete next[key];
        }
    }
    return next;
}
