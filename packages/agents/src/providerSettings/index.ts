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
  normalizeCodexBackendMode,
  resolveCodexSpawnExtrasFromSettings,
} from './definitions/codex.js';

export type { OpenCodeBackendMode, OpenCodeCliGeneration } from './definitions/opencode.js';
export {
  OPENCODE_PROVIDER_SETTINGS_DEFINITION,
  OPENCODE_PROVIDER_FIELDS,
  OPENCODE_PROVIDER_SETTINGS_DEFAULTS,
  buildOpenCodeProviderSettingsShape,
  normalizeOpenCodeBackendMode,
  normalizeOpenCodeCliGeneration,
  normalizeOpenCodeServerBaseUrl,
  normalizeOpenCodeServerBaseUrlExplicit,
  readOpenCodeExplicitServerBaseUrl,
} from './definitions/opencode.js';

export {
  CURSOR_PROVIDER_SETTINGS_DEFINITION,
  CURSOR_PROVIDER_FIELDS,
  CURSOR_PROVIDER_SETTINGS_DEFAULTS,
  buildCursorProviderSettingsShape,
  normalizeCursorAgentFallbackEnabled,
  normalizeCursorApiEndpoint,
  normalizeCursorBinaryPath,
  resolveCursorSpawnExtrasFromSettings,
} from './definitions/cursor.js';

export {
  KIMI_PROVIDER_SETTINGS_DEFINITION,
  KIMI_PROVIDER_FIELDS,
  KIMI_PROVIDER_SETTINGS_DEFAULTS,
  buildKimiProviderSettingsShape,
} from './definitions/kimi.js';

export {
  type ClaudeUnifiedTerminalHost,
  type ClaudeUnifiedTerminalResumeChoice,
  type ClaudeUnifiedTerminalResponseLocation,
  type ClaudeUnifiedTerminalWorkspaceTrust,
  type ClaudeUnifiedTerminalWorkspaceTrustPolicy,
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFINITION,
  CLAUDE_REMOTE_PROVIDER_FIELDS,
  MAX_CLAUDE_REMOTE_IDLE_RECLAIM_TIMEOUT_MINUTES,
  CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS,
  CLAUDE_UNIFIED_TERMINAL_HOSTS,
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS,
  CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES,
  MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS,
  buildClaudeRemoteOutgoingMessageMetaExtras,
  buildClaudeRemoteProviderSettingsShape,
  isValidClaudeRemoteAdvancedOptionsJson,
  normalizeClaudeRemoteAdvancedOptionsJson,
  resolveClaudeUnifiedTerminalResponseLocations,
} from './definitions/claudeRemote.js';
