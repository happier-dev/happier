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
    ThemeProfilesLocalStateSchema,
} from '@/theme/profiles/themeProfilePersistence';
import { SessionListFocusedFolderV1Schema } from '@/sync/domains/session/folders/types';
import { MachineStorageViewMapSchema } from './machineStorageViewSetting';

const localSettingInputs = {
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
    },    sessionListFocusedFolderV1: {
        schema: SessionListFocusedFolderV1Schema,
        default: null,
        description: 'Focused session folder navigation state for the local session list',
        storageScope: 'local',
    },
    connectedServicesIndexViewV1: {
        // List (default, lines limits up across accounts) or Grid, for Connected services on this device.
        schema: z.catch(z.enum(['list', 'grid']), 'list'),
        default: 'list',
        description: 'Whether Connected services lists its accounts or shows them as cards on this device',
        storageScope: 'local',
    },
    machinesRailSeenV1: {
        // What this device has already seen of the machines' "worth a look" reasons and guard actions (R4):
        // written when the Machines popover opens, so the rail dot returns only for a new or worse reason.
        schema: z.catch(z.object({
            look: z.catch(z.record(z.string(), z.array(z.string())), {}),
            guardSeenAt: z.catch(z.number(), 0),
        }), { look: {}, guardSeenAt: 0 }),
        default: { look: {}, guardSeenAt: 0 },
        description: 'Machine attention reasons and guard actions this device has already seen in the Machines popover',
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
    machineVitalsRangeV1: {
        // The history a machine's Overview charts on this device: the last hour (default), day or week.
        schema: z.catch(z.enum(['1h', '24h', '7d']), '1h'),
        default: '1h',
        description: 'How much history a machine Overview charts on this device: 1 hour, 24 hours or 7 days',
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
    },    homesReconcileAcknowledgedHomeIds: {
        schema: z.catch(z.array(z.string().check(z.minLength(1))), []),
        default: [],
        description: 'Homes whose "Your Homes are connected" choice this device has settled (Keep both / Use …)',
        storageScope: 'local',
    },
    personalizeProgressV1: {
        // Visit memory for Home's "Personalize Happier" card: the steps saved on this device and where
        // to pick up. Ids are normalized by the Personalize owner; the choices themselves live in
        // their own settings. Never Account-synced.
        schema: z.catch(z.object({
            savedSteps: z.catch(z.array(z.string()), []),
            resumeAt: z.catch(z.nullable(z.string()), null),
        }), { savedSteps: [], resumeAt: null }),
        default: { savedSteps: [], resumeAt: null },
        description: 'Where this device left off in Personalize Happier (steps saved, page to resume at)',
        storageScope: 'local',
    },
    brandHeroSeenAt: {
        schema: z.catch(z.nullable(z.number()), null),
        default: null,
        description: 'Timestamp in ms since epoch when the user first dismissed the mobile brand hero',
        storageScope: 'local',
    },
    homeWelcomeSeenAt: {
        // Welcome (Home atmosphere R-11): the planet assembles once, on the first arrival at Home after
        // sign-in on this device. Never Account-synced and never cleared on logout.
        schema: z.catch(z.nullable(z.number()), null),
        default: null,
        description: 'Timestamp in ms since epoch when Home first played its Welcome planet on this device',
        storageScope: 'local',
    },
    skillsFirstRunDecidedAt: {
        schema: z.catch(z.nullable(z.number()), null),
        default: null,
        description: 'When this device chose or dismissed the initial Skills checklist',
        storageScope: 'local',
    },
    mcpFirstVisitDismissedAt: {
        schema: z.catch(z.nullable(z.number()), null),
        default: null,
        description: 'When this device dismissed the MCP servers first-visit line ("Your servers now follow you")',
        storageScope: 'local',
    },
    projectSkillsMigrationNoteSeenAt: {
        schema: z.catch(z.nullable(z.number()), null),
        default: null,
        description: 'When this device dismissed the Project → Context note about skills and MCP servers moved from older project settings',
        storageScope: 'local',
    },
    dismissedFailedApprovalsV1: {
        // Approval artifact id -> when this device dismissed its failed-effect card from the composer. Presentation only.
        schema: z.catch(z.record(z.string(), z.number()), {}),
        default: {},
        description: 'Failed approvals this device dismissed from the composer attention tray, by approval artifact id',
        storageScope: 'local',
    },
    hasCompletedAuthOnce: {
        schema: z.catch(z.boolean(), false),
        default: false,
        description: 'Flips true the first time the user reaches an authenticated state on this device. Never cleared on logout, so the welcome screen can greet returning users with a warmer copy variant ("Good to have you back").',
        storageScope: 'local',
    },
    hapticsEnabled: {
        schema: z.catch(z.boolean(), true),
        default: true,
        description: 'Enable haptic feedback on this device',
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
