import type { ActionExecuteResult } from '@happier-dev/protocol';

import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
  type CliActionFailure,
} from './normalizeActionExecuteResult';

export type NormalizedSessionStartActionResults =
  | Readonly<{
    ok: true;
    results: readonly unknown[];
  }>
  | (CliActionFailure & Readonly<{ ok: false }>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeSessionStartActionResults(
  actionResult: ActionExecuteResult,
): NormalizedSessionStartActionResults {
  const normalized = normalizeActionExecuteResult(actionResult);
  if (!normalized.ok) {
    return normalized;
  }

  const payload = unwrapCliActionSuccessPayload(normalized.data);
  const results = isRecord(payload) && Array.isArray(payload.results)
    ? payload.results
    : [];
  return { ok: true, results };
}
