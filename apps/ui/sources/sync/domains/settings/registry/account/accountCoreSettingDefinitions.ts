import {
    DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
    DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE,
    DEFAULT_USAGE_LIMIT_RECOVERY_SETTINGS_V1,
    SessionPendingQueueDeliveryTimingSchema,
    DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME,
    SessionPendingQueueDrainModeSchema,
    UsageLimitRecoverySettingsV1Schema as ProtocolUsageLimitRecoverySettingsV1Schema,
    buildSettingArtifacts,
    defineSettingDefinitions,
} from '@happier-dev/protocol';
import { z } from 'zod';
import { AvatarStyleIdSchema, DEFAULT_AVATAR_STYLE_ID } from './avatarStyleSetting';
import { SessionFolderViewModeV1Schema } from '@/sync/domains/session/folders';
import {
    SESSION_LIST_ATTENTION_PROMOTION_MODE_VALUES,
    SESSION_LIST_WORKING_PLACEMENT_MODE_VALUES,
} from '@/sync/domains/session/listing/attentionPromotion/sessionListAttentionPromotionTypes';
import {
    SESSION_LIST_ORDERING_MODE_DEFAULT_V1,
    SESSION_LIST_ORDERING_MODES_V1,
} from '@/sync/domains/session/listing/sessionListOrderingRules';

export const SessionListDensitySchema = z.preprocess((raw) => {
    if (raw === 'compact') return 'cozy';
    return raw;
}, z.enum(['detailed', 'cozy', 'narrow']));
export const SessionListIdentityDisplaySchema = z.enum(['avatar', 'agentLogo', 'none']);

export const SessionMessageSendModeSchema = z.enum(['agent_queue', 'interrupt', 'server_pending']);
export const SessionBusySteerSendPolicySchema = z.enum(['steer_immediately', 'server_pending']);
export const SessionNonSteerableSendPromptSchema = z.enum(['ask', 'queue_silently', 'off']);
export const UsageLimitRecoverySettingsV1Schema = ProtocolUsageLimitRecoverySettingsV1Schema;

export const ACCOUNT_CORE_SETTING_DEFINITIONS = defineSettingDefinitions({
    analyticsOptOut: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to opt out of anonymous analytics',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    crashReportsOptOut: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to opt out of crash reports and error telemetry',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    experiments: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to enable experimental features',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    useEnhancedSessionWizard: {
        schema: z.boolean(),
        default: false,
        description: 'A/B test flag: Use enhanced profile-based session wizard UI',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    sessionReplayEnabled: {
        schema: z.boolean(),
        // Default ON. Replay is the only fork strategy available to an Agent
        // whose provider declares `sessionFork: unsupported` (Claude Code,
        // among others), and the fork gate is `native || replay` — so
        // defaulting this off removed the fork affordance entirely for exactly
        // the sessions this setting exists to serve. The same machinery is
        // already default-on for the in-place Agent switch. A user can still
        // turn it off.
        default: true,
        description: 'Enable app-level transcript replay for sessions that cannot be vendor-resumed',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    useProfiles: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to enable AI backend profiles feature',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    sessionPermissionModeApplyTiming: {
        schema: z.enum(['immediate', 'next_prompt']),
        default: 'immediate',
        description: 'When to apply permission mode changes for a running session',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionUseTmux: {
        schema: z.boolean(),
        default: false,
        description: 'Whether new sessions should start in tmux by default',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    sessionWindowsRemoteSessionLaunchMode: {
        schema: z.enum(['hidden', 'windows_terminal', 'console']),
        default: 'hidden',
        description: 'Default Windows remote session host mode for new sessions',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionWindowsTerminalWindowName: {
        schema: z.string(),
        default: DEFAULT_WINDOWS_TERMINAL_WINDOW_NAME,
        description: 'Named Windows Terminal window used for Windows remote sessions',
        storageScope: 'account',
    },
    useMachinePickerSearch: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to show search in machine picker UIs',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    usePathPickerSearch: {
        schema: z.boolean(),
        default: false,
        description: 'Whether to show search in path picker UIs',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    agentInputEnterToSend: {
        schema: z.boolean(),
        default: true,
        description: 'Whether pressing Enter submits/sends in the agent input (web)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    agentInputEnterToSendNative: {
        schema: z.boolean(),
        default: false,
        description: 'Whether pressing Enter submits/sends in the agent input (native)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    alwaysShowContextSize: {
        schema: z.boolean(),
        default: true,
        description: 'Always show context size in agent input',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    sessionComposerRememberBannerVisibility: {
        schema: z.boolean(),
        default: false,
        description: 'Remember collapsed composer banners globally across sessions instead of per session view',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    agentInputHistoryScope: {
        schema: z.enum(['perSession', 'global']),
        default: 'perSession',
        description: 'Whether web arrow-key history should cycle per-session or globally',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    agentInputActionBarLayout: {
        schema: z.enum(['auto', 'wrap', 'scroll', 'collapsed']),
        default: 'auto',
        description: 'Agent input action bar layout',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    agentInputChipDensity: {
        schema: z.enum(['auto', 'labels', 'icons']),
        default: 'auto',
        description: 'Agent input action chip density',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionListDensity: {
        schema: SessionListDensitySchema,
        default: 'narrow',
        description: 'Session list density: detailed (full), cozy (smaller), narrow (minimal)',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'person',
            derivedPropertyValueKinds: {
                compact_session_view: 'boolean',
                compact_session_view_minimal: 'boolean',
            },
            serializeDerivedProperties: (value: 'detailed' | 'cozy' | 'narrow') => ({
                compact_session_view: value === 'cozy' || value === 'narrow',
                compact_session_view_minimal: value === 'narrow',
            }),
        },
    },
    sessionListIdentityDisplay: {
        schema: SessionListIdentityDisplaySchema,
        default: 'agentLogo',
        description: 'Session list identity marker: generated avatar, agent logo, or none',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionHeaderIdentityDisplay: {
        // Same three choices, same schema as the session list's marker: the in-session header asks
        // the user the identical question, so it must not invent a second vocabulary for it.
        schema: SessionListIdentityDisplaySchema,
        default: 'avatar',
        description: 'In-session header identity marker: generated avatar, agent logo, or none',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionFolderViewModeV1: {
        schema: SessionFolderViewModeV1Schema,
        default: 'off',
        description: 'Session folder display mode for the session list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionListOrderingModeV1: {
        schema: z.enum(SESSION_LIST_ORDERING_MODES_V1),
        default: SESSION_LIST_ORDERING_MODE_DEFAULT_V1,
        description: 'Session list ordering mode',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    workspacePathDisplayModeV1: {
        schema: z.enum(['name', 'path']),
        default: 'name',
        description: 'How workspace paths are displayed in the session list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    workspaceFaviconsEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Show detected workspace favicons in the session list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    workspaceMachineSubtitlesEnabled: {
        schema: z.boolean(),
        default: true,
        description: 'Show machine names below workspace names in the session list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    showEnvironmentBadge: {
        schema: z.boolean(),
        default: true,
        description: 'Show current app environment badge near the sidebar title',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    showFlavorIcons: {
        schema: z.boolean(),
        default: true,
        description: 'Whether to show AI provider icons in avatars',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    avatarStyle: {
        schema: AvatarStyleIdSchema,
        default: DEFAULT_AVATAR_STYLE_ID,
        description: 'Avatar display style',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    hideInactiveSessions: {
        schema: z.boolean(),
        default: false,
        description: 'Hide inactive sessions in the main list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    groupInactiveSessionsByProject: {
        schema: z.boolean(),
        default: false,
        description: 'Group inactive sessions by project in the main list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    sessionListActiveGroupingV1: {
        schema: z.enum(['project', 'date']),
        default: 'project',
        description: 'How to group active sessions in the session list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionListInactiveGroupingV1: {
        schema: z.enum(['project', 'date']),
        default: 'date',
        description: 'How to group inactive sessions in the session list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionListSectionModeV1: {
        schema: z.enum(['activity', 'single']),
        default: 'activity',
        description: 'Whether the session list separates active and inactive sessions or shows one combined section',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionListActiveColorModeV1: {
        schema: z.enum(['activityAndAttention', 'attentionOnly', 'allActive']),
        default: 'activityAndAttention',
        description: 'Which session rows use the active title color in the session list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionListAttentionPromotionModeV1: {
        schema: z.enum(SESSION_LIST_ATTENTION_PROMOTION_MODE_VALUES),
        default: 'off',
        description: 'Where sessions waiting for the user or ready to review appear in the session list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionListAttentionStandingDefaultV1: {
        schema: z.boolean(),
        default: false,
        description: 'Whether sessions stay in the session list attention section until the user removes them',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    sessionListWorkingPlacementModeV1: {
        schema: z.enum(SESSION_LIST_WORKING_PLACEMENT_MODE_VALUES),
        default: 'off',
        description: 'Where currently working sessions appear in the session list',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionListSeparateBackgroundWork: {
        schema: z.boolean(),
        default: false,
        description: 'Show live detached background work in a separate session list group',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
    },
    sessionMessageSendMode: {
        schema: SessionMessageSendModeSchema,
        default: 'server_pending',
        description: 'How the app submits messages while an agent is running',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionBusySteerSendPolicy: {
        schema: SessionBusySteerSendPolicySchema,
        default: 'steer_immediately',
        description: 'When an agent is busy and supports in-flight steer, whether messages steer immediately or are queued via the pending queue',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionNonSteerableSendPrompt: {
        schema: SessionNonSteerableSendPromptSchema,
        default: 'ask',
        description: 'When a busy send cannot be steered into the active turn: ask (Interrupt & send vs Queue), queue silently, or keep the legacy behavior (off)',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionPendingQueueDrainMode: {
        schema: SessionPendingQueueDrainModeSchema,
        default: DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE,
        description: 'How many pending queue messages a running session should materialize at the next agent-ready boundary',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionPendingQueueDeliveryTiming: {
        schema: SessionPendingQueueDeliveryTimingSchema,
        default: DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
        description: 'Whether queued pending messages wait for foreground readiness or all tracked runtime activity to become idle',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionProviderUsageGaugeMode: {
        schema: z.enum(['auto', 'hidden']),
        default: 'auto',
        description: 'Whether to show the provider usage gauge in the session composer when reliable quota evidence is available',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    sessionProviderUsageGaugeWindowMode: {
        schema: z.enum(['most_constrained', 'daily', 'weekly', 'primary', 'secondary', 'session']),
        default: 'most_constrained',
        description: 'Which provider usage quota window the session composer gauge should prefer',
        storageScope: 'account',
        analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
    },
    usageLimitRecoverySettingsV1: {
        schema: UsageLimitRecoverySettingsV1Schema,
        default: DEFAULT_USAGE_LIMIT_RECOVERY_SETTINGS_V1,
        description: 'Global usage-limit wait/resume preference',
        storageScope: 'account',
        analytics: {
            trackCurrentState: true,
            trackChanges: true,
            valueKind: 'enum',
            privacy: 'safe',
            identityScope: 'person',
            serializeCurrent: (value: { mode?: unknown } | undefined) => value?.mode === 'auto_wait' ? 'auto_wait' : 'ask',
        },
    },
});

export const ACCOUNT_CORE_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_CORE_SETTING_DEFINITIONS);
