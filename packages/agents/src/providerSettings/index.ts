export type {
  ProviderSettingsDefinition,
  ProviderSettingsBuildMessageMetaExtras,
  ProviderSettingsResolveSpawnExtras,
} from './types.js';

export {
  assertProviderSettingsRegistryValid,
  assertProviderSettingsRegistryValidFor,
  getAllProviderSettingsDefinitions,
  getProviderSettingsDefinition,
} from './registry.js';

export type { CodexBackendMode } from './definitions/codex.js';
export {
  CODEX_PROVIDER_SETTINGS_DEFINITION,
  CODEX_PROVIDER_FIELDS,
  CODEX_PROVIDER_SETTINGS_DEFAULTS,
  buildCodexProviderSettingsShape,
  resolveCodexSpawnExtrasFromSettings,
} from './definitions/codex.js';

export type { OpenCodeBackendMode } from './definitions/opencode.js';
export {
  OPENCODE_PROVIDER_SETTINGS_DEFINITION,
  OPENCODE_PROVIDER_FIELDS,
  OPENCODE_PROVIDER_SETTINGS_DEFAULTS,
  buildOpenCodeProviderSettingsShape,
  normalizeOpenCodeBackendMode,
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
  readOpenCodeExplicitServerBaseUrl,
} from './definitions/opencode.js';

export {
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION,
  CLAUDE_REMOTE_PROVIDER_FIELDS,
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
  MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS,
  buildClaudeRemoteOutgoingMessageMetaExtras,
  buildClaudeRemoteProviderSettingsShape,
  isValidClaudeRemoteAdvancedOptionsJson,
  normalizeClaudeRemoteAdvancedOptionsJson,
} from './definitions/claudeRemote.js';
