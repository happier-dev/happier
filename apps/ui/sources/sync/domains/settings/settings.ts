import * as z from 'zod';
import { dbgSettings, isSettingsSyncDebugEnabled } from './debugSettings';
import { SecretStringSchema } from '../../encryption/secretSettings';
import { pruneSecretBindings } from './secretBindings';
import { PERMISSION_MODES } from '@/constants/PermissionModes';
import type { PermissionMode } from '../permissions/permissionTypes';
import { CLAUDE_PERMISSION_MODES, CODEX_LIKE_PERMISSION_MODES } from '../permissions/permissionTypes';
import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { PROVIDER_SETTINGS_PLUGINS } from '@/agents/providers/_registry/providerSettingsRegistry';
import { SCM_COMMIT_STRATEGIES } from '@/scm/settings/commitStrategy';
import {
    SCM_DIFF_MODE_OPTIONS,
    SCM_GIT_REPO_BACKEND_OPTIONS,
    SCM_PUSH_REJECT_POLICIES,
    SCM_REMOTE_CONFIRM_POLICIES,
} from '@/scm/settings/preferences';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

//
// Configuration Profile Schema (for environment variable profiles)
//

// Environment variables schema with validation
const EnvironmentVariableSchema = z.object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'Invalid environment variable name'),
    value: z.string(),
    // User override:
    // - true: force secret handling in UI (and hint daemon)
    // - false: force non-secret handling in UI (unless daemon enforces)
    // - undefined: auto classification
    isSecret: z.boolean().optional(),
});

const RequiredEnvVarKindSchema = z.enum(['secret', 'config']);

const EnvVarRequirementSchema = z.object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'Invalid environment variable name'),
    kind: RequiredEnvVarKindSchema.default('secret'),
    // Required=true blocks session creation when unsatisfied.
    // Required=false is “optional” (still useful for vault binding, but does not block).
    required: z.boolean().default(true),
});

const RequiresMachineLoginSchema = z.string().min(1);

// Profile compatibility schema
const ProfileCompatibilitySchema = z.record(z.string(), z.boolean()).default({});

const DEFAULT_SESSION_PERMISSION_MODE_BY_AGENT: Record<AgentId, PermissionMode> = Object.fromEntries(
    AGENT_IDS.map((id) => [id, 'default']),
) as any;

const DEFAULT_BACKEND_ENABLED_BY_ID: Record<AgentId, boolean> = Object.fromEntries(
    AGENT_IDS.map((id) => [id, true]),
) as any;

export const AIBackendProfileSchema = z.object({
    // Accept both UUIDs (user profiles) and simple strings (built-in profiles like 'anthropic')
    // The isBuiltIn field distinguishes profile types
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),

    // Environment variables (validated)
    environmentVariables: z.array(EnvironmentVariableSchema).default([]),

    // Default session type for this profile
    defaultSessionType: z.enum(['simple', 'worktree']).optional(),

    // Legacy default permission mode for this profile (kept for backwards compatibility).
    defaultPermissionMode: z.enum(PERMISSION_MODES).optional(),

    // Per-agent default permission mode overrides for new sessions when this profile is selected.
    // When unset, the account-level per-agent defaults apply.
    defaultPermissionModeByAgent: z.record(z.string(), z.enum(PERMISSION_MODES)).default({}),

    // Default model mode for this profile
    defaultModelMode: z.string().optional(),

    // Compatibility metadata
    compatibility: ProfileCompatibilitySchema.default({}),

    // Authentication / requirements metadata (used by UI gating)
    // - machineLogin: profile relies on a machine-local CLI login cache
    authMode: z.enum(['machineLogin']).optional(),

    // For machine-login profiles, specify which CLI must be logged in on the target machine.
    // This is used for UX copy and for optional login-status detection.
    requiresMachineLogin: RequiresMachineLoginSchema.optional(),

    // Explicit environment variable requirements for this profile at runtime.
    // Secret requirements are satisfied by machine env, vault binding, or “enter once”.
    envVarRequirements: z.array(EnvVarRequirementSchema).default([]),

    // Built-in profile indicator
    isBuiltIn: z.boolean().default(false),

    // Metadata
    createdAt: z.number().default(() => Date.now()),
    updatedAt: z.number().default(() => Date.now()),
    version: z.string().default('1.0.0'),
})
    // NOTE: Zod v4 marks `superRefine` as deprecated in favor of `.check(...)`.
    // We use chained `.refine(...)` here to preserve per-field error paths/messages.
    .refine((profile) => {
        return !(profile.requiresMachineLogin && profile.authMode !== 'machineLogin');
    }, {
        path: ['requiresMachineLogin'],
        message: 'requiresMachineLogin may only be set when authMode=machineLogin',
    });

export type AIBackendProfile = z.infer<typeof AIBackendProfileSchema>;

//
// Session / tmux settings
//

const SessionTmuxMachineOverrideSchema = z.object({
    useTmux: z.boolean(),
    sessionName: z.string(),
    isolated: z.boolean(),
    tmpDir: z.string().nullable(),
});

const MultiServerProfileSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    serverIds: z.array(z.string()).default([]),
    presentation: z.enum(['grouped', 'flat-with-badge']).default('grouped'),
});

export const SavedSecretSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    kind: z.enum(['apiKey', 'token', 'password', 'other']).default('apiKey'),
    // Secret-at-rest container:
    // - plaintext is set via `encryptedValue.value` (input only; must not be persisted)
    // - ciphertext persists in `encryptedValue.encryptedValue`
    encryptedValue: SecretStringSchema,
    createdAt: z.number().default(() => Date.now()),
    updatedAt: z.number().default(() => Date.now()),
}).refine((key) => {
    const hasValue = typeof key.encryptedValue.value === 'string' && key.encryptedValue.value.trim().length > 0;
    const hasEnc = Boolean(key.encryptedValue.encryptedValue && typeof key.encryptedValue.encryptedValue.c === 'string' && key.encryptedValue.encryptedValue.c.length > 0);
    return hasValue || hasEnc;
}, {
    path: ['encryptedValue'],
    message: 'Secret must include a value or encrypted value',
});

export type SavedSecret = z.infer<typeof SavedSecretSchema>;

// Helper functions for profile validation and compatibility
export function isProfileCompatibleWithAgent(
    profile: Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>,
    agentId: AgentId,
): boolean {
    const explicit = profile.compatibility?.[agentId];
    if (typeof explicit === 'boolean') return explicit;
    return profile.isBuiltIn ? false : true;
}

function mergeEnvironmentVariables(
    existing: unknown,
    additions: Record<string, string | undefined>
): Array<{ name: string; value: string }> {
    const map = new Map<string, string>();

    if (Array.isArray(existing)) {
        for (const entry of existing) {
            if (!entry || typeof entry !== 'object') continue;
            const name = (entry as any).name;
            const value = (entry as any).value;
            if (typeof name !== 'string' || typeof value !== 'string') continue;
            map.set(name, value);
        }
    }

    for (const [name, value] of Object.entries(additions)) {
        if (typeof value !== 'string') continue;
        if (!map.has(name)) {
            map.set(name, value);
        }
    }

    return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
}

// NOTE: We intentionally do NOT support legacy provider config objects (e.g. `openaiConfig`).
// Profiles must use `environmentVariables` + `envVarRequirements` only.

/**
 * Converts a profile into environment variables for session spawning.
 *
 * HOW ENVIRONMENT VARIABLES WORK:
 *
 * 1. USER LAUNCHES DAEMON with credentials in environment:
 *    Example: Z_AI_AUTH_TOKEN=sk-real-key Z_AI_BASE_URL=https://api.z.ai happier daemon start
 *
 * 2. PROFILE DEFINES MAPPINGS using ${VAR} syntax to map daemon env vars to what CLI expects:
 *    Z.AI example: { name: 'ANTHROPIC_AUTH_TOKEN', value: '${Z_AI_AUTH_TOKEN}' }
 *    DeepSeek example: { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL}' }
 *    This maps provider-specific vars (Z_AI_AUTH_TOKEN, DEEPSEEK_BASE_URL) to CLI vars (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL)
 *
 * 3. GUI SENDS to daemon: Profile env vars with ${VAR} placeholders unchanged
 *    Sent: ANTHROPIC_AUTH_TOKEN=${Z_AI_AUTH_TOKEN} (literal string with placeholder)
 *
 * 4. DAEMON EXPANDS ${VAR} from its process.env when spawning session:
 *    - Tmux mode: daemon interpolates ${VAR} / ${VAR:-default} / ${VAR:=default} in env values before launching (shells do not expand placeholders inside env values automatically)
 *    - Non-tmux mode: daemon interpolates ${VAR} / ${VAR:-default} / ${VAR:=default} in env values before calling spawn() (Node does not expand placeholders)
 *
 * 5. SESSION RECEIVES actual expanded values:
 *    ANTHROPIC_AUTH_TOKEN=sk-real-key (expanded from daemon's Z_AI_AUTH_TOKEN, not literal ${Z_AI_AUTH_TOKEN})
 *
 * 6. CLAUDE CLI reads ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL and connects to Z.AI/DeepSeek/etc
 *
 * This design lets users:
 * - Set credentials ONCE when launching daemon (Z_AI_AUTH_TOKEN, DEEPSEEK_AUTH_TOKEN, ANTHROPIC_AUTH_TOKEN)
 * - Create multiple sessions, each with a different backend profile selected
 * - Session 1 can use Z.AI backend, Session 2 can use DeepSeek backend (simultaneously)
 * - Each session uses its selected backend for its entire lifetime (no mid-session switching)
 * - Keep secrets in shell environment, not in GUI/profile storage
 *
 * PRIORITY ORDER when spawning:
 * Final env = { ...daemon.process.env, ...expandedProfileVars, ...authVars }
 * authVars override profile, profile overrides daemon.process.env
 */
export function getProfileEnvironmentVariables(profile: AIBackendProfile): Record<string, string> {
    const envVars: Record<string, string> = {};

    // Add validated environment variables
    profile.environmentVariables.forEach(envVar => {
        envVars[envVar.name] = envVar.value;
    });

    return envVars;
}

// Profile versioning system
export const CURRENT_PROFILE_VERSION = '1.0.0';

// Profile version validation
export function validateProfileVersion(profile: AIBackendProfile): boolean {
    // Simple semver validation for now
    const semverRegex = /^\d+\.\d+\.\d+$/;
    return semverRegex.test(profile.version);
}

// Profile compatibility check for version upgrades
export function isProfileVersionCompatible(profileVersion: string, requiredVersion: string = CURRENT_PROFILE_VERSION): boolean {
    // For now, all 1.x.x versions are compatible
    const [major] = profileVersion.split('.');
    const [requiredMajor] = requiredVersion.split('.');
    return major === requiredMajor;
}

//
// Settings Schema
//

// Current schema version for backward compatibility
// NOTE: This schemaVersion is for the Happy app's settings blob (synced via the server).
// happy-cli maintains its own local settings schemaVersion separately.
export const SUPPORTED_SCHEMA_VERSION = 2;

const PROVIDER_SETTINGS_SHAPE: z.ZodRawShape = Object.assign(
    {},
    ...PROVIDER_SETTINGS_PLUGINS.map((p) => p.settingsShape),
);

const SettingsSchemaBase = z.object({
    // Schema version for compatibility detection
    schemaVersion: z.number().default(SUPPORTED_SCHEMA_VERSION).describe('Settings schema version for compatibility checks'),

    viewInline: z.boolean().describe('Whether to view inline tool calls'),
    inferenceOpenAIKey: z.string().nullish().describe('OpenAI API key for inference'),
    expandTodos: z.boolean().describe('Whether to expand todo lists'),
    showLineNumbers: z.boolean().describe('Whether to show line numbers in diffs'),
    showLineNumbersInToolViews: z.boolean().describe('Whether to show line numbers in tool view diffs'),
    wrapLinesInDiffs: z.boolean().describe('Whether to wrap long lines in diff views'),
    analyticsOptOut: z.boolean().describe('Whether to opt out of anonymous analytics'),
    experiments: z.boolean().describe('Whether to enable experimental features'),
    // Per-feature toggle map (gated by `experiments` master switch for experimental entries).
    // Keys are owned by the features domain (registry/catalog) so the settings schema can remain stable.
    featureToggles: z.record(z.string(), z.boolean()).default({}).describe('Per-feature feature toggles map'),
    // Per-backend enablement map used across picker/settings/profile surfaces.
    // Unknown keys are allowed to avoid schema churn when adding backends.
    backendEnabledById: z.record(z.string(), z.boolean()).default(DEFAULT_BACKEND_ENABLED_BY_ID).describe('Per-backend enable/disable toggles'),
    scmCommitStrategy: z.enum(SCM_COMMIT_STRATEGIES).describe('Source-control commit strategy: atomic working-copy commit or live Git staging'),
    scmGitRepoPreferredBackend: z.enum(SCM_GIT_REPO_BACKEND_OPTIONS).describe('Preferred backend for .git repositories'),
    scmRemoteConfirmPolicy: z.enum(SCM_REMOTE_CONFIRM_POLICIES).describe('Confirmation policy for SCM remote pull/push operations'),
    scmPushRejectPolicy: z.enum(SCM_PUSH_REJECT_POLICIES).describe('Behavior when push is rejected as non-fast-forward'),
    scmDefaultDiffModeByBackend: z.record(z.string(), z.enum(SCM_DIFF_MODE_OPTIONS)).default({}).describe('Preferred default diff mode by backend id'),
    scmReviewMaxFiles: z.number().describe('Maximum file count for unified SCM diff review mode before falling back to single-file review'),
    scmReviewMaxChangedLines: z.number().describe('Maximum total changed lines for unified SCM diff review mode before falling back to single-file review'),

    // Files/diff rendering options (flat; used by CodeLines surfaces).
    filesDiffSyntaxHighlightingMode: z.enum(['off', 'simple', 'advanced']).describe('Diff/file syntax highlighting mode'),
    filesChangedFilesRowDensity: z.enum(['comfortable', 'compact']).describe('Row density for changed files list and review'),
    filesDiffTokenizationMaxBytes: z.number().describe('Maximum bytes to tokenize before falling back to plain text'),
    filesDiffTokenizationMaxLines: z.number().describe('Maximum line count to tokenize before falling back to plain text'),
    filesDiffTokenizationMaxLineLength: z.number().describe('Maximum per-line length to tokenize before falling back to plain text for that line'),
    filesDiffTokenizationMaxTimeMs: z.number().describe('Maximum tokenization time budget per render cycle (best-effort)'),

    // Embedded editor options (flat; experimental).
    filesEditorAutoSave: z.boolean().describe('Whether to auto-save in the embedded editor'),
    filesEditorChangeDebounceMs: z.number().describe('Debounce milliseconds for editor change propagation'),
    filesEditorMaxFileBytes: z.number().describe('Maximum file size supported for editing in UI'),
    filesEditorBridgeMaxChunkBytes: z.number().describe('Maximum chunk size for editor WebView bridge payloads'),
    filesEditorWebMonacoEnabled: z.boolean().describe('Kill switch: enable Monaco editor surface on web/desktop'),
    filesEditorNativeCodeMirrorEnabled: z.boolean().describe('Kill switch: enable CodeMirror WebView surface on native'),
    useProfiles: z.boolean().describe('Whether to enable AI backend profiles feature'),
    useEnhancedSessionWizard: z.boolean().describe('A/B test flag: Use enhanced profile-based session wizard UI'),
    // Default permission modes for new sessions (account-level; per agent).
    // Values are normalized per-agent when used in UI/session creation.
    sessionDefaultPermissionModeByAgent: z.record(z.string(), z.enum(PERMISSION_MODES)).default(DEFAULT_SESSION_PERMISSION_MODE_BY_AGENT).describe('Default permission mode per agent for new sessions'),
    // Whether permission mode changes should be pushed to session metadata immediately (for live CLI updates),
    // or only applied when the next user message is sent.
    sessionPermissionModeApplyTiming: z.enum(['immediate', 'next_prompt']).describe('When to apply permission mode changes for a running session'),
    sessionUseTmux: z.boolean().describe('Whether new sessions should start in tmux by default'),
    sessionTmuxSessionName: z.string().describe('Default tmux session name for new sessions'),
    sessionTmuxIsolated: z.boolean().describe('Whether to use an isolated tmux server for new sessions'),
    sessionTmuxTmpDir: z.string().nullable().describe('Optional TMUX_TMPDIR override for isolated tmux server'),
    sessionTmuxByMachineId: z.record(z.string(), SessionTmuxMachineOverrideSchema).default({}).describe('Per-machine overrides for tmux session spawning'),
    // Legacy combined toggle (kept for backward compatibility; see settingsParse migration)
    usePickerSearch: z.boolean().describe('Whether to show search in machine/path picker UIs (legacy combined toggle)'),
    useMachinePickerSearch: z.boolean().describe('Whether to show search in machine picker UIs'),
    usePathPickerSearch: z.boolean().describe('Whether to show search in path picker UIs'),
    alwaysShowContextSize: z.boolean().describe('Always show context size in agent input'),
    agentInputEnterToSend: z.boolean().describe('Whether pressing Enter submits/sends in the agent input (web)'),
    agentInputActionBarLayout: z.enum(['auto', 'wrap', 'scroll', 'collapsed']).describe('Agent input action bar layout'),
    agentInputChipDensity: z.enum(['auto', 'labels', 'icons']).describe('Agent input action chip density'),
    avatarStyle: z.string().describe('Avatar display style'),
    showFlavorIcons: z.boolean().describe('Whether to show AI provider icons in avatars'),
    compactSessionView: z.boolean().describe('Whether to use compact view for active sessions'),
    hideInactiveSessions: z.boolean().describe('Hide inactive sessions in the main list'),
    groupInactiveSessionsByProject: z.boolean().describe('Group inactive sessions by project in the main list'),
    showEnvironmentBadge: z.boolean().describe('Show current app environment badge near the sidebar title'),
    multiServerEnabled: z.boolean().describe('Whether concurrent multi-server view is enabled'),
    multiServerSelectedServerIds: z.array(z.string()).describe('Server IDs selected for concurrent multi-server view'),
    multiServerPresentation: z.enum(['grouped', 'flat-with-badge']).describe('Session list presentation when concurrent multi-server view is enabled'),
    multiServerProfiles: z.array(MultiServerProfileSchema).describe('Saved concurrent multi-server groups/profiles'),
    multiServerActiveProfileId: z.string().nullable().describe('Active concurrent multi-server profile ID'),
	    reviewPromptAnswered: z.boolean().describe('Whether the review prompt has been answered'),
	    reviewPromptLikedApp: z.boolean().nullish().describe('Whether user liked the app when asked'),
	    voiceMode: z.enum(['off', 'happier', 'byo_elevenlabs']).describe('Voice mode: off, Happier Voice (server billed), or Bring Your Own ElevenLabs'),
	    voiceProviderId: z.enum(['off', 'happier_elevenlabs_agents', 'byo_elevenlabs_agents', 'local_openai_stt_tts']).describe('Voice provider id (new)'),
	    voiceByoElevenLabsAgentId: z.string().nullable().describe('BYO ElevenLabs: agent id'),
	    voiceByoElevenLabsApiKey: SecretStringSchema.nullable().describe('BYO ElevenLabs: API key (encrypted-at-rest settings secret)'),
	    voiceAssistantLanguage: z.string().nullable().describe('Preferred language for voice assistant (null for auto-detect)'),
	    voiceShareSessionSummary: z.boolean().describe('Voice context: include session summary'),
	    voiceShareRecentMessages: z.boolean().describe('Voice context: include recent messages'),
	    voiceRecentMessagesCount: z.number().int().min(0).max(50).describe('Voice context: number of recent messages to include'),
	    voiceShareToolNames: z.boolean().describe('Voice context: include tool names/descriptions'),
	    voiceSharePermissionRequests: z.boolean().describe('Voice context: include permission request prompts (args are always redacted)'),
	    voiceShareFilePaths: z.boolean().describe('Voice context: include local file paths (discouraged)'),
	    voiceShareToolArgs: z.boolean().describe('Voice context: include tool arguments (always forced off)'),
	    voiceLocalSttBaseUrl: z.string().nullable().describe('Local voice STT base URL (OpenAI-compatible, e.g. http://host:port/v1)'),
	    voiceLocalUseDeviceStt: z.boolean().describe('Local voice STT: use device speech recognition (experimental; may be unsupported on some platforms)'),
	    voiceLocalSttApiKey: SecretStringSchema.nullable().describe('Local voice STT API key (optional; encrypted-at-rest settings secret)'),
	    voiceLocalSttModel: z.string().describe('Local voice STT model name (OpenAI-compatible payload field)'),
	    voiceLocalTtsBaseUrl: z.string().nullable().describe('Local voice TTS base URL (OpenAI-compatible, e.g. http://host:port/v1)'),
	    voiceLocalUseDeviceTts: z.boolean().describe('Local voice TTS: use device speech synthesis (experimental; may be unsupported on some platforms)'),
	    voiceLocalTtsApiKey: SecretStringSchema.nullable().describe('Local voice TTS API key (optional; encrypted-at-rest settings secret)'),
	    voiceLocalTtsModel: z.string().describe('Local voice TTS model name (OpenAI-compatible payload field)'),
	    voiceLocalTtsVoice: z.string().describe('Local voice TTS voice id/name (OpenAI-compatible payload field)'),
	    voiceLocalTtsFormat: z.enum(['mp3', 'wav']).describe('Local voice TTS response format'),
	    voiceLocalAutoSpeakReplies: z.boolean().describe('Whether to automatically speak assistant replies for local voice provider'),
	    voiceLocalConversationMode: z.enum(['direct_session', 'mediator']).describe('Local voice: conversation mode (direct-to-session vs mediator)'),
	    voiceLocalMediatorBackend: z.enum(['daemon', 'openai_compat']).describe('Local voice mediator backend: daemon (sessionRPC) or OpenAI-compatible HTTP'),
	    voiceMediatorAgentSource: z.enum(['session', 'agent']).describe('Voice mediator backend source: use the current session backend or a specific agent backend'),
	    voiceMediatorAgentId: z.enum(AGENT_IDS).describe('Voice mediator agent id (when source=agent)'),
	    voiceMediatorPermissionPolicy: z.enum(['no_tools', 'read_only']).describe('Voice mediator permission policy'),
	    voiceMediatorIdleTtlSeconds: z.number().int().min(60).max(3600).describe('Voice mediator idle TTL (seconds)'),
	    voiceMediatorChatModelSource: z.enum(['session', 'custom']).describe('Voice mediator chat model source'),
	    voiceMediatorChatModelId: z.string().describe('Voice mediator chat model id (when source=custom)'),
	    voiceMediatorCommitModelSource: z.enum(['chat', 'session', 'custom']).describe('Voice mediator commit model source'),
	    voiceMediatorCommitModelId: z.string().describe('Voice mediator commit model id (when source=custom)'),
	    voiceLocalChatBaseUrl: z.string().nullable().describe('Local voice mediator (OpenAI-compatible) chat base URL (e.g. http://host:port/v1)'),
	    voiceLocalChatApiKey: SecretStringSchema.nullable().describe('Local voice mediator (OpenAI-compatible) chat API key (optional; encrypted-at-rest settings secret)'),
	    voiceLocalChatChatModel: z.string().describe('Local voice mediator (OpenAI-compatible) chat model name'),
	    voiceLocalChatCommitModel: z.string().describe('Local voice mediator (OpenAI-compatible) commit model name'),
	    voiceLocalChatTemperature: z.number().min(0).max(2).describe('Local voice mediator (OpenAI-compatible) chat temperature'),
	    voiceLocalChatMaxTokens: z.number().int().nullable().describe('Local voice mediator (OpenAI-compatible) max tokens (null = default)'),
	    voiceMediatorVerbosity: z.enum(['short', 'balanced']).describe('Voice mediator verbosity preference'),
	    preferredLanguage: z.string().nullable().describe('Preferred UI language (null for auto-detect from device locale)'),
    recentMachinePaths: z.array(z.object({
        machineId: z.string(),
        path: z.string()
    })).describe('Last 10 machine-path combinations, ordered by most recent first'),
	    lastUsedAgent: z.string().nullable().describe('Last selected agent type for new sessions'),
	    lastUsedPermissionMode: z.string().nullable().describe('Last selected permission mode for new sessions'),
	    lastUsedModelMode: z.string().nullable().describe('Last selected model mode for new sessions'),
	    sessionMessageSendMode: z.enum(['agent_queue', 'interrupt', 'server_pending']).describe('How the app submits messages while an agent is running'),
	    sessionBusySteerSendPolicy: z.enum(['steer_immediately', 'server_pending']).describe('When an agent is busy and supports in-flight steer, whether messages steer immediately or are queued via the pending queue'),
	    // Profile management settings
	    profiles: z.array(AIBackendProfileSchema).describe('User-defined profiles for AI backend and environment variables'),
	    lastUsedProfile: z.string().nullable().describe('Last selected profile for new sessions'),
    secrets: z.array(SavedSecretSchema).default([]).describe('Saved secrets (encrypted settings). Values are never re-displayed in UI.'),
    secretBindingsByProfileId: z.record(z.string(), z.record(z.string(), z.string())).default({}).describe('Default saved secret ID per profile and env var name'),
    // Favorite directories for quick path selection
    favoriteDirectories: z.array(z.string()).describe('User-defined favorite directories for quick access in path selection'),
    // Favorite machines for quick machine selection
    favoriteMachines: z.array(z.string()).describe('User-defined favorite machines (machine IDs) for quick access in machine selection'),
    // Favorite profiles for quick profile selection (built-in or custom profile IDs)
    favoriteProfiles: z.array(z.string()).describe('User-defined favorite profiles (profile IDs) for quick access in profile selection'),
    // Dismissed CLI warning banners (supports both per-machine and global dismissal)
    dismissedCLIWarnings: z.object({
        perMachine: z.record(z.string(), z.record(z.string(), z.boolean()).default({})).default({}),
        global: z.record(z.string(), z.boolean()).default({}),
    }).default({ perMachine: {}, global: {} }).describe('Tracks which CLI installation warnings user has dismissed (per-machine or globally)'),

    // Terminal connect compatibility toggle (device-local; not synced to server).
    // When enabled, the app may export legacy auth material to terminals if v2 provisioning is unavailable.
    terminalConnectLegacySecretExportEnabled: z.boolean().describe('Allow terminal connect to fall back to exporting the legacy auth secret (compatibility mode)'),

    // Tool rendering detail level preferences (synced per user).
    // Keep flat: use toolView* prefix (see tool-normalization-refactor-plan.md).
    toolViewDetailLevelDefault: z.enum(['title', 'summary', 'full']).describe('Default tool detail level in the session timeline'),
    toolViewDetailLevelDefaultLocalControl: z.enum(['title', 'summary', 'full']).describe('Default tool detail level for local-control transcript mirroring'),
    toolViewDetailLevelByToolName: z.record(z.string(), z.enum(['title', 'summary', 'full'])).default({}).describe('Per-tool detail level overrides (keyed by canonical tool name)'),
    toolViewShowDebugByDefault: z.boolean().describe('Whether to auto-expand debug/raw tool payloads in the full tool view'),
    toolViewTapAction: z.enum(['expand', 'open']).describe('Primary tap action on tool cards (timeline)'),
    toolViewExpandedDetailLevelDefault: z.enum(['summary', 'full']).describe('Default expanded tool detail level in the session timeline'),
    toolViewExpandedDetailLevelByToolName: z.record(z.string(), z.enum(['summary', 'full'])).default({}).describe('Per-tool expanded detail level overrides (keyed by canonical tool name)'),
});

export const SettingsSchema = SettingsSchemaBase.extend(PROVIDER_SETTINGS_SHAPE);

//
// NOTE: Settings must be a flat object with no to minimal nesting, one field == one setting,
// you can name them with a prefix if you want to group them, but don't nest them.
// You can nest if value is a single value (like image with url and width and height)
// Settings are always merged with defaults and field by field.
// 
// This structure must be forward and backward compatible. Meaning that some versions of the app
// could be missing some fields or have a new fields. Everything must be preserved and client must 
// only touch the fields it knows about.
//

const SettingsSchemaPartial = SettingsSchema.partial();

export type KnownSettings = z.infer<typeof SettingsSchema>;
export type Settings = z.infer<typeof SettingsSchema> & Record<string, unknown>;

//
// Defaults
//

export const settingsDefaults: Settings = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    viewInline: false,
    inferenceOpenAIKey: null,
    expandTodos: true,
    showLineNumbers: true,
    showLineNumbersInToolViews: false,
    wrapLinesInDiffs: false,
    analyticsOptOut: false,
    experiments: false,
    featureToggles: {},
    backendEnabledById: DEFAULT_BACKEND_ENABLED_BY_ID,
    scmCommitStrategy: 'atomic',
    scmGitRepoPreferredBackend: 'git',
    scmRemoteConfirmPolicy: 'always',
    scmPushRejectPolicy: 'prompt_fetch',
    scmDefaultDiffModeByBackend: {},
    scmReviewMaxFiles: 25,
    scmReviewMaxChangedLines: 2000,

    filesDiffSyntaxHighlightingMode: 'simple',
    filesChangedFilesRowDensity: 'comfortable',
    filesDiffTokenizationMaxBytes: 250_000,
    filesDiffTokenizationMaxLines: 5_000,
    filesDiffTokenizationMaxLineLength: 2_000,
    filesDiffTokenizationMaxTimeMs: 40,

    filesEditorAutoSave: false,
    filesEditorChangeDebounceMs: 250,
    filesEditorMaxFileBytes: 2_500_000,
    filesEditorBridgeMaxChunkBytes: 64_000,
    filesEditorWebMonacoEnabled: true,
    filesEditorNativeCodeMirrorEnabled: true,
    useProfiles: false,
    sessionDefaultPermissionModeByAgent: DEFAULT_SESSION_PERMISSION_MODE_BY_AGENT,
    sessionPermissionModeApplyTiming: 'immediate',
    sessionUseTmux: false,
    sessionTmuxSessionName: 'happy',
    sessionTmuxIsolated: true,
    sessionTmuxTmpDir: null,
    sessionTmuxByMachineId: {},
    useEnhancedSessionWizard: false,
    usePickerSearch: false,
    useMachinePickerSearch: false,
    usePathPickerSearch: false,
    alwaysShowContextSize: false,
    agentInputEnterToSend: true,
    agentInputActionBarLayout: 'auto',
    agentInputChipDensity: 'auto',
    avatarStyle: 'brutalist',
    showFlavorIcons: true,
    compactSessionView: false,
    hideInactiveSessions: false,
    groupInactiveSessionsByProject: false,
    showEnvironmentBadge: true,
    multiServerEnabled: false,
    multiServerSelectedServerIds: [],
    multiServerPresentation: 'grouped',
    multiServerProfiles: [],
    multiServerActiveProfileId: null,
	    reviewPromptAnswered: false,
	    reviewPromptLikedApp: null,
	    voiceMode: 'happier',
	    voiceProviderId: 'happier_elevenlabs_agents',
	    voiceByoElevenLabsAgentId: null,
	    voiceByoElevenLabsApiKey: null,
	    voiceAssistantLanguage: null,
	    voiceShareSessionSummary: true,
	    voiceShareRecentMessages: true,
	    voiceRecentMessagesCount: 10,
	    voiceShareToolNames: true,
	    voiceSharePermissionRequests: true,
		    voiceShareFilePaths: false,
		    voiceShareToolArgs: false,
		    voiceLocalSttBaseUrl: null,
		    voiceLocalUseDeviceStt: false,
		    voiceLocalSttApiKey: null,
		    voiceLocalSttModel: 'whisper-1',
		    voiceLocalTtsBaseUrl: null,
		    voiceLocalUseDeviceTts: false,
		    voiceLocalTtsApiKey: null,
		    voiceLocalTtsModel: 'tts-1',
		    voiceLocalTtsVoice: 'alloy',
		    voiceLocalTtsFormat: 'mp3',
		    voiceLocalAutoSpeakReplies: true,
	    voiceLocalConversationMode: 'direct_session',
	    voiceLocalMediatorBackend: 'daemon',
	    voiceMediatorAgentSource: 'session',
	    voiceMediatorAgentId: 'claude',
	    voiceMediatorPermissionPolicy: 'read_only',
	    voiceMediatorIdleTtlSeconds: 300,
	    voiceMediatorChatModelSource: 'custom',
	    voiceMediatorChatModelId: 'default',
	    voiceMediatorCommitModelSource: 'chat',
	    voiceMediatorCommitModelId: 'default',
	    voiceLocalChatBaseUrl: null,
	    voiceLocalChatApiKey: null,
	    voiceLocalChatChatModel: 'default',
	    voiceLocalChatCommitModel: 'default',
	    voiceLocalChatTemperature: 0.4,
	    voiceLocalChatMaxTokens: null,
	    voiceMediatorVerbosity: 'short',
	    preferredLanguage: null,
	    recentMachinePaths: [],
	    lastUsedAgent: null,
	    lastUsedPermissionMode: null,
	    lastUsedModelMode: null,
	    sessionMessageSendMode: 'agent_queue',
	    sessionBusySteerSendPolicy: 'steer_immediately',
	    // Profile management defaults
	    profiles: [],
    lastUsedProfile: null,
    secrets: [],
    secretBindingsByProfileId: {},
    // Favorite directories (empty by default)
    favoriteDirectories: [],
    // Favorite machines (empty by default)
    favoriteMachines: [],
    // Favorite profiles (empty by default)
    favoriteProfiles: [],
    // Dismissed CLI warnings (empty by default)
    dismissedCLIWarnings: { perMachine: {}, global: {} },

    terminalConnectLegacySecretExportEnabled: false,

    toolViewDetailLevelDefault: 'summary',
    toolViewDetailLevelDefaultLocalControl: 'title',
    toolViewDetailLevelByToolName: {},
    toolViewShowDebugByDefault: false,
    toolViewTapAction: 'expand',
    toolViewExpandedDetailLevelDefault: 'full',
    toolViewExpandedDetailLevelByToolName: {},
    ...Object.assign({}, ...PROVIDER_SETTINGS_PLUGINS.map((p) => p.settingsDefaults)),
};
Object.freeze(settingsDefaults);

//
// Resolving
//

export function settingsParse(settings: unknown): Settings {
    // Handle null/undefined/invalid inputs
    if (!settings || typeof settings !== 'object') {
        return { ...settingsDefaults };
    }

    const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
    const debug = isSettingsSyncDebugEnabled();

    // IMPORTANT: be tolerant of partially-invalid settings objects.
    // A single invalid field (e.g. one malformed profile) must not reset all other known settings to defaults.
    const input = settings as Record<string, unknown>;
    const result: any = { ...settingsDefaults };

    // Parse known fields individually to avoid whole-object failure.
    (Object.keys(SettingsSchema.shape) as Array<Extract<keyof typeof SettingsSchema.shape, string>>).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(input, key)) return;

        // Special-case profiles: validate per profile entry, keep valid ones.
        if (key === 'profiles') {
            const profilesValue = input[key];
            if (Array.isArray(profilesValue)) {
                const parsedProfiles: AIBackendProfile[] = [];
                for (const rawProfile of profilesValue) {
                    const parsedProfile = AIBackendProfileSchema.safeParse(rawProfile);
                    if (parsedProfile.success) {
                        parsedProfiles.push(parsedProfile.data);
                    } else if (isDev) {
                        console.warn('[settingsParse] Dropping invalid profile entry', parsedProfile.error.issues);
                    }
                }
                result.profiles = parsedProfiles;
            }
            return;
        }

        // Special-case secrets: validate per secret entry, keep valid ones.
        if (key === 'secrets') {
            const secretsValue = input[key];
            if (Array.isArray(secretsValue)) {
                const parsedSecrets: SavedSecret[] = [];
                for (const rawSecret of secretsValue) {
                    const parsedSecret = SavedSecretSchema.safeParse(rawSecret);
                    if (parsedSecret.success) {
                        parsedSecrets.push(parsedSecret.data);
                    } else if (isDev || debug) {
                        console.warn('[settingsParse] Dropping invalid secret entry', parsedSecret.error.issues);
                    }
                }
                result.secrets = parsedSecrets;
            }
            return;
        }

        const schema = SettingsSchema.shape[key];
        const parsedField = schema.safeParse(input[key]);
        if (parsedField.success) {
            result[key] = parsedField.data;
        } else if (isDev || debug) {
            console.warn(`[settingsParse] Invalid settings field "${String(key)}" - using default`, parsedField.error.issues);
            if (debug) {
                dbgSettings('settingsParse: invalid field', {
                    key: String(key),
                    issues: parsedField.error.issues.map((i) => ({
                        path: i.path,
                        code: i.code,
                        message: i.message,
                    })),
                });
            }
        }
    });

    // Migration: Convert old 'zh' language code to 'zh-Hans'
    if (result.preferredLanguage === 'zh') {
        result.preferredLanguage = 'zh-Hans';
    }

    // Migration: Convert legacy combined picker-search toggle into per-picker toggles.
    // Only apply if new fields were not present in persisted settings.
    const hasMachineSearch = 'useMachinePickerSearch' in input;
    const hasPathSearch = 'usePathPickerSearch' in input;
    if (!hasMachineSearch && !hasPathSearch) {
        const legacy = SettingsSchema.shape.usePickerSearch.safeParse(input.usePickerSearch);
        if (legacy.success && legacy.data === true) {
            result.useMachinePickerSearch = true;
            result.usePathPickerSearch = true;
        }
    }

    // Migration: Rename terminal/message send settings to session-prefixed names.
    // These settings have not been deployed broadly, but we still migrate to avoid breaking local dev devices.
    if (!('sessionUseTmux' in input) && 'terminalUseTmux' in input) {
        const parsed = z.boolean().safeParse((input as any).terminalUseTmux);
        if (parsed.success) result.sessionUseTmux = parsed.data;
    }
    if (!('sessionTmuxSessionName' in input) && 'terminalTmuxSessionName' in input) {
        const parsed = z.string().safeParse((input as any).terminalTmuxSessionName);
        if (parsed.success) result.sessionTmuxSessionName = parsed.data;
    }
    if (!('sessionTmuxIsolated' in input) && 'terminalTmuxIsolated' in input) {
        const parsed = z.boolean().safeParse((input as any).terminalTmuxIsolated);
        if (parsed.success) result.sessionTmuxIsolated = parsed.data;
    }
    if (!('sessionTmuxTmpDir' in input) && 'terminalTmuxTmpDir' in input) {
        const parsed = z.string().nullable().safeParse((input as any).terminalTmuxTmpDir);
        if (parsed.success) result.sessionTmuxTmpDir = parsed.data;
    }
    if (!('sessionTmuxByMachineId' in input) && 'terminalTmuxByMachineId' in input) {
        const parsed = z.record(z.string(), SessionTmuxMachineOverrideSchema).safeParse((input as any).terminalTmuxByMachineId);
        if (parsed.success) result.sessionTmuxByMachineId = parsed.data;
    }
	    if (!('sessionMessageSendMode' in input) && 'messageSendMode' in input) {
	        const parsed = z.enum(['agent_queue', 'interrupt', 'server_pending'] as const).safeParse((input as any).messageSendMode);
	        if (parsed.success) result.sessionMessageSendMode = parsed.data;
	    }

	    // Migration: rename legacy busy-steer policy value.
	    // Older dev builds used `queue_for_review` to mean "use the server pending queue".
	    if ('sessionBusySteerSendPolicy' in input) {
	        const raw = (input as any).sessionBusySteerSendPolicy;
	        if (raw === 'queue_for_review') {
	            result.sessionBusySteerSendPolicy = 'server_pending';
	        }
	    }

    // Migration: introduce per-agent default permission modes for new sessions.
    //
    // Sources (in priority order):
    // 1) New field: `sessionDefaultPermissionModeByAgent`
    // 2) Legacy: `lastUsedPermissionMode` + `lastUsedAgent` (seed defaults to preserve user intent)
    const hasPerAgentPermissionDefaults = ('sessionDefaultPermissionModeByAgent' in input);
    if (!hasPerAgentPermissionDefaults) {
        const byAgent: Record<string, PermissionMode> = { ...(result.sessionDefaultPermissionModeByAgent as any) };
        const rawMode = (input as any).lastUsedPermissionMode;
        if (typeof rawMode === 'string') {
            const parsed = parsePermissionIntentAlias(rawMode);
            if (parsed) {
                // Preserve the user's intent when seeding per-agent defaults. Clamp only when the
                // target agent does not expose the intent as a selectable permission mode.
                //
                // Note: some intents may not be enforceable by a provider at runtime (e.g. Claude
                // read-only). Those constraints are communicated via "effective policy" elsewhere.
                for (const to of AGENT_IDS) {
                    const group = getAgentCore(to).permissions.modeGroup;
                    const allowed = group === 'codexLike' ? CODEX_LIKE_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
                    byAgent[to] = (allowed as readonly string[]).includes(parsed) ? (parsed as PermissionMode) : 'default';
                }
            }
        }

        result.sessionDefaultPermissionModeByAgent = byAgent as any;
    }
	    // Migration: derive `voiceProviderId` from legacy `voiceMode` when missing.
	    // This keeps older clients (that only persisted voiceMode) working with the new provider selector.
	    if (!('voiceProviderId' in input)) {
	        if (result.voiceMode === 'off') result.voiceProviderId = 'off';
	        if (result.voiceMode === 'happier') result.voiceProviderId = 'happier_elevenlabs_agents';
	        if (result.voiceMode === 'byo_elevenlabs') result.voiceProviderId = 'byo_elevenlabs_agents';
	    }

	    // Safety: tool arguments are never shared with voice providers.
	    // Even if a persisted settings blob contains `voiceShareToolArgs: true`, force it off.
	    result.voiceShareToolArgs = false;

    // Migration: hard cutover from legacy `inbox.friends` feature id to `social.friends`.
    // Preserve explicit user choice when present.
    if (result.featureToggles && typeof result.featureToggles === 'object') {
        const map = result.featureToggles as Record<string, unknown>;
        const legacy = map['inbox.friends'];
        if (typeof legacy === 'boolean' && typeof map['social.friends'] !== 'boolean') {
            map['social.friends'] = legacy;
        }
        delete map['inbox.friends'];
    }

	    const DROPPED_KEYS = new Set([
	        // Removed in favor of `defaultPermissionModeByAgent`.
	        'defaultPermissionModeClaude',
        'defaultPermissionModeCodex',
        'defaultPermissionModeGemini',
        // Removed backend/experimental fields (replaced by backendEnabledById + codexBackendMode).
        'experimentalAgents',
        'expCodexResume',
        'expCodexAcp',
        'codexResumeInstallSpec',
        // Voice is no longer experimental; the old experiment toggle is ignored.
        'expVoiceAuthFlow',
        // Hard cutover: legacy experiment toggles are now driven by `featureToggles`.
        'expUsageReporting',
        'expFileViewer',
        'expScmOperations',
        'expShowThinkingMessages',
        'expSessionType',
        'expZen',
        'expInboxFriends',
        // Hard cutover: experimentalFeatureToggles was replaced by featureToggles.
        'experimentalFeatureToggles',
    ]);

    // Preserve unknown fields (forward compatibility).
    for (const [key, value] of Object.entries(input)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (DROPPED_KEYS.has(key)) continue;
        if (!Object.prototype.hasOwnProperty.call(SettingsSchema.shape, key)) {
            Object.defineProperty(result, key, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }

    return pruneSecretBindings(result as Settings);
}

//
// Applying changes
// NOTE: May be something more sophisticated here around defaults and merging, but for now this is fine.
//

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    // Original behavior: start with settings, apply delta, fill in missing with defaults
    const result = { ...settings, ...delta };

    // Fill in any missing fields with defaults
    Object.keys(settingsDefaults).forEach(key => {
        if (!(key in result)) {
            (result as any)[key] = (settingsDefaults as any)[key];
        }
    });

    return pruneSecretBindings(result as Settings);
}
