import type { AgentAccountUsageMeter } from '@happier-dev/plugin-sdk/agents/runtime';

import { mapCodexRateLimitSnapshotToUsageMeters } from './rateLimitSnapshot.js';

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

export function resolveCodexRuntimeRateLimitsState(
  rawSnapshot: unknown,
  meters?: readonly AgentAccountUsageMeter[],
): CodexRuntimeRateLimitsState {
  if (rawSnapshot === undefined) return { status: 'not_loaded' };
  return (meters ?? mapCodexRateLimitSnapshotToUsageMeters(rawSnapshot)).length > 0
    ? { status: 'loaded_data', rawSnapshot }
    : { status: 'loaded_empty', rawSnapshot };
}
