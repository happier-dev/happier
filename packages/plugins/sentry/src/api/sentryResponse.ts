import type { SentryApiResponseV1 } from './sentryApiClient.js';
import { classifySentryFailure } from './sentryFailure.js';
import type { SentryFailureV1, SentryOperationV1 } from '../sentryContracts.js';

/** Provider status and JSON decoding share one boundary for every detail collection. */
export function decodeSentryResponse(
  response: SentryApiResponseV1,
  operation: SentryOperationV1,
  nowMs: number,
): Readonly<{ ok: true; body: unknown }> | Readonly<{ ok: false; failure: SentryFailureV1 }> {
  if (response.status !== 200) {
    return { ok: false, failure: classifySentryFailure({ kind: 'status', operation, nowMs, response }) };
  }
  try {
    return { ok: true, body: JSON.parse(response.bodyText) as unknown };
  } catch {
    return { ok: false, failure: classifySentryFailure({ kind: 'unparseable', operation }) };
  }
}
