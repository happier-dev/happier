import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '../plugins/contributions/strictJsonValue.js';

/** Maximum serialized UTF-8 bytes for one complete public Action response envelope. */
export const EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES = 24_000_000;

/** Maximum code units in the opaque public Action path identity. */
export const EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH = 256;

/** Maximum code units in one external Action request identity. */
export const EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1 = 128;

const MAXIMUM_UTF8_EXTERNAL_ACTION_ID_V1 = '😀'.repeat(EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH / 2);
const MAXIMUM_UTF8_EXTERNAL_ACTION_REQUEST_ID_V1 = '😀'.repeat(
  EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1 / 2,
);

/** Measures a result inside the largest valid public Action response framing. */
export function measureExternalActionResultResponseEnvelopeUtf8BytesV1(result: unknown): number {
  return measureSerializedValidatedStrictPluginJsonUtf8Bytes({
    v: 1,
    actionId: MAXIMUM_UTF8_EXTERNAL_ACTION_ID_V1,
    requestId: MAXIMUM_UTF8_EXTERNAL_ACTION_REQUEST_ID_V1,
    execution: { ok: true, result },
  }, 'externalActionResultResponse');
}

/** Whether a strict-JSON result fits the complete public Action response envelope. */
export function isExternalActionResultWithinResponseEnvelopeLimitV1(result: unknown): boolean {
  try {
    return measureExternalActionResultResponseEnvelopeUtf8BytesV1(result)
      <= EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES;
  } catch {
    return false;
  }
}
