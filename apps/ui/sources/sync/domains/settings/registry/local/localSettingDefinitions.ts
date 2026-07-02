import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';
import { ACTIVITY_SURFACE_LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions.activitySurfaces';
import { LAYOUT_LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions.layout';
import { serializeNormalizedPaneSizeWithBasisKey } from './localSettingDefinitions.shared';
import {
    DEFAULT_THEME_PROFILES_LOCAL_STATE,
    ThemeProfilesLocalStateSchema,
} from '@/theme/profiles/themeProfilePersistence';
import { SessionListFocusedFolderV1Schema } from '@/sync/domains/session/folders';

const SessionMruOrderSchema = z.array(z.unknown())
    .transform((values) => values
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim()))
    .catch([]);

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
    sessionMruOrderV1: {
        schema: SessionMruOrderSchema,
        default: [],
        description: 'Local most-recently-used session navigation order',
        storageScope: 'local',
    },
    sessionListFocusedFolderV1: {
        schema: SessionListFocusedFolderV1Schema,
        default: null,
        description: 'Focused session folder navigation state for the local session list',
        storageScope: 'local',
    },
    brandHeroSeenAt: {
        schema: z.number().nullable().catch(null),
        default: null,
        description: 'Timestamp in ms since epoch when the user first dismissed the mobile brand hero',
        storageScope: 'local',
    },
    hasCompletedAuthOnce: {
        schema: z.boolean().catch(false),
        default: false,
        description: 'Flips true the first time the user reaches an authenticated state on this device. Never cleared on logout, so the welcome screen can greet returning users with a warmer copy variant ("Good to have you back").',
        storageScope: 'local',
    },
    themePreference: {
        schema: z.enum(['light', 'dark', 'adaptive']),
        default: 'adaptive',
        description: 'Theme preference: light, dark, or adaptive (follows system)',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    themeProfiles: {
        schema: ThemeProfilesLocalStateSchema,
        default: DEFAULT_THEME_PROFILES_LOCAL_STATE,
        description: 'Local custom theme profiles and active profile selection',
        storageScope: 'local',
    },
    uiBackdropBlurEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Enable backdrop blur effects behind modals and overlay menus',
        storageScope: 'local',
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
            serializeCurrentWithContext: serializeNormalizedPaneSizeWithBasisKey('sidebarWidthBasisPx', 1200, 0.25, 0.4),
        },
    },
    sidebarWidthBasisPx: {
        schema: z.number(),
        default: 1200,
        description: 'Container width basis for sidebar width scaling',
        storageScope: 'local',
    },
    settingsNavSidebarEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Enable the settings navigation sidebar on tablet/desktop layouts',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    settingsNavSidebarWidthPx: {
        schema: z.number(),
        default: 230,
        description: 'Preferred settings navigation sidebar width in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrentWithContext: serializeNormalizedPaneSizeWithBasisKey('settingsNavSidebarWidthBasisPx', 1200, 0.2, 0.35),
        },
    },
    settingsNavSidebarWidthBasisPx: {
        schema: z.number(),
        default: 1200,
        description: 'Container width basis for settings navigation sidebar width scaling',
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
    sessionGettingStartedGuidanceDismissed: {
        schema: z.boolean(),
        default: false,
        description: 'Suppress the “set up a computer” empty-state guidance after the setup wizard was dismissed once',
        storageScope: 'local',
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
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    ...ACTIVITY_SURFACE_LOCAL_SETTING_DEFINITIONS,
    ...LAYOUT_LOCAL_SETTING_DEFINITIONS,
});

export const LOCAL_SETTING_ARTIFACTS = buildSettingArtifacts(LOCAL_SETTING_DEFINITIONS);
