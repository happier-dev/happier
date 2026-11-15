import { buildSettingArtifacts } from '@happier-dev/protocol/settings/registry/buildSettingArtifacts';
import { defineSettingDefinitions } from '@happier-dev/protocol/settings/registry/settingDefinition';
import {
    DEFAULT_HAPPIER_SPINNER_PAUSE_ID,
    DEFAULT_HAPPIER_SPINNER_SPEED_ID,
    DEFAULT_HAPPIER_SPINNER_STYLE_ID,
    HAPPIER_SPINNER_PAUSE_IDS,
    HAPPIER_SPINNER_SPEED_IDS,
    HAPPIER_SPINNER_STYLE_IDS,
} from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_COLLECTION_RAIL_WIDTH_PX } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { z } from 'zod/mini';
import { ACTIVITY_SURFACE_LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions.activitySurfaces';
import { LAYOUT_LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions.layout';
import { FILES_LOCAL_SETTING_DEFINITIONS } from './localSettingDefinitions.files';
import { serializePaneSizePxBucket } from './localSettingDefinitions.shared';
import {
    DEFAULT_THEME_PROFILES_LOCAL_STATE,
    ThemeProfileDeviceSelectionSchema,
    ThemeProfilesLocalStateSchema,
} from '@/theme/profiles/themeProfilePersistence';
import { MachineStorageViewMapSchema } from './machineStorageViewSetting';

const localSettingInputs = {
    chatLinkOpenLocation: {
        schema: z.catch(z.enum(['browser', 'embedded', 'managed']), 'browser'),
        default: 'browser',
        description: 'Where links from chats open on this device',
        storageScope: 'local',
    },
    composerKeepFocusAfterSend: {
        // null follows the device: keep focus with a hardware keyboard, close the soft keyboard otherwise.
        schema: z.nullable(z.boolean()),
        default: null,
        description: 'Whether the session composer stays focused after sending a message',
        storageScope: 'local',
    },
    composerTypeToFocusEnabled: {
        schema: z.catch(z.boolean(), true),
        default: true,
        description: 'Typing outside a text field on web moves into the session composer',
        storageScope: 'local',
    },
    screenCaptureSound: {
        schema: z.catch(z.boolean(), true),
        default: true,
        description: 'Play a confirmation sound when capturing on this device',
        storageScope: 'local',
    },
    screenCaptureIncludeWindowText: {
        schema: z.catch(z.boolean(), false),
        default: false,
        description: 'Include whole-window text with captures by default on this device',
        storageScope: 'local',
    },
    filesTrackAgentEdits: {
        schema: z.catch(z.boolean(), false),
        default: false,
        description: 'Follow the file and region the agent is editing on this device',
        storageScope: 'local',
    },
    hideConnectedAccountIdentities: {
        schema: z.catch(z.boolean(), false),
        default: false,
        description: 'Hide connected account identities on this device',
        storageScope: 'local',
    },
    homeApplicationCarrierEligibility: {
        schema: z.catch(z.enum(['automatic', 'standard_only']), 'standard_only'),
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
    connectedServicesIndexViewV1: {
        // Cards (default, owner R7 2026-11-09, desktop and phone) or List, for Connected services on this device.
        schema: z.catch(z.enum(['list', 'grid']), 'grid'),
        default: 'grid',
        description: 'Whether Connected services lists its accounts or shows them as cards on this device',
        storageScope: 'local',
    },
    machinesIndexViewV1: {
        // List (default, a table of machines) or Grid (one card per machine) for All machines on this device.
        schema: z.catch(z.enum(['list', 'grid']), 'list'),
        default: 'list',
        description: 'Whether All machines shows a table of machines or one card per machine on this device',
        storageScope: 'local',
    },
    uiMachineSummaryStyle: {
        // How the Machine summary draws each machine's instruments (popover, machine list, All machines → List).
        schema: z.catch(z.enum(['sparklines', 'bars', 'numbers', 'rings']), 'sparklines'),
        default: 'sparklines',
        description: 'The Machine summary style on this device: sparklines, bars, numbers or rings',
        storageScope: 'local',
    },
    uiMachineSummaryMetrics: {
        // The shown metrics, in canonical order (`normalizeMachineSummaryMetrics`); none shown is a valid choice.
        schema: z.catch(z.array(z.enum(['cpu', 'memory', 'disk', 'network'])), ['cpu', 'memory', 'disk']),
        default: ['cpu', 'memory', 'disk'],
        description: 'Which metrics the Machine summary shows on this device (none: machine names only)',
        storageScope: 'local',
    },
    machineStorageViewV1: {
        // Whole disk on this device, per machine (Home + machine id): List (default) · Map · Rings and the list's sort.
        schema: MachineStorageViewMapSchema,
        default: {},
        description: 'How Storage → Whole disk shows a folder on this device, per machine: list, map or rings, and the list sort',
        storageScope: 'local',
    },
    artifactsBrowserViewV1: {
        // Grid, List or Folders for the Artifacts browser on this device; unset follows the device (phones list, else grid).
        schema: z.catch(z.object({ presentation: z.optional(z.enum(['grid', 'list', 'folders'])) }), {}),
        default: {},
        description: 'Whether the Artifacts browser shows cards, a list or the folder tree on this device',
        storageScope: 'local',
    },
    pluginsCollectionViewV1: {
        // Grid (default) or List, remembered per Plugins view on this device.
        schema: z.catch(z.object({
            installed: z.optional(z.enum(['grid', 'list'])),
            discover: z.optional(z.enum(['grid', 'list'])),
        }), {}),
        default: {},
        description: 'Whether the Plugins Installed and Browse views show a grid or a list on this device',
        storageScope: 'local',
    },
    hapticsEnabled: {
        schema: z.catch(z.boolean(), true),
        default: true,
        description: 'Enable haptic feedback on this device',
        storageScope: 'local',
    },
    systemTabBarEnabled: {
        schema: z.catch(z.boolean(), true),
        default: true,
        description: 'Present tabs in the system side rail on this device when available',
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
        schema: z.catch(z.enum(HAPPIER_SPINNER_STYLE_IDS), DEFAULT_HAPPIER_SPINNER_STYLE_ID),
        default: DEFAULT_HAPPIER_SPINNER_STYLE_ID,
        description: 'Which loading indicator spinners draw: a dotted Happier mark or H, or the classic ring',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    loadingIndicatorSpeed: {
        // `.catch` for the same reason as the style: an unknown value must not reset other settings.
        schema: z.catch(z.enum(HAPPIER_SPINNER_SPEED_IDS), DEFAULT_HAPPIER_SPINNER_SPEED_ID),
        default: DEFAULT_HAPPIER_SPINNER_SPEED_ID,
        description: 'How fast dot loading indicators play: slow, normal or fast',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    loadingIndicatorPause: {
        schema: z.catch(z.enum(HAPPIER_SPINNER_PAUSE_IDS), DEFAULT_HAPPIER_SPINNER_PAUSE_ID),
        default: DEFAULT_HAPPIER_SPINNER_PAUSE_ID,
        description: 'How long dot loading indicators rest between loops: none, short or long',
        storageScope: 'local',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'device_user' },
    },
    themeProfiles: {
        schema: ThemeProfilesLocalStateSchema,
        default: DEFAULT_THEME_PROFILES_LOCAL_STATE,
        description: 'Legacy device theme library retained until account migration succeeds',
        storageScope: 'local',
    },
    themeProfileSelection: {
        schema: z.nullable(ThemeProfileDeviceSelectionSchema),
        default: null,
        description: 'Active light and dark theme profile IDs on this device',
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
        schema: z.optional(z.enum(['xxsmall', 'xsmall', 'small', 'default', 'large', 'xlarge', 'xxlarge'])),
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
        default: HAPPIER_COLLECTION_RAIL_WIDTH_PX.standard,
        description: 'Preferred sidebar width in px',
        storageScope: 'local',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'bucket',
            privacy: 'bucketed',
            identityScope: 'device_user',
            serializeCurrent: serializePaneSizePxBucket(300, 480),
        },
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
            serializeCurrent: serializePaneSizePxBucket(240, 420),
        },
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
    ...FILES_LOCAL_SETTING_DEFINITIONS,
} as const;

export const LOCAL_SETTING_DEFINITIONS: ReturnType<typeof defineSettingDefinitions<typeof localSettingInputs>> = defineSettingDefinitions(localSettingInputs);

export const LOCAL_SETTING_ARTIFACTS: ReturnType<typeof buildSettingArtifacts<typeof LOCAL_SETTING_DEFINITIONS>> = buildSettingArtifacts(LOCAL_SETTING_DEFINITIONS);
