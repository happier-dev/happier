import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';
import {
    PET_COMPANION_POSITION_DEFAULT,
    PetCompanionStoredPositionSchema,
} from '@/sync/domains/pets/companionPosition/companionPosition';
import {
    PET_COMPANION_SIZE_SCALE_DEFAULT,
    normalizePetCompanionSizeScale,
} from '@/sync/domains/pets/companionSizeScale';
import {
    DEFAULT_THEME_PROFILES_LOCAL_STATE,
    ThemeProfilesLocalStateSchema,
} from '@/theme/profiles/themeProfilePersistence';
import { SessionListFocusedFolderV1Schema } from '@/sync/domains/session/folders';
import {
    DEFAULT_LOADING_INDICATOR_PAUSE_ID,
    DEFAULT_LOADING_INDICATOR_SPEED_ID,
    DEFAULT_LOADING_INDICATOR_STYLE_ID,
    LoadingIndicatorPauseIdSchema,
    LoadingIndicatorSpeedIdSchema,
    LoadingIndicatorStyleIdSchema,
} from './loadingIndicatorStyleSetting';
import {
    SESSION_LIST_FOLDER_SORT_MODE_DEFAULT_V1,
    SESSION_LIST_FOLDER_SORT_MODES_V1,
} from '@/sync/domains/session/listing/sessionListFolderSortMode';

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

function serializeNormalizedPaneSizeWithBasisKey(
    basisKey: string,
    smallMaxFraction: number,
    mediumMaxFraction: number,
) {
    return (value: number, record: Readonly<Record<string, unknown>>) =>
        bucketNormalizedPaneSize(value, record[basisKey], smallMaxFraction, mediumMaxFraction);
}

function objectKeyCount(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    return Object.keys(value as Record<string, unknown>).length;
}

function serializePetCompanionSizeScaleBucket(value: number): 'small' | 'default' | 'large' | 'xlarge' {
    const scale = normalizePetCompanionSizeScale(value);
    if (scale < 0.95) return 'small';
    if (scale <= 1.05) return 'default';
    if (scale <= 1.25) return 'large';
    return 'xlarge';
}

const PetEnabledOverrideSchema = z.enum(['inherit', 'enabled', 'disabled']);
const PetSelectedOverrideSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('inherit') }),
    z.object({
        kind: z.literal('detectedCodexHome'),
        sourceKey: z.string().min(1),
    }),
    z.object({
        kind: z.literal('happierManagedLocal'),
        sourceKey: z.string().min(1),
    }),
]);
const DesktopPetOverlayVisibilityModeOverrideSchema = z.enum([
    'inherit',
    'attentionOrActive',
    'alwaysWhenEnabled',
    'attentionOnly',
]);
const DesktopPetOverlayAnchorSchema = z.enum(['bottomRight', 'bottomLeft', 'topRight', 'topLeft']);
const DesktopPetOverlayOffsetSchema = z.object({
    x: z.number(),
    y: z.number(),
});
const PetCompanionSizeScaleSchema = z.number().catch(PET_COMPANION_SIZE_SCALE_DEFAULT);
const SessionMruOrderSchema = z.array(z.unknown())
    .transform((ids) => ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim()))
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
        description: 'Most recently used session order, stored as server-scoped session keys',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'count',
            privacy: 'count_only',
            identityScope: 'device_user',
            serializeCurrent: (value: readonly unknown[]) => value.length,
        },
    },
    collapsedGroupKeysV1: {
        schema: z.record(z.string(), z.boolean()).default({}),
        default: {},
        description: 'Collapsed state for session list groups on this device',
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
    sessionListFolderSortModeV1: {
        schema: z.enum(SESSION_LIST_FOLDER_SORT_MODES_V1).catch(SESSION_LIST_FOLDER_SORT_MODE_DEFAULT_V1),
        default: SESSION_LIST_FOLDER_SORT_MODE_DEFAULT_V1,
        description: 'Session list folder sort mode',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
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
    hapticsEnabled: {
        schema: z.boolean().catch(true),
        default: true,
        description: 'Enable haptic feedback on this device',
        storageScope: 'local',
    },
    systemTabBarEnabled: {
        // A malformed/newer value must not reset every other device preference.
        schema: z.boolean().catch(true),
        default: true,
        description: 'Show tabs in the system side rail on supported iOS windows',
        storageScope: 'local',
    },
    uiContentWidthMode: {
        schema: z.enum(['compact', 'medium', 'full']),
        default: 'compact',
        description: 'Preferred maximum width for main app content',
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
    loadingIndicatorStyle: {
        schema: LoadingIndicatorStyleIdSchema,
        default: DEFAULT_LOADING_INDICATOR_STYLE_ID,
        description: 'Which loading indicator spinners draw: a dotted Happier mark or H, or the classic ring',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    loadingIndicatorSpeed: {
        schema: LoadingIndicatorSpeedIdSchema,
        default: DEFAULT_LOADING_INDICATOR_SPEED_ID,
        description: 'How fast dot loading indicators play: slow, normal or fast',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    loadingIndicatorPause: {
        schema: LoadingIndicatorPauseIdSchema,
        default: DEFAULT_LOADING_INDICATOR_PAUSE_ID,
        description: 'How long dot loading indicators rest between loops: none, short or long',
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
    localNotificationsShowRequestMessageText: {
        schema: z.boolean(),
        default: true,
        description: 'Include permission commands and questions in local request notifications on this device',
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
    petsEnabledOverride: {
        schema: PetEnabledOverrideSchema,
        default: 'inherit',
        description: 'Device override for pet companion enablement',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    petsSelectedPetOverride: {
        schema: PetSelectedOverrideSchema,
        default: { kind: 'inherit' },
        description: 'Device-only pet package override',
        storageScope: 'local',
    },
    petsCompanionPosition: {
        schema: PetCompanionStoredPositionSchema,
        default: PET_COMPANION_POSITION_DEFAULT,
        description: 'Versioned normalized app-shell pet companion position on this device',
        storageScope: 'local',
    },
    petsDismissedCompanionTrayItemKeys: {
        schema: z.array(z.string().min(1)).catch([]),
        default: [],
        description: 'Device-local dismissed pet companion activity bubble keys',
        storageScope: 'local',
    },
    petsCompanionSizeScale: {
        schema: PetCompanionSizeScaleSchema,
        default: PET_COMPANION_SIZE_SCALE_DEFAULT,
        description: 'Device-local size multiplier for pet companion surfaces',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrent: serializePetCompanionSizeScaleBucket,
        },
    },
    petsDetectCodexPets: {
        schema: z.boolean(),
        default: true,
        description: 'Discover Codex pet packages from local Codex homes on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopAlwaysMoveDefaultFollowingService: {
        schema: z.boolean(),
        default: false,
        description: 'Move this device\u2019s default-following background service with the selected default relay without asking',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopKeptBackgroundService: {
        schema: z.object({ relayKey: z.string().min(1), accountId: z.string().min(1).nullable() }).nullable().catch(null),
        default: null,
        description: 'The background service this device chose to keep as it is: its relay and account (D5)',
        storageScope: 'local',
    },
    desktopPetOverlayEnabledOverride: {
        schema: PetEnabledOverrideSchema,
        default: 'inherit',
        description: 'Device override for desktop pet overlay enablement',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopPetOverlayVisibilityModeOverride: {
        schema: DesktopPetOverlayVisibilityModeOverrideSchema,
        default: 'inherit',
        description: 'Device override for desktop pet overlay visibility mode',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopPetOverlayAnchor: {
        schema: DesktopPetOverlayAnchorSchema,
        default: 'bottomRight',
        description: 'Desktop pet overlay anchor on this device',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    desktopPetOverlayOffset: {
        schema: DesktopPetOverlayOffsetSchema,
        default: { x: 0, y: 0 },
        description: 'Desktop pet overlay offset from the selected anchor on this device',
        storageScope: 'local',
    },
    desktopPetOverlayLocked: {
        schema: z.boolean(),
        default: false,
        description: 'Lock desktop pet overlay dragging on this device',
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
    sessionLastMobileSurfaceBySessionId: {
        schema: z.record(z.string(), z.enum(['chat', 'browse', 'git', 'navigation', 'tabs', 'terminal'])).default({}),
        default: {},
        description: 'Last active mobile session surface by server-scoped session key, with legacy bare session ids accepted for compatibility',
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
    sessionComposerCollapsedBannerKinds: {
        schema: z.record(z.string(), z.boolean()).default({}),
        default: {},
        description: 'Composer banner kinds collapsed on this device, honored only while sessionComposerRememberBannerVisibility is enabled',
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
