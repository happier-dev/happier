export type {
  ProviderSettingsDefinition,
  ProviderSettingsBuildMessageMetaExtras,
  ProviderSettingsBuildShape,
  ProviderSettingsResolveSpawnExtras,
} from './types.js';

export {
  assertProviderSettingsRegistryValid,
  getAllProviderSettingsDefinitions,
  getProviderSettingsDefinition,
} from './registry.js';

export type { CodexBackendMode } from './definitions/codex.js';
export {
  CODEX_PROVIDER_SETTINGS_DEFINITION,
  CODEX_PROVIDER_SETTINGS_DEFAULTS,
  buildCodexProviderSettingsShape,
  resolveCodexSpawnExtrasFromSettings,
} from './definitions/codex.js';

export {
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION,
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
  MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS,
  buildClaudeRemoteOutgoingMessageMetaExtras,
  buildClaudeRemoteProviderSettingsShape,
  isValidClaudeRemoteAdvancedOptionsJson,
  normalizeClaudeRemoteAdvancedOptionsJson,
} from './definitions/claudeRemote.js';

