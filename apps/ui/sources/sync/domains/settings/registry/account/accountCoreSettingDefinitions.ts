import { buildSettingArtifacts, defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

export const SessionListDensitySchema = z.preprocess((raw) => {
    if (raw === 'compact') return 'cozy';
    return raw;
}, z.enum(['detailed', 'cozy', 'narrow']));

export const SessionMessageSendModeSchema = z.enum(['agent_queue', 'interrupt', 'server_pending']);
export const SessionBusySteerSendPolicySchema = z.enum(['steer_immediately', 'server_pending']);

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
        default: false,
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
    alwaysShowContextSize: {
        schema: z.boolean(),
        default: false,
        description: 'Always show context size in agent input',
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
        default: 'cozy',
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
        schema: z.string(),
        default: 'brutalist',
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
    sessionMessageSendMode: {
        schema: SessionMessageSendModeSchema,
        default: 'agent_queue',
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
});

export const ACCOUNT_CORE_SETTING_ARTIFACTS = buildSettingArtifacts(ACCOUNT_CORE_SETTING_DEFINITIONS);
