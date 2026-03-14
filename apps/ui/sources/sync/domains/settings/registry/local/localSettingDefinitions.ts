import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

function bucketNormalizedPaneSize(
    value: number,
    basisValue: unknown,
    smallMaxFraction: number,
    mediumMaxFraction: number,
): 'small' | 'medium' | 'large' {
    const basisPx =
        typeof basisValue === 'number' && Number.isFinite(basisValue) && basisValue > 0
            ? basisValue
            : 1;
    const normalizedFraction = value / basisPx;
    if (normalizedFraction <= smallMaxFraction) return 'small';
    if (normalizedFraction <= mediumMaxFraction) return 'medium';
    return 'large';
}

function objectKeyCount(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    return Object.keys(value as Record<string, unknown>).length;
}

function serializeNormalizedPaneSizeWithBasisKey(
    basisKey: string,
    smallMaxFraction: number,
    mediumMaxFraction: number,
) {
    return (value: number, record: Readonly<Record<string, unknown>>) =>
        bucketNormalizedPaneSize(value, record[basisKey], smallMaxFraction, mediumMaxFraction);
}

export const LOCAL_SETTING_DEFINITIONS = defineSettingDefinitions({
    debugMode: {
        schema: z.boolean(),
        default: false,
        description: 'Enable debug logging',
        storageScope: 'local',
    },
    devModeEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Enable developer menu in settings',
        storageScope: 'local',
    },
    commandPaletteEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Enable CMD+K command palette (web only)',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    themePreference: {
        schema: z.enum(['light', 'dark', 'adaptive']),
        default: 'adaptive',
        description: 'Theme preference: light, dark, or adaptive (follows system)',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    uiFontScale: {
        schema: z.number(),
        default: 1,
        description: 'In-app UI font scale multiplier (stacks with OS font scale)',
        storageScope: 'local',
        analytics: {
            trackCurrentState: false,
            trackChanges: false,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeDerivedProperties: (value: number) => ({
                uiFontScaleBucket:
                    value < 0.9
                        ? 'small'
                        : value <= 1.1
                            ? 'default'
                            : value <= 1.3
                                ? 'large'
                                : 'xlarge',
            }),
        },
    },
    uiItemDensity: {
        schema: z.enum(['comfortable', 'cozy', 'compact']),
        default: 'cozy',
        description: 'Preferred item density for Item-based UI rows',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    uiFontSize: {
        schema: z.enum(['xxsmall', 'xsmall', 'small', 'default', 'large', 'xlarge', 'xxlarge']).optional(),
        default: 'default',
        description: 'Deprecated: legacy in-app UI font size',
        storageScope: 'local',
    },
    sidebarCollapsed: {
        schema: z.boolean(),
        default: false,
        description: 'Collapse the permanent sidebar on tablets',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    sidebarWidthPx: {
        schema: z.number(),
        default: 320,
        description: 'Preferred sidebar width in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrentWithContext: serializeNormalizedPaneSizeWithBasisKey('sidebarWidthBasisPx', 0.25, 0.4),
        },
    },
    sidebarWidthBasisPx: {
        schema: z.number(),
        default: 1200,
        description: 'Container width basis for sidebar width scaling',
        storageScope: 'local',
    },
    uiMultiPanePanelsEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Enable multi-pane right/details panels (web/tablet)',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    sessionsRightPaneDefaultOpen: {
        schema: z.boolean(),
        default: false,
        description: 'Automatically open the right sidebar when entering a session (web/tablet)',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    detailsPaneTabsBehavior: {
        schema: z.enum(['preview', 'persistent']),
        default: 'preview',
        description: 'Details pane tab behavior: preview (single slot) or persistent',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    activityBadgesEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Enable app icon badges on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    activityBadgeShowUnread: {
        schema: z.boolean(),
        default: true,
        description: 'Include unread sessions in app icon badges',
        storageScope: 'local',
    },
    activityBadgeShowPendingPermissionRequests: {
        schema: z.boolean(),
        default: true,
        description: 'Include sessions with pending permission requests in app icon badges',
        storageScope: 'local',
    },
    activityBadgeShowPendingUserActionRequests: {
        schema: z.boolean(),
        default: true,
        description: 'Include sessions with pending user-action requests in app icon badges',
        storageScope: 'local',
    },
    activityBadgeShowQueuedUserInput: {
        schema: z.boolean(),
        default: true,
        description: 'Include sessions with queued user input in app icon badges',
        storageScope: 'local',
    },
    activityBadgeShowFriendRequestsInboxCount: {
        schema: z.boolean(),
        default: true,
        description: 'Include friend requests in the numeric app badge count',
        storageScope: 'local',
    },
    activityBadgeShowDesktopNonNumericDot: {
        schema: z.boolean(),
        default: true,
        description: 'Allow desktop dock dots for non-numeric inbox attention',
        storageScope: 'local',
    },
    localNotificationsEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Enable local notifications on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    localNotificationsShowReady: {
        schema: z.boolean(),
        default: true,
        description: 'Show local notifications for ready events on this device',
        storageScope: 'local',
    },
    localNotificationsShowReadyMessageText: {
        schema: z.boolean(),
        default: true,
        description: 'Include assistant message text in local ready notifications on this device',
        storageScope: 'local',
    },
    localNotificationsShowPendingPermissionRequests: {
        schema: z.boolean(),
        default: true,
        description: 'Show local notifications for permission requests on this device',
        storageScope: 'local',
    },
    localNotificationsShowPendingUserActionRequests: {
        schema: z.boolean(),
        default: true,
        description: 'Show local notifications for user-action requests on this device',
        storageScope: 'local',
    },
    localNotificationsForegroundBehavior: {
        schema: z.enum(['full', 'silent', 'off']),
        default: 'full',
        description: 'Foreground notification presentation on this device',
        storageScope: 'local',
    },
    editorFocusModeEnabled: {
        schema: z.boolean(),
        default: false,
        description: 'Hide main content + sidebar to focus on right/details panes (web/tablet)',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    rightPaneWidthPx: {
        schema: z.number(),
        default: 360,
        description: 'Preferred right pane dock width in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrentWithContext: serializeNormalizedPaneSizeWithBasisKey('rightPaneWidthBasisPx', 0.25, 0.4),
        },
    },
    rightPaneWidthBasisPx: {
        schema: z.number(),
        default: 1200,
        description: 'Container width basis for right pane width scaling',
        storageScope: 'local',
    },
    detailsPaneWidthPx: {
        schema: z.number(),
        default: 520,
        description: 'Preferred details pane dock width in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrentWithContext: serializeNormalizedPaneSizeWithBasisKey('detailsPaneWidthBasisPx', 0.25, 0.4),
        },
    },
    detailsPaneWidthBasisPx: {
        schema: z.number(),
        default: 1200,
        description: 'Container width basis for details pane width scaling',
        storageScope: 'local',
    },
    bottomPaneHeightPx: {
        schema: z.number(),
        default: 320,
        description: 'Preferred bottom pane dock height in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrentWithContext: serializeNormalizedPaneSizeWithBasisKey('bottomPaneHeightBasisPx', 0.25, 0.4),
        },
    },
    bottomPaneHeightBasisPx: {
        schema: z.number(),
        default: 900,
        description: 'Container height basis for bottom pane height scaling',
        storageScope: 'local',
    },
    embeddedTerminalDockLocation: {
        schema: z.enum(['sidebar', 'details', 'bottom']),
        default: 'bottom',
        description: 'Embedded terminal dock location',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    sessionsListStorageTab: {
        schema: z.enum(['persisted', 'direct']),
        default: 'persisted',
        description: 'Selected session list storage tab',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    acknowledgedCliVersions: {
        schema: z.record(z.string(), z.string()),
        default: {},
        description: 'Acknowledged CLI versions per machine',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: objectKeyCount,
        },
    },
});

export const LOCAL_SETTING_ARTIFACTS = buildSettingArtifacts(LOCAL_SETTING_DEFINITIONS);
