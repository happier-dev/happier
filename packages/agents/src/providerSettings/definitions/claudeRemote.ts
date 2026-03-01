import type { z } from 'zod';

import type { ProviderSettingsDefinition, ProviderSettingsShape } from '../types.js';

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

export const CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS = Object.freeze({
  claudeRemoteAgentSdkEnabled: true,
  /**
   * Legacy (v1) setting sources.
   *
   * Kept for back-compat with older clients that haven't shipped the multi-select UI yet.
   * Prefer `claudeRemoteSettingSourcesV2`.
   */
  claudeRemoteSettingSources: 'user_project' as 'project' | 'user_project' | 'none',
  /**
   * v2 setting sources (multi-select).
   *
   * Default: all sources selected to match Claude Code's default behavior.
   * When all are selected, the runners should avoid forcing an explicit override and let
   * Claude apply its own defaults (future-proof).
   */
  claudeRemoteSettingSourcesV2: ['user', 'project', 'local'] as readonly ClaudeSettingSourceV2[],
  claudeRemoteIncludePartialMessages: false,
  // Force-enable Claude Code experimental Agent Teams (aka "agent swarm") across local + remote starts.
  // When false, Happier does not override Claude's default behavior.
  claudeCodeExperimentalAgentTeamsEnabled: false,
  claudeLocalPermissionBridgeEnabled: true,
  claudeLocalPermissionBridgeWaitIndefinitely: false,
  claudeLocalPermissionBridgeTimeoutSeconds: 600,
  claudeRemoteEnableFileCheckpointing: false,
  claudeRemoteMaxThinkingTokens: null as number | null,
  claudeRemoteDisableTodos: false,
  claudeRemoteStrictMcpServerConfig: false,
  claudeRemoteAdvancedOptionsJson: '',
});

export function buildClaudeRemoteProviderSettingsShape(zod: typeof z): ProviderSettingsShape {
  return {
    claudeRemoteAgentSdkEnabled: zod.boolean(),
    claudeRemoteSettingSources: zod.enum(['project', 'user_project', 'none']),
    claudeRemoteSettingSourcesV2: zod.array(zod.enum(['user', 'project', 'local'])).max(3),
    claudeRemoteIncludePartialMessages: zod.boolean(),
    claudeCodeExperimentalAgentTeamsEnabled: zod.boolean(),
    claudeLocalPermissionBridgeEnabled: zod.boolean(),
    claudeLocalPermissionBridgeWaitIndefinitely: zod.boolean(),
    claudeLocalPermissionBridgeTimeoutSeconds: zod.number().int().positive(),
    claudeRemoteEnableFileCheckpointing: zod.boolean(),
    claudeRemoteMaxThinkingTokens: zod.number().int().positive().nullable(),
    claudeRemoteDisableTodos: zod.boolean(),
    claudeRemoteStrictMcpServerConfig: zod.boolean(),
    claudeRemoteAdvancedOptionsJson: zod.string().refine(isValidClaudeRemoteAdvancedOptionsJson, {
      message: 'Must be empty or a valid JSON object string',
    }),
  } as const;
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
        ? (mapLegacyClaudeSettingSourcesToV2(normalizedLegacy) ?? CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteSettingSourcesV2)
        : CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS.claudeRemoteSettingSourcesV2;
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
  buildSettingsShape: buildClaudeRemoteProviderSettingsShape,
  settingsDefaults: CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
  buildOutgoingMessageMetaExtras: ({ settings }) => buildClaudeRemoteOutgoingMessageMetaExtras(settings),
});
