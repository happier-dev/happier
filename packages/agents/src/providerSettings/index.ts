export type {
  ProviderSettingsDescriptor,
  ProviderSettingsDefinition,
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
  normalizeCodexBackendMode,
} from './definitions/codex.js';

export {
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION,
  CLAUDE_REMOTE_PROVIDER_FIELDS,
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
  CLAUDE_UNIFIED_TERMINAL_HOSTS,
  MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS,
  buildClaudeRemoteProviderSettingsShape,
  isValidClaudeRemoteAdvancedOptionsJson,
  normalizeClaudeUnifiedTerminalHost,
  normalizeClaudeRemoteAdvancedOptionsJson,
} from './definitions/claudeRemote.js';
export type { ClaudeUnifiedTerminalHost } from './definitions/claudeRemote.js';

export type { KimiAcpPythonSelector } from './definitions/kimi.js';
export {
  KIMI_PROVIDER_SETTINGS_DEFINITION,
  KIMI_PROVIDER_FIELDS,
  KIMI_PROVIDER_SETTINGS_DEFAULTS,
  buildKimiProviderSettingsShape,
  normalizeKimiAcpPythonSelector,
  resolveKimiSpawnExtrasFromSettings,
} from './definitions/kimi.js';
