import {
  resolveGeminiApiKeyFromEnv,
  resolveGeminiAuthConfig,
} from '../auth/resolution.js';

type GeminiDaemonSpawnPrerequisiteResult = Readonly<{
  allowed: boolean;
  reasonCode?: string;
  errorMessage?: string;
}>;

type GeminiDaemonHookEvent = Readonly<{
  payload?: unknown;
}>;

type GeminiDaemonSpawnHookContext = Readonly<{
  processEnv?: Readonly<Record<string, string | undefined>>;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readStringRecord(value: unknown): Readonly<Record<string, string | undefined>> | null {
  const record = readRecord(value);
  if (!record) return null;
  const entries = Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : {};
}

function readMaterializedEnv(
  event: GeminiDaemonHookEvent,
  context?: GeminiDaemonSpawnHookContext,
): Readonly<Record<string, string | undefined>> {
  const payload = readRecord(event.payload);
  const runtimeSelection = readRecord(payload?.runtimeSelection) ?? readRecord(event);
  return {
    ...(context?.processEnv ?? {}),
    ...(readStringRecord(runtimeSelection?.env) ?? {}),
    ...(readStringRecord(payload?.env) ?? {}),
  };
}

function denyGeminiSpawn(errorMessage: string): GeminiDaemonSpawnPrerequisiteResult {
  return {
    allowed: false,
    reasonCode: 'gemini_acp_credentials_unavailable',
    errorMessage,
  };
}

export async function resolveGeminiDaemonSpawnPrerequisites(
  event: GeminiDaemonHookEvent,
  context?: GeminiDaemonSpawnHookContext,
): Promise<GeminiDaemonSpawnPrerequisiteResult> {
  const env = readMaterializedEnv(event, context);
  try {
    resolveGeminiAuthConfig(env, resolveGeminiApiKeyFromEnv(env));
    return { allowed: true };
  } catch (error) {
    return denyGeminiSpawn(error instanceof Error ? error.message : String(error));
  }
}
