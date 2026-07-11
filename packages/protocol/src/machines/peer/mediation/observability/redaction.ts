import type { z } from 'zod';

import { isUnsafeTelemetryDataKey } from '../../../../common/sensitiveKeys.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rejectUnsafePeerMediationObservabilityDataKeys(
  value: unknown,
  context: z.RefinementCtx,
  path: readonly (string | number)[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsafePeerMediationObservabilityDataKeys(item, context, [...path, index]));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    if (isUnsafeTelemetryDataKey(key)) {
      context.addIssue({
        code: 'custom',
        path: [...path, key],
        message: 'Peer mediation observability data must not contain bodies, payloads, cookies, tokens, or grant material.',
      });
      continue;
    }
    rejectUnsafePeerMediationObservabilityDataKeys(nested, context, [...path, key]);
  }
}
