import { z } from 'zod';
import { buildSettingArtifacts, type SettingDefinitionMap } from '@happier-dev/protocol';

import type { ProviderSettingsDefinition } from '../types.js';

export const MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS = 16_384;

const CLAUDE_SETTING_SOURCES_V2 = ['user', 'project', 'local'] as const;
export type ClaudeSettingSourceV2 = (typeof CLAUDE_SETTING_SOURCES_V2)[number];

const CLAUDE_REMOTE_DEBUG_CATEGORIES = ['api', 'mcp', 'hooks', 'file', '1p'] as const;
export type ClaudeRemoteDebugCategory = (typeof CLAUDE_REMOTE_DEBUG_CATEGORIES)[number];

export const CLAUDE_UNIFIED_TERMINAL_HOSTS = ['auto', 'tmux', 'zellij'] as const;
export type ClaudeUnifiedTerminalHost = (typeof CLAUDE_UNIFIED_TERMINAL_HOSTS)[number];

export function normalizeClaudeUnifiedTerminalHost(raw: unknown): ClaudeUnifiedTerminalHost | null {
  if (typeof raw !== 'string') return null;
  return (CLAUDE_UNIFIED_TERMINAL_HOSTS as readonly string[]).includes(raw) ? (raw as ClaudeUnifiedTerminalHost) : null;
}

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
  claudeRemoteAgentSdkEnabled: {
    schema: z.boolean(),
    default: true,
    description: 'Use Claude Agent SDK in remote mode',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeUnifiedTerminalEnabled: {
    schema: z.boolean(),
    default: false,
    description: 'Enable Claude unified terminal runtime',
    storageScope: 'account',
    analytics: { trackCurrentState: true, trackChanges: true, valueKind: 'boolean', privacy: 'safe', identityScope: 'person' },
  },
  claudeUnifiedTerminalHost: {
    schema: z.enum(CLAUDE_UNIFIED_TERMINAL_HOSTS),
    default: 'auto' as ClaudeUnifiedTerminalHost,
    description: 'Claude unified terminal host adapter preference',
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

export const CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION: ProviderSettingsDefinition = Object.freeze({
  providerId: 'claude',
  fields: CLAUDE_REMOTE_PROVIDER_ARTIFACTS.definitions,
});
