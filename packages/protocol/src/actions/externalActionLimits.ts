import { getAccountScopedBlobCiphertextBase64LengthV1 } from '../crypto/accountScopedCipherEnvelope.js';
import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '../plugins/contributions/strictJsonValue.js';

/** Shared finite HTTP request ceiling for both public Action API origins. */
export const EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/** Maximum serialized UTF-8 bytes for one complete public Action response envelope. */
export const EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES = 24_000_000;

/**
 * Minimum Socket.IO capacity for a server-to-daemon Action request. This
 * leaves a 1 MiB carrier reserve above the admitted HTTP request body.
 */
export const EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES = 33 * 1024 * 1024;

/** Minimum Socket.IO capacity for a daemon-to-server Action response. */
export const EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES = 25_000_000;

/** Maximum code units in the opaque public Action path identity. */
export const EXTERNAL_ACTION_ACTION_ID_MAX_LENGTH = 256;

/** Maximum code units in one external Action request identity. */
export const EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1 = 128;

// Six bytes per code unit covers JSON escaping, including control characters.
// These small values model only fields with an actual scalar bound. The target
// and input already share the complete V1 request-byte ceiling and must never
// be materialized independently to calculate a transport reserve.
const maximumBindingId = '\u0000'.repeat(256);
const maximumRequestId = '\u0000'.repeat(EXTERNAL_ACTION_REQUEST_ID_MAX_LENGTH_V1);
const maximumServerIdentityId = `srv_${'s'.repeat(60)}`;
const maximumCredentialId = '00000000-0000-4000-8000-000000000000';
const maximumRequestPayloadDigest = 'x'.repeat(43);
const jsonNullBytes = 4;

function measureJsonUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('External Action framing must serialize to JSON');
  return new TextEncoder().encode(serialized).byteLength;
}

const maximumV1RequestSkeletonBytes = measureJsonUtf8Bytes({
  v: 1, requestId: maximumRequestId, target: null, input: null,
});
const maximumEncryptedRequestSkeletonBytes = measureJsonUtf8Bytes({
  v: 2, direction: 'request', serverIdentityId: maximumServerIdentityId,
  accountId: maximumBindingId, credentialId: maximumCredentialId,
  actionId: maximumBindingId, requestId: maximumRequestId,
  target: null, input: null,
});

/** Largest encrypted plaintext produced from one complete valid V1 request. */
export const EXTERNAL_ACTION_ENCRYPTED_REQUEST_PLAINTEXT_MAX_BYTES_V2 =
  EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES
  + maximumEncryptedRequestSkeletonBytes
  - maximumV1RequestSkeletonBytes;

const maximumV1ResponseSkeletonBytes = measureJsonUtf8Bytes({
  v: 1, actionId: maximumBindingId, requestId: maximumRequestId, execution: null,
});
const maximumEncryptedResponseSkeletonBytes = measureJsonUtf8Bytes({
  v: 2, direction: 'response', serverIdentityId: maximumServerIdentityId,
  accountId: maximumBindingId, credentialId: maximumCredentialId,
  actionId: maximumBindingId, requestId: maximumRequestId,
  target: null, executedMachineId: maximumBindingId,
  requestPayloadDigest: maximumRequestPayloadDigest, execution: null,
});

/**
 * Largest encrypted response plaintext. Its execution retains the complete V1
 * response budget and its authenticated target is bounded by the complete V1
 * request envelope that produced the response.
 */
export const EXTERNAL_ACTION_ENCRYPTED_RESPONSE_PLAINTEXT_MAX_BYTES_V2 =
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES
  + maximumEncryptedResponseSkeletonBytes
  - maximumV1ResponseSkeletonBytes
  - jsonNullBytes
  + EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES;

const maximumRequestOuterFixedBytes = measureJsonUtf8Bytes({
  v: 2, requestId: maximumRequestId, target: null,
  payload: { t: 'encrypted', c: '' },
}) - jsonNullBytes;
const maximumResponseOuterFixedBytes = measureJsonUtf8Bytes({
  v: 2, actionId: maximumBindingId, requestId: maximumRequestId,
  payload: { t: 'encrypted', c: '' },
});

export const EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2 =
  maximumRequestOuterFixedBytes
  + getAccountScopedBlobCiphertextBase64LengthV1(
    EXTERNAL_ACTION_ENCRYPTED_REQUEST_PLAINTEXT_MAX_BYTES_V2,
  );
const maximumPendingResetStartAdmission = {
  sessionDigest: maximumRequestPayloadDigest, sourceDigest: maximumRequestPayloadDigest,
  recordDigest: maximumRequestPayloadDigest, witnessDigest: maximumRequestPayloadDigest,
  mutationDigest: maximumRequestPayloadDigest,
};
export const EXTERNAL_ACTION_PENDING_RESET_START_ADMISSION_MAX_UTF8_BYTES_V2 = measureJsonUtf8Bytes(maximumPendingResetStartAdmission);
// Fixed canonical digests preserve unbounded valid identities without copying
// decoded input into either the protected body framing or signed HTTP headers.
export const EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2 = EXTERNAL_ACTION_ENCRYPTED_REQUEST_WITHOUT_RESET_ADMISSION_MAX_BYTES_V2
  + measureJsonUtf8Bytes({ pendingResetStartAdmission: maximumPendingResetStartAdmission }) - 2;
export const EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2 =
  maximumResponseOuterFixedBytes
  + getAccountScopedBlobCiphertextBase64LengthV1(
    EXTERNAL_ACTION_ENCRYPTED_RESPONSE_PLAINTEXT_MAX_BYTES_V2,
  );
export const EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES_V2 = EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES_V2
  + (EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES - EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES);
export const EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES_V2 = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES_V2
  + (EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES - EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);

/** Socket.IO floor shared by server admission and encrypted machine RPC replies. */
export const EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2 = Math.max(
  EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES_V2,
  EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES_V2,
);

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
