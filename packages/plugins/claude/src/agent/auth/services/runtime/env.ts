const CONNECTED_SERVICE_SELECTIONS_ENV_KEY = 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';
const CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY = 'HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON';

export const CLAUDE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_SETUP_TOKEN',
] as const;

export type ClaudeAuthEnvKey = typeof CLAUDE_AUTH_ENV_KEYS[number];

export const CLAUDE_RUNTIME_REFRESH_SECRET_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
] as const satisfies readonly ClaudeAuthEnvKey[];

export const CLAUDE_CONFIG_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
] as const;

const CLAUDE_RUNTIME_AUTH_ENV_KEYS = [
  ...CLAUDE_AUTH_ENV_KEYS,
  ...CLAUDE_CONFIG_ENV_KEYS,
] as const;

export type ClaudeRuntimeAuthEnvDiagnostic = Readonly<{
  presentAuthEnvKeys: string[];
  hasAnthropicApiKey: boolean;
  hasAnthropicAuthToken: boolean;
  hasAnthropicOauthToken: boolean;
  hasClaudeCodeOauthToken: boolean;
  hasClaudeCodeSetupToken: boolean;
  hasClaudeCodeOauthRefreshToken: boolean;
  hasClaudeCodeOauthScopes: boolean;
  hasClaudeConfigDir: boolean;
  hasHappierConnectedServiceSelections: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function hasNonBlankEnvValue(env: Readonly<Record<string, string | undefined>>, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0;
}

function parseJsonArray(value: string | undefined): readonly unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readConnectedServiceId(
  env: Readonly<Record<string, string | undefined>>,
): 'claude-subscription' | 'anthropic' | null {
  let hasAnthropic = false;
  for (const item of parseJsonArray(env[CONNECTED_SERVICE_SELECTIONS_ENV_KEY])) {
    const serviceId = readString(isRecord(item) ? item.serviceId : null);
    if (serviceId === 'claude-subscription') return 'claude-subscription';
    if (serviceId === 'anthropic') hasAnthropic = true;
  }
  return hasAnthropic ? 'anthropic' : null;
}

function readMaterializedEnvKeys(
  env: Readonly<Record<string, string | undefined>>,
): Set<string> {
  const keys = new Set<string>();
  for (const item of parseJsonArray(env[CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY])) {
    const key = readString(item);
    if (key) keys.add(key);
  }
  return keys;
}

function stripConnectedServiceRuntimeMetadata(env: Record<string, string | undefined>): void {
  delete env[CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  delete env[CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY];
}

function resolveAllowedConnectedAuthEnvKeys(
  env: Readonly<Record<string, string | undefined>>,
): Set<ClaudeAuthEnvKey> | null {
  const serviceId = readConnectedServiceId(env);
  if (!serviceId) return null;

  const serviceAllowedKeys: readonly ClaudeAuthEnvKey[] = serviceId === 'anthropic'
    ? ['ANTHROPIC_API_KEY']
    : ['CLAUDE_CODE_OAUTH_TOKEN'];
  const materializedKeys = readMaterializedEnvKeys(env);
  if (materializedKeys.size === 0) return new Set(serviceAllowedKeys);

  return new Set(serviceAllowedKeys.filter((key) => materializedKeys.has(key)));
}

export function resolveClaudeRuntimeAuthEnvDiagnostic(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeRuntimeAuthEnvDiagnostic {
  const presentAuthEnvKeys = CLAUDE_RUNTIME_AUTH_ENV_KEYS
    .filter((key) => hasNonBlankEnvValue(env, key));

  return {
    presentAuthEnvKeys,
    hasAnthropicApiKey: hasNonBlankEnvValue(env, 'ANTHROPIC_API_KEY'),
    hasAnthropicAuthToken: hasNonBlankEnvValue(env, 'ANTHROPIC_AUTH_TOKEN'),
    hasAnthropicOauthToken: hasNonBlankEnvValue(env, 'ANTHROPIC_OAUTH_TOKEN'),
    hasClaudeCodeOauthToken: hasNonBlankEnvValue(env, 'CLAUDE_CODE_OAUTH_TOKEN'),
    hasClaudeCodeSetupToken: hasNonBlankEnvValue(env, 'CLAUDE_CODE_SETUP_TOKEN'),
    hasClaudeCodeOauthRefreshToken: hasNonBlankEnvValue(env, 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN'),
    hasClaudeCodeOauthScopes: hasNonBlankEnvValue(env, 'CLAUDE_CODE_OAUTH_SCOPES'),
    hasClaudeConfigDir: hasNonBlankEnvValue(env, 'CLAUDE_CONFIG_DIR'),
    hasHappierConnectedServiceSelections: hasNonBlankEnvValue(env, CONNECTED_SERVICE_SELECTIONS_ENV_KEY),
  };
}

export function isolateClaudeRuntimeAuthEnv<T extends Record<string, string | undefined>>(env: T): T {
  const allowedConnectedAuthKeys = resolveAllowedConnectedAuthEnvKeys(env);
  if (allowedConnectedAuthKeys) {
    for (const key of CLAUDE_AUTH_ENV_KEYS) {
      if (!allowedConnectedAuthKeys.has(key)) {
        delete env[key];
      }
    }
    stripConnectedServiceRuntimeMetadata(env);
    return env;
  }

  for (const key of CLAUDE_RUNTIME_REFRESH_SECRET_ENV_KEYS) {
    delete env[key];
  }
  stripConnectedServiceRuntimeMetadata(env);
  return env;
}
