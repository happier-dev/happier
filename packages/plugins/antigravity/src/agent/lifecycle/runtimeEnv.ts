import { HAPPIER_ANTIGRAVITY_RUNTIME_MODE_ENV_KEY } from './runtimeMode.js';

export const ANTIGRAVITY_SDK_ONLY_ENV_KEYS = Object.freeze([
  HAPPIER_ANTIGRAVITY_RUNTIME_MODE_ENV_KEY,
  'ANTIGRAVITY_AUTH_MODE',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI',
] as const);

const ANTIGRAVITY_SDK_ONLY_ENV_KEY_SET = new Set<string>(ANTIGRAVITY_SDK_ONLY_ENV_KEYS);

export function isolateAntigravityCliPrintEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | undefined {
  const entries = Object.entries(env).filter((entry): entry is [string, string] => (
    typeof entry[1] === 'string' && !ANTIGRAVITY_SDK_ONLY_ENV_KEY_SET.has(entry[0])
  ));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildAntigravityCliModelsProbeEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  return {
    ...(isolateAntigravityCliPrintEnv(env ?? {}) ?? {}),
    CI: '1',
  };
}

function hasNonEmptyEnv(env: Readonly<Record<string, string | undefined>>, key: string): boolean {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0;
}

export function hasAntigravitySdkCredentialEnv(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (hasNonEmptyEnv(env, 'GEMINI_API_KEY') || hasNonEmptyEnv(env, 'GOOGLE_API_KEY')) return true;
  const useVertex = env.GOOGLE_GENAI_USE_VERTEXAI?.trim().toLowerCase();
  return (useVertex === '1' || useVertex === 'true')
    && hasNonEmptyEnv(env, 'GOOGLE_CLOUD_PROJECT')
    && hasNonEmptyEnv(env, 'GOOGLE_CLOUD_LOCATION');
}
