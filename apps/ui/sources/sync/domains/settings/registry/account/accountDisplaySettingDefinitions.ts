import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

function bucketCount(value: number, smallMax: number, mediumMax: number): 'small' | 'medium' | 'large' {
    if (value <= smallMax)
        return 'small';
    if (value <= mediumMax)
        return 'medium';
    return 'large';
}

function bucketBytes(value: number, smallMax: number, mediumMax: number): 'small' | 'medium' | 'large' {
    if (value <= smallMax)
        return 'small';
    if (value <= mediumMax)
        return 'medium';
    return 'large';
}

export const ACCOUNT_DISPLAY_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    sessionThinkingDisplayMode: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    sessionThinkingInlinePresentation: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    sessionThinkingInlineChrome: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    showLineNumbers: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    showLineNumbersInToolViews: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    wrapLinesInDiffs: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    sessionReplayStrategy: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    sessionReplayRecentMessagesCount: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: number) => bucketCount(value, 100, 300),
    },
    sessionReplayMaxSeedChars: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: number) => bucketCount(value, 80000, 200000),
    },
    executionRunsGuidanceEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    executionRunsGuidanceMaxChars: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: number) => bucketCount(value, 2000, 5000),
    },
    attachmentsUploadsUploadLocation: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    attachmentsUploadsVcsIgnoreStrategy: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    attachmentsUploadsVcsIgnoreWritesEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    attachmentsUploadsMaxFileBytes: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'bucket',
        privacy: 'bucketed',
        identityScope: 'person',
        serializeCurrent: (value: number) => bucketBytes(value, 10 * 1024 * 1024, 50 * 1024 * 1024),
    },
    sessionTagsEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    sessionListWorkingStatusAnimatedTextEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    mobileWorkspaceExperienceV1: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    tabBarGitBadgeMode: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    tabBarFriendsBadgeEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    tabBarInboxBadgeEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    tabBarSessionsBadgeEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    tabBarOpenTabsBadgeEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    tabBarShowLabels: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    tabBarSize: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    glassBlurEnabled: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    glassBlurIntensity: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    composerSurfaceStyle: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
});
