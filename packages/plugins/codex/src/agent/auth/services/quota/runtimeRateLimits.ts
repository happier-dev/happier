import { unwrapCodexRateLimitSnapshot } from './rateLimitSnapshot.js';

export type CodexRuntimeRateLimitsClient = Readonly<{
  request: (method: 'account/rateLimits/read', params: null | Record<string, never>) => Promise<unknown>;
}>;

export type CodexRuntimeRateLimitsReadResult = Readonly<{
  status: 'loaded';
  paramsUsed: 'null' | 'empty_object';
  rawSnapshot: unknown;
}>;

export type CodexRuntimeRateLimitsState =
  | Readonly<{ status: 'not_loaded' }>
  | Readonly<{ status: 'loaded_empty'; rawSnapshot: unknown }>
  | Readonly<{ status: 'loaded_data'; rawSnapshot: unknown }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasMeterEvidence(value: unknown): boolean {
  const snapshot = isRecord(unwrapCodexRateLimitSnapshot(value))
    ? unwrapCodexRateLimitSnapshot(value) as Record<string, unknown>
    : null;
  if (!snapshot) return false;
  for (const key of ['primary', 'secondary', 'primary_window', 'secondary_window', 'primaryWindow', 'secondaryWindow']) {
    if (isRecord(snapshot[key]) && Object.keys(snapshot[key]).length > 0) return true;
  }
  return false;
}

export async function readCodexRuntimeRateLimitsSnapshot(
  client: CodexRuntimeRateLimitsClient,
): Promise<CodexRuntimeRateLimitsReadResult> {
  try {
    return {
      status: 'loaded',
      paramsUsed: 'null',
      rawSnapshot: await client.request('account/rateLimits/read', null),
    };
  } catch (firstError) {
    try {
      return {
        status: 'loaded',
        paramsUsed: 'empty_object',
        rawSnapshot: await client.request('account/rateLimits/read', {}),
      };
    } catch {
      throw firstError;
    }
  }
}

export function resolveCodexRuntimeRateLimitsState(rawSnapshot: unknown): CodexRuntimeRateLimitsState {
  if (rawSnapshot === undefined) return { status: 'not_loaded' };
  return hasMeterEvidence(rawSnapshot)
    ? { status: 'loaded_data', rawSnapshot }
    : { status: 'loaded_empty', rawSnapshot };
}
