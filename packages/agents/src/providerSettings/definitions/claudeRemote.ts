import type * as z from 'zod';

import type { ProviderSettingsDefinition } from '../types.js';

export const MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS = 16_384;

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
  claudeRemoteSettingSources: 'project' as 'project' | 'user_project' | 'none',
  claudeRemoteIncludePartialMessages: false,
  claudeLocalPermissionBridgeEnabled: false,
  claudeLocalPermissionBridgeWaitIndefinitely: false,
  claudeLocalPermissionBridgeTimeoutSeconds: 600,
  claudeRemoteEnableFileCheckpointing: false,
  claudeRemoteMaxThinkingTokens: null as number | null,
  claudeRemoteDisableTodos: false,
  claudeRemoteStrictMcpServerConfig: false,
  claudeRemoteAdvancedOptionsJson: '',
});

export function buildClaudeRemoteProviderSettingsShape(zod: typeof z): z.ZodRawShape {
  return {
    claudeRemoteAgentSdkEnabled: zod.boolean(),
    claudeRemoteSettingSources: zod.enum(['project', 'user_project', 'none']),
    claudeRemoteIncludePartialMessages: zod.boolean(),
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
  return {
    claudeRemoteAgentSdkEnabled: Boolean(settings.claudeRemoteAgentSdkEnabled),
    claudeRemoteSettingSources: typeof settings.claudeRemoteSettingSources === 'string' ? settings.claudeRemoteSettingSources : 'project',
    claudeRemoteIncludePartialMessages: Boolean(settings.claudeRemoteIncludePartialMessages),
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
