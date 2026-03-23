import { z } from 'zod';
import { buildSettingArtifacts, type SettingDefinitionMap } from '@happier-dev/protocol';

import type { ProviderSettingsDefinition } from '../types.js';

export const MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS = 16_384;

const CLAUDE_SETTING_SOURCES_V2 = ['user', 'project', 'local'] as const;
export type ClaudeSettingSourceV2 = (typeof CLAUDE_SETTING_SOURCES_V2)[number];

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

export const CLAUDE_REMOTE_PROVIDER_FIELDS = {
  claudeRemoteAgentSdkEnabled: {
    schema: z.boolean(),
    default: true,
    description: 'Use Claude Agent SDK in remote mode',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
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
  claudeRemoteIncludePartialMessages: {
    schema: z.boolean(),
    default: false,
    description: 'Show partial assistant messages while Claude is responding',
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

  return {
    claudeRemoteAgentSdkEnabled: Boolean(settings.claudeRemoteAgentSdkEnabled),
    claudeRemoteSettingSourcesV2: effectiveV2,
    ...(legacyFromV2 ? { claudeRemoteSettingSources: legacyFromV2 } : {}),
    claudeRemoteIncludePartialMessages: Boolean(settings.claudeRemoteIncludePartialMessages),
    claudeCodeExperimentalAgentTeamsEnabled: Boolean(settings.claudeCodeExperimentalAgentTeamsEnabled),
    claudeLocalPermissionBridgeEnabled: Boolean(settings.claudeLocalPermissionBridgeEnabled),
    claudeLocalPermissionBridgeWaitIndefinitely: Boolean(settings.claudeLocalPermissionBridgeWaitIndefinitely),
    claudeLocalPermissionBridgeTimeoutSeconds: typeof settings.claudeLocalPermissionBridgeTimeoutSeconds === 'number'
      ? settings.claudeLocalPermissionBridgeTimeoutSeconds
      : 600,
    claudeRemoteEnableFileCheckpointing: Boolean(settings.claudeRemoteEnableFileCheckpointing),
    claudeRemoteMaxThinkingTokens: typeof settings.claudeRemoteMaxThinkingTokens === 'number' ? settings.claudeRemoteMaxThinkingTokens : null,
    claudeRemoteDisableTodos: Boolean(settings.claudeRemoteDisableTodos),
    claudeRemoteStrictMcpServerConfig: Boolean(settings.claudeRemoteStrictMcpServerConfig),
    claudeRemoteAdvancedOptionsJson: normalizeClaudeRemoteAdvancedOptionsJson(settings.claudeRemoteAdvancedOptionsJson),
  };
}

export const CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'claude',
  fields: CLAUDE_REMOTE_PROVIDER_ARTIFACTS.definitions,
  buildOutgoingMessageMetaExtras: ({ settings }) => buildClaudeRemoteOutgoingMessageMetaExtras(settings),
});
