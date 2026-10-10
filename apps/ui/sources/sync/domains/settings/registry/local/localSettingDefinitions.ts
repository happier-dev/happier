import { buildSettingArtifacts } from '@happier-dev/protocol/settings/registry/buildSettingArtifacts';
import { defineSettingDefinitions } from '@happier-dev/protocol/settings/registry/settingDefinition';
import {
    buildUiSurfaceExecutableApprovalKeyStringV1,
    createUiSurfaceRequestedCapabilitiesDigestV1,
    UiSurfaceExecutableApprovalKeyV1Schema,
} from '@happier-dev/protocol/plugins/contributions/ui/executableSurfaceApprovalV1';
import {
    normalizeUiSurfaceCapabilityRequestV1,
    UiSurfaceCapabilityRequestV1Schema,
} from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import {
    DEFAULT_HAPPIER_SPINNER_PAUSE_ID,
    DEFAULT_HAPPIER_SPINNER_SPEED_ID,
    DEFAULT_HAPPIER_SPINNER_STYLE_ID,
    HAPPIER_SPINNER_PAUSE_IDS,
    HAPPIER_SPINNER_SPEED_IDS,
    HAPPIER_SPINNER_STYLE_IDS,
} from '@happier-dev/plugin-ui/presentation';
import { z } from 'zod';
import { ACTIVITY_SURFACE_LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions.activitySurfaces';
import { LAYOUT_LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions.layout';
import { serializeNormalizedPaneSizeWithBasisKey } from './localSettingDefinitions.shared';
import {
    DEFAULT_THEME_PROFILES_LOCAL_STATE,
    ThemeProfilesLocalStateSchema,
} from '@/theme/profiles/themeProfilePersistence';
import { SessionListFocusedFolderV1Schema } from '@/sync/domains/session/folders/types';

const SessionMruOrderSchema = z.array(z.unknown())
    .transform((values) => values
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim()))
    .catch([]);

const UiSurfaceExecutableApprovalSchema = z.object({
    approval: UiSurfaceExecutableApprovalKeyV1Schema,
    capabilities: UiSurfaceCapabilityRequestV1Schema.transform((request, ctx) => {
        const normalized = normalizeUiSurfaceCapabilityRequestV1(request);
        if (normalized) return normalized;
        ctx.addIssue({ code: 'custom', message: 'Invalid reviewed surface capabilities' });
        return z.NEVER;
    }),
}).strict();

// Historical booleans prove only their exact key. New approvals retain the
// reviewed request so a strictly narrower request can reuse the same consent.
const UiSurfaceExecutableApprovalsSchema = z.record(
    z.string().min(1),
    z.union([z.literal(true), UiSurfaceExecutableApprovalSchema]),
).refine((entries) => Object.entries(entries).every(([key, entry]) => entry === true || (
    key === buildUiSurfaceExecutableApprovalKeyStringV1(entry.approval)
    && entry.approval.requestedCapabilitiesDigest === createUiSurfaceRequestedCapabilitiesDigestV1(entry.capabilities)
)), { message: 'Surface approval must match its reviewed scope and capabilities' });

const localSettingInputs = {
    hideConnectedAccountIdentities: {
        schema: z.boolean().catch(false),
        default: false,
        description: 'Hide connected account identities on this device',
        storageScope: 'local',
    },
    homeApplicationCarrierEligibility: {
        schema: z.enum(['automatic', 'standard_only']).catch('standard_only'),
        default: 'automatic',
        description: 'Application carrier selection for Homes on this device',
        storageScope: 'local',
    },
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
    connectedServicesIndexViewV1: {
        // List (default, lines limits up across accounts) or Grid, for Connected services on this device.
        schema: z.enum(['list', 'grid']).catch('list'),
        default: 'list',
        description: 'Whether Connected services lists its accounts or shows them as cards on this device',
        storageScope: 'local',
    },
    artifactsBrowserViewV1: {
        // Grid, List or Folders for the Artifacts browser on this device; unset follows the device (phones list, else grid).
        schema: z.object({ presentation: z.enum(['grid', 'list', 'folders']).optional() }).catch({}),
        default: {},
        description: 'Whether the Artifacts browser shows cards, a list or the folder tree on this device',
        storageScope: 'local',
    },
    pluginsCollectionViewV1: {
        // Grid (default) or List, remembered per Plugins view on this device.
        schema: z.object({
            installed: z.enum(['grid', 'list']).optional(),
            discover: z.enum(['grid', 'list']).optional(),
        }).catch({}),
        default: {},
        description: 'Whether the Plugins Installed and Browse views show a grid or a list on this device',
        storageScope: 'local',
    },
    collapsedGroupKeysV1: {
        schema: z.record(z.string(), z.boolean()).default({}),
        default: {},
        description: 'Collapsed state for session list groups on this device',
        storageScope: 'local',
    },
    homesReconcileAcknowledgedHomeIds: {
        schema: z.array(z.string().min(1)).catch([]),
        default: [],
        description: 'Homes whose "Your Homes are connected" choice this device has settled (Keep both / Use …)',
        storageScope: 'local',
    },
    personalizeProgressV1: {
        // Visit memory for Home's "Personalize Happier" card: the steps saved on this device and where
        // to pick up. Ids are normalized by the Personalize owner; the choices themselves live in
        // their own settings. Never Account-synced.
        schema: z.object({
            savedSteps: z.array(z.string()).catch([]),
            resumeAt: z.string().nullable().catch(null),
        }).catch({ savedSteps: [], resumeAt: null }),
        default: { savedSteps: [], resumeAt: null },
        description: 'Where this device left off in Personalize Happier (steps saved, page to resume at)',
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
    loadingIndicatorStyle: {
        // `.catch` matters: `localSettingsParse` resets EVERY local setting when one field fails to
        // parse, so a style id written by a newer build (or removed later) must degrade to the
        // default rather than wipe the user's other preferences.
        schema: z.enum(HAPPIER_SPINNER_STYLE_IDS).catch(DEFAULT_HAPPIER_SPINNER_STYLE_ID),
        default: DEFAULT_HAPPIER_SPINNER_STYLE_ID,
        description: 'Which loading indicator spinners draw: a dotted Happier mark or H, or the classic ring',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    loadingIndicatorSpeed: {
        // `.catch` for the same reason as the style: an unknown value must not reset other settings.
        schema: z.enum(HAPPIER_SPINNER_SPEED_IDS).catch(DEFAULT_HAPPIER_SPINNER_SPEED_ID),
        default: DEFAULT_HAPPIER_SPINNER_SPEED_ID,
        description: 'How fast dot loading indicators play: slow, normal or fast',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    loadingIndicatorPause: {
        schema: z.enum(HAPPIER_SPINNER_PAUSE_IDS).catch(DEFAULT_HAPPIER_SPINNER_PAUSE_ID),
        default: DEFAULT_HAPPIER_SPINNER_PAUSE_ID,
        description: 'How long dot loading indicators rest between loops: none, short or long',
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
    titleStripThemeToggleVisible: {
        schema: z.boolean(),
        default: true,
        description: 'Show the light/dark switch in the window toolbar on tablets and desktops',
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
    uiSurfaceExecutableApprovalsV1: {
        schema: UiSurfaceExecutableApprovalsSchema,
        default: {},
        description: 'Viewer-local approvals for exact executable UI surface fingerprints',
        storageScope: 'local',
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
    deviceRemoteAlertsEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Receive enrolled remote session alerts on this device when the Account opts in',
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
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    ...ACTIVITY_SURFACE_LOCAL_SETTING_DEFINITIONS,
    ...LAYOUT_LOCAL_SETTING_DEFINITIONS,
} as const;

export const LOCAL_SETTING_DEFINITIONS: ReturnType<typeof defineSettingDefinitions<typeof localSettingInputs>> = defineSettingDefinitions(localSettingInputs);

export const LOCAL_SETTING_ARTIFACTS: ReturnType<typeof buildSettingArtifacts<typeof LOCAL_SETTING_DEFINITIONS>> = buildSettingArtifacts(LOCAL_SETTING_DEFINITIONS);
