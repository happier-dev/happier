import { z } from 'zod';
import { buildSettingArtifacts, type SettingDefinitionMap } from '@happier-dev/protocol';

import type { ProviderSettingsDefinition } from '../types.js';

export const MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS = 16_384;
// Node timers use a signed 32-bit millisecond delay; larger delays fire immediately.
export const MAX_CLAUDE_REMOTE_IDLE_RECLAIM_TIMEOUT_MINUTES = Math.floor(2_147_483_647 / 60_000);

const CLAUDE_SETTING_SOURCES_V2 = ['user', 'project', 'local'] as const;
export type ClaudeSettingSourceV2 = (typeof CLAUDE_SETTING_SOURCES_V2)[number];

export const CLAUDE_UNIFIED_TERMINAL_HOSTS = ['auto', 'tmux', 'zellij', 'herdr'] as const;
export type ClaudeUnifiedTerminalHost = (typeof CLAUDE_UNIFIED_TERMINAL_HOSTS)[number];

export const CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES = [
  'ask_every_time',
  'resume_from_summary',
  'resume_full_session',
] as const;
export type ClaudeUnifiedTerminalResumeChoice = (typeof CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES)[number];

export const CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS = ['app_and_terminal', 'app_only', 'terminal_only'] as const;
export type ClaudeUnifiedTerminalResponseLocation = (typeof CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS)[number];

export function resolveClaudeUnifiedTerminalResponseLocations(settings: Readonly<Record<string, unknown>>): Readonly<{
  question: ClaudeUnifiedTerminalResponseLocation;
  permission: ClaudeUnifiedTerminalResponseLocation;
}> {
  const fallback = settings.claudeLocalPermissionBridgeEnabled === false ? 'terminal_only' : 'app_and_terminal';
  const resolve = (value: unknown): ClaudeUnifiedTerminalResponseLocation =>
    typeof value === 'string' && (CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS as readonly string[]).includes(value)
      ? value as ClaudeUnifiedTerminalResponseLocation
      : fallback;
  return {
    question: resolve(settings.claudeUnifiedTerminalQuestionResponseLocation),
    permission: resolve(settings.claudeUnifiedTerminalPermissionResponseLocation),
  };
}

export const CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES = [
  'ask_every_time',
  'always_trust_happier_workspaces',
  'always_reject_happier_workspaces',
] as const;
export type ClaudeUnifiedTerminalWorkspaceTrustPolicy =
  (typeof CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES)[number];
export type ClaudeUnifiedTerminalWorkspaceTrust = ClaudeUnifiedTerminalWorkspaceTrustPolicy;

const CLAUDE_REMOTE_DEBUG_CATEGORIES = ['api', 'mcp', 'hooks', 'file', '1p'] as const;
export type ClaudeRemoteDebugCategory = (typeof CLAUDE_REMOTE_DEBUG_CATEGORIES)[number];

function normalizeClaudeSettingSourcesV2(raw: unknown): ClaudeSettingSourceV2[] | null {
  if (!Array.isArray(raw)) return null;
  const input = raw as unknown[];
  const inputSet = new Set(input.filter((v): v is ClaudeSettingSourceV2 => typeof v === 'string' && (CLAUDE_SETTING_SOURCES_V2 as readonly string[]).includes(v)));
  const out: ClaudeSettingSourceV2[] = [];
  for (const key of CLAUDE_SETTING_SOURCES_V2) {
    if (inputSet.has(key)) out.push(key);
  }
  return out;
}

function normalizeClaudeRemoteDebugCategories(raw: unknown): ClaudeRemoteDebugCategory[] | null {
  if (!Array.isArray(raw)) return null;
  const input = raw as unknown[];
  const inputSet = new Set(
    input.filter(
      (v): v is ClaudeRemoteDebugCategory =>
        typeof v === 'string' && (CLAUDE_REMOTE_DEBUG_CATEGORIES as readonly string[]).includes(v),
    ),
  );
  const out: ClaudeRemoteDebugCategory[] = [];
  for (const key of CLAUDE_REMOTE_DEBUG_CATEGORIES) {
    if (inputSet.has(key)) out.push(key);
  }
  return out;
}

function normalizeClaudeUnifiedTerminalHost(raw: unknown): ClaudeUnifiedTerminalHost | null {
  return typeof raw === 'string' && (CLAUDE_UNIFIED_TERMINAL_HOSTS as readonly string[]).includes(raw)
    ? raw as ClaudeUnifiedTerminalHost
    : null;
}

function normalizeClaudeUnifiedTerminalResumeChoice(raw: unknown): ClaudeUnifiedTerminalResumeChoice | null {
  return typeof raw === 'string' && (CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES as readonly string[]).includes(raw)
    ? raw as ClaudeUnifiedTerminalResumeChoice
    : null;
}

function normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(
  raw: unknown,
): ClaudeUnifiedTerminalWorkspaceTrustPolicy | null {
  return typeof raw === 'string'
    && (CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES as readonly string[]).includes(raw)
    ? raw as ClaudeUnifiedTerminalWorkspaceTrustPolicy
    : null;
}

function mapLegacyClaudeSettingSourcesToV2(value: string): ClaudeSettingSourceV2[] | null {
  if (value === 'none') return [];
  if (value === 'project') return ['project'];
  if (value === 'user_project') return ['user', 'project'];
  return null;
}

function tryMapSettingSourcesV2ToLegacy(value: readonly ClaudeSettingSourceV2[]): 'project' | 'user_project' | 'none' | null {
  if (value.length === 0) return 'none';
  if (value.length === 1 && value[0] === 'project') return 'project';
  if (value.length === 2 && value[0] === 'user' && value[1] === 'project') return 'user_project';
  return null;
}

export function isValidClaudeRemoteAdvancedOptionsJson(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (trimmed.length > MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export function normalizeClaudeRemoteAdvancedOptionsJson(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (!isValidClaudeRemoteAdvancedOptionsJson(trimmed)) return '';
  const parsed = JSON.parse(trimmed) as unknown;
  const normalized = JSON.stringify(parsed);
  return normalized.length <= MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS ? normalized : '';
}

function serializeClaudeSettingSourcesV2(raw: unknown): string {
  const normalized = normalizeClaudeSettingSourcesV2(raw);
  if (!normalized || normalized.length === 0) return 'none';
  return normalized.join('+');
}

function serializeClaudeRemoteDebugCategories(raw: unknown): string {
  const normalized = normalizeClaudeRemoteDebugCategories(raw);
  if (!normalized || normalized.length === 0) return 'none';
  return normalized.join('+');
}

export const CLAUDE_REMOTE_PROVIDER_FIELDS = {
  claudeDynamicModelProbeEnabled: {
    schema: z.boolean(),
    default: true,
    description: 'Let Happier query the selected Claude account for available models',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeRemoteAgentSdkEnabled: {
    schema: z.boolean(),
    default: true,
    description: 'Use Claude Agent SDK in remote mode',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeRemoteIdleReclaimEnabled: {
    schema: z.boolean(),
    default: false,
    description: 'Release idle Claude remote processes and resume the same session on the next prompt',
    storageScope: 'account',
  },
  claudeRemoteIdleReclaimTimeoutMinutes: {
    schema: z.number().int().positive().max(MAX_CLAUDE_REMOTE_IDLE_RECLAIM_TIMEOUT_MINUTES),
    default: 30,
    description: 'Idle time in minutes before releasing an opted-in Claude remote process',
    storageScope: 'account',
  },
  claudeUnifiedTerminalEnabled: {
    schema: z.boolean(),
    default: false,
    description: 'Use unified terminal runtime for Claude sessions',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeUnifiedTerminalHost: {
    schema: z.enum(CLAUDE_UNIFIED_TERMINAL_HOSTS),
    default: 'auto' as ClaudeUnifiedTerminalHost,
    description: 'Terminal host preference for unified runtime',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
  },
  claudeUnifiedTerminalResumeChoice: {
    schema: z.enum(CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES),
    default: 'ask_every_time' as ClaudeUnifiedTerminalResumeChoice,
    description: 'How Claude unified terminal should answer heavy-session resume prompts',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
  },
  claudeUnifiedTerminalQuestionResponseLocation: {
    schema: z.enum(CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS),
    default: 'app_and_terminal' as ClaudeUnifiedTerminalResponseLocation,
    description: 'Where users can answer Claude unified terminal questions',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
  },
  claudeUnifiedTerminalPermissionResponseLocation: {
    schema: z.enum(CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS),
    default: 'app_and_terminal' as ClaudeUnifiedTerminalResponseLocation,
    description: 'Where users can approve Claude unified terminal permission requests',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
  },
  claudeUnifiedTerminalWorkspaceTrust: {
    schema: z.enum(CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES),
    default: 'ask_every_time' as ClaudeUnifiedTerminalWorkspaceTrustPolicy,
    description: 'How Claude unified terminal should answer Happier workspace trust prompts',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'enum', privacy: 'safe', identityScope: 'person' },
  },
  claudeRemoteSettingSources: {
    schema: z.enum(['project', 'user_project', 'none']),
    default: 'user_project' as 'project' | 'user_project' | 'none',
    description: 'Legacy Claude settings source mode',
    storageScope: 'account',
  },
  claudeRemoteSettingSourcesV2: {
    schema: z.array(z.enum(['user', 'project', 'local'])).max(3),
    default: ['user', 'project', 'local'] as readonly ClaudeSettingSourceV2[],
    description: 'Claude settings sources',
    storageScope: 'account',
    analytics: {
      trackCurrentState: true,
      trackChanges: true,
      valueKind: 'enum',
      privacy: 'safe',
      identityScope: 'person',
      serializeCurrent: (value) => serializeClaudeSettingSourcesV2(value),
    },
  },
  claudeCodeIncludeInNativeHistory: {
    schema: z.boolean(),
    default: false,
    description: 'Use Happier attribution for Claude sessions so they can appear in Claude Code history',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeCodeExperimentalAgentTeamsEnabled: {
    schema: z.boolean(),
    default: false,
    description: 'Force-enable Claude experimental agent teams',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeLocalPermissionBridgeEnabled: {
    schema: z.boolean(),
    default: true,
    description: 'Enable local Claude permission bridge',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeLocalPermissionBridgeWaitIndefinitely: {
    schema: z.boolean(),
    default: true,
    description: 'Keep local permission requests open until the user responds',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeLocalPermissionBridgeTimeoutSeconds: {
    schema: z.number().int().positive(),
    default: 600,
    description: 'Local permission bridge timeout in seconds',
    storageScope: 'account',
  },
  claudeRemoteEnableFileCheckpointing: {
    schema: z.boolean(),
    default: false,
    description: 'Enable Claude file checkpointing',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeRemoteMaxThinkingTokens: {
    schema: z.number().int().positive().nullable(),
    default: null as number | null,
    description: 'Maximum Claude thinking tokens override',
    storageScope: 'account',
  },
  claudeRemoteDisableTodos: {
    schema: z.boolean(),
    default: false,
    description: 'Disable TODO generation in Claude remote mode',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeRemoteStrictMcpServerConfig: {
    schema: z.boolean(),
    default: false,
    description: 'Fail if Claude MCP server config is invalid',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeRemoteDebugEnabled: {
    schema: z.boolean(),
    default: false,
    description: 'Enable Claude Code debug mode (remote)',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeRemoteVerboseEnabled: {
    schema: z.boolean(),
    default: false,
    description: 'Enable Claude Code verbose logging (remote)',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeRemoteDebugCategories: {
    schema: z.array(z.enum(['api', 'mcp', 'hooks', 'file', '1p'])).max(5),
    default: [] as readonly ClaudeRemoteDebugCategory[],
    description: 'Claude Code debug categories filter (remote)',
    storageScope: 'account',
    analytics: {
      trackCurrentState: true,
      trackChanges: true,
      valueKind: 'enum',
      privacy: 'safe',
      identityScope: 'person',
      serializeCurrent: (value) => serializeClaudeRemoteDebugCategories(value),
    },
  },
  claudeRemoteAdvancedOptionsJson: {
    schema: z.string().refine(isValidClaudeRemoteAdvancedOptionsJson, {
      message: 'Must be empty or a valid JSON object string',
    }),
    default: '',
    description: 'Advanced Claude remote options JSON',
    storageScope: 'account',
    analytics: {
      trackCurrentState: true,
      trackChanges: true,
      valueKind: 'presence',
      privacy: 'presence_only',
      identityScope: 'person',
      serializeCurrent: (value) => normalizeClaudeRemoteAdvancedOptionsJson(value) !== '',
    },
  },
} as const satisfies SettingDefinitionMap;

const CLAUDE_REMOTE_PROVIDER_ARTIFACTS = buildSettingArtifacts(CLAUDE_REMOTE_PROVIDER_FIELDS);

export const CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS = Object.freeze(CLAUDE_REMOTE_PROVIDER_ARTIFACTS.defaults);

export function buildClaudeRemoteProviderSettingsShape(_zod: typeof z) {
  return CLAUDE_REMOTE_PROVIDER_ARTIFACTS.shape;
}

export function buildClaudeRemoteOutgoingMessageMetaExtras(settings: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const readBoolean = <T extends keyof typeof CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS>(key: T): boolean => {
    const value = settings[key as string];
    return typeof value === 'boolean' ? value : Boolean(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS[key]);
  };

  const readNumber = <T extends keyof typeof CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS>(key: T): number => {
    const value = settings[key as string];
    return typeof value === 'number' ? value : Number(CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS[key]);
  };

  const normalizedV2 = normalizeClaudeSettingSourcesV2(settings.claudeRemoteSettingSourcesV2);
  const normalizedLegacy =
    typeof settings.claudeRemoteSettingSources === 'string'
      ? (mapLegacyClaudeSettingSourcesToV2(settings.claudeRemoteSettingSources) ? settings.claudeRemoteSettingSources : null)
      : null;
  const effectiveV2 =
    normalizedV2 !== null
      ? normalizedV2
      : normalizedLegacy
        ? (mapLegacyClaudeSettingSourcesToV2(normalizedLegacy)
          ?? CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteSettingSourcesV2 as readonly ClaudeSettingSourceV2[])
        : CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteSettingSourcesV2 as readonly ClaudeSettingSourceV2[];
  const legacyFromV2 = tryMapSettingSourcesV2ToLegacy(effectiveV2);

  const debugCategories =
    normalizeClaudeRemoteDebugCategories(settings.claudeRemoteDebugCategories)
    ?? (CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteDebugCategories as readonly ClaudeRemoteDebugCategory[]);
  const responseLocations = resolveClaudeUnifiedTerminalResponseLocations(settings);

  return {
    claudeRemoteAgentSdkEnabled: readBoolean('claudeRemoteAgentSdkEnabled'),
    claudeRemoteIdleReclaimEnabled: readBoolean('claudeRemoteIdleReclaimEnabled'),
    claudeRemoteIdleReclaimTimeoutMinutes:
      CLAUDE_REMOTE_PROVIDER_FIELDS.claudeRemoteIdleReclaimTimeoutMinutes.schema.safeParse(settings.claudeRemoteIdleReclaimTimeoutMinutes).data
      ?? CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteIdleReclaimTimeoutMinutes,
    claudeUnifiedTerminalEnabled: readBoolean('claudeUnifiedTerminalEnabled'),
    claudeUnifiedTerminalQuestionResponseLocation: responseLocations.question,
    claudeUnifiedTerminalPermissionResponseLocation: responseLocations.permission,
    claudeUnifiedTerminalHost:
      normalizeClaudeUnifiedTerminalHost(settings.claudeUnifiedTerminalHost)
      ?? CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeUnifiedTerminalHost,
    claudeUnifiedTerminalResumeChoice:
      normalizeClaudeUnifiedTerminalResumeChoice(settings.claudeUnifiedTerminalResumeChoice)
      ?? CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeUnifiedTerminalResumeChoice,
    claudeUnifiedTerminalWorkspaceTrust:
      normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(settings.claudeUnifiedTerminalWorkspaceTrust)
      ?? CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeUnifiedTerminalWorkspaceTrust,
    claudeRemoteSettingSourcesV2: effectiveV2,
    ...(legacyFromV2 ? { claudeRemoteSettingSources: legacyFromV2 } : {}),
    claudeCodeIncludeInNativeHistory: readBoolean('claudeCodeIncludeInNativeHistory'),
    claudeCodeExperimentalAgentTeamsEnabled: readBoolean('claudeCodeExperimentalAgentTeamsEnabled'),
    claudeLocalPermissionBridgeEnabled: readBoolean('claudeLocalPermissionBridgeEnabled'),
    claudeLocalPermissionBridgeWaitIndefinitely: readBoolean('claudeLocalPermissionBridgeWaitIndefinitely'),
    claudeLocalPermissionBridgeTimeoutSeconds: readNumber('claudeLocalPermissionBridgeTimeoutSeconds'),
    claudeRemoteEnableFileCheckpointing: readBoolean('claudeRemoteEnableFileCheckpointing'),
    claudeRemoteMaxThinkingTokens: typeof settings.claudeRemoteMaxThinkingTokens === 'number' ? settings.claudeRemoteMaxThinkingTokens : null,
    claudeRemoteDisableTodos: readBoolean('claudeRemoteDisableTodos'),
    claudeRemoteStrictMcpServerConfig: readBoolean('claudeRemoteStrictMcpServerConfig'),
    claudeRemoteDebugEnabled: readBoolean('claudeRemoteDebugEnabled'),
    claudeRemoteVerboseEnabled: readBoolean('claudeRemoteVerboseEnabled'),
    claudeRemoteDebugCategories: debugCategories,
    claudeRemoteAdvancedOptionsJson: normalizeClaudeRemoteAdvancedOptionsJson(settings.claudeRemoteAdvancedOptionsJson),
  };
}

export const CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'claude',
  fields: CLAUDE_REMOTE_PROVIDER_ARTIFACTS.definitions,
  buildOutgoingMessageMetaExtras: ({ settings }) => buildClaudeRemoteOutgoingMessageMetaExtras(settings),
});
