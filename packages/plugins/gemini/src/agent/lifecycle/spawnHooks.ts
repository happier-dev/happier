import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import {
  resolveGeminiApiKeyFromEnv,
  resolveGeminiAuthConfig,
} from '../auth/resolution.js';

type GeminiDaemonSpawnHookContext = Partial<PluginInvocationContext> & Readonly<{
  processEnv?: Readonly<Record<string, string | undefined>>;
}>;

type GeminiDaemonSpawnPrerequisiteResult =
  | Readonly<{ decision: 'allow' }>
  | Readonly<{ decision: 'deny'; reasonCode: string; errorMessage: string }>;

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
  event: unknown,
  context?: GeminiDaemonSpawnHookContext,
): Readonly<Record<string, string | undefined>> {
  const eventRecord = readRecord(event);
  const payload = readRecord(eventRecord?.payload) ?? eventRecord;
  const runtimeSelection = readRecord(payload?.runtimeSelection) ?? payload;
  return {
    ...(context?.processEnv ?? {}),
    ...(readStringRecord(runtimeSelection?.env) ?? {}),
    ...(readStringRecord(payload?.env) ?? {}),
  };
}

function denyGeminiSpawn(errorMessage: string): GeminiDaemonSpawnPrerequisiteResult {
  return {
    decision: 'deny',
    reasonCode: 'gemini_acp_credentials_unavailable',
    errorMessage,
  };
}

export async function resolveGeminiDaemonSpawnPrerequisites(
  event: unknown,
  context?: GeminiDaemonSpawnHookContext,
): Promise<GeminiDaemonSpawnPrerequisiteResult> {
  const env = readMaterializedEnv(event, context);
  try {
    resolveGeminiAuthConfig(env, resolveGeminiApiKeyFromEnv(env));
    return { decision: 'allow' };
  } catch (error) {
    return denyGeminiSpawn(error instanceof Error ? error.message : String(error));
  }
}
