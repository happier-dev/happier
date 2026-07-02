export type OpenCodeBackendMode = 'server' | 'acp';

export const OPEN_CODE_BACKEND_MODE_ENV_KEY = 'HAPPIER_OPENCODE_BACKEND_MODE';

export type OpenCodeBackendModeInput = Readonly<{
  env?: Readonly<Record<string, string | undefined>> | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>;

function normalizeOpenCodeBackendMode(value: unknown): OpenCodeBackendMode {
  return value === 'acp' ? 'acp' : 'server';
}

export function resolveOpenCodeBackendMode(input: OpenCodeBackendModeInput): OpenCodeBackendMode {
  const rawEnvMode =
    typeof input.env?.[OPEN_CODE_BACKEND_MODE_ENV_KEY] === 'string'
      ? input.env[OPEN_CODE_BACKEND_MODE_ENV_KEY]?.trim().toLowerCase()
      : '';
  if (rawEnvMode === 'acp') return 'acp';

  if (input.accountSettings) {
    return normalizeOpenCodeBackendMode(input.accountSettings.opencodeBackendMode);
  }

  return 'server';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readEnvRecord(value: unknown): Readonly<Record<string, string | undefined>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries: Array<[string, string | undefined]> = [];
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'undefined') entries.push([key, raw]);
  }
  return Object.fromEntries(entries);
}

export function readOpenCodeBackendModeInputFromRuntimeParams(params: unknown): OpenCodeBackendModeInput {
  if (!isRecord(params)) return {};

  const isolation = isRecord(params.isolation) ? params.isolation : undefined;
  return {
    env: readEnvRecord(isolation?.env) ?? readEnvRecord(params.env),
    accountSettings: isRecord(params.accountSettings) ? params.accountSettings : null,
  };
}
