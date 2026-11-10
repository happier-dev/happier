import { deriveTriageListFieldUtf8BytesV1 } from './listFieldAllocation.js';

export * from './constants.js';

/**
 * Shared finite 56-row/32-lane presentation and control allocation, derived
 * from the same pure schemas the sources and aggregate instantiate and the
 * canonical public Action response envelope. Provider-sized collections retain
 * the host envelope as their governor; configured-instance storage stays stable.
 */
const listFieldUtf8Bytes = deriveTriageListFieldUtf8BytesV1();

/** Display truncation sets the existing row-local `projectionTruncated` marker. */
export const MAX_TRIAGE_TEXT_UTF8_BYTES_V1 = listFieldUtf8Bytes;
/** Omit an oversized optional URL or path; shortening it names another destination. */
export const MAX_TRIAGE_LOCATION_UTF8_BYTES_V1 = listFieldUtf8Bytes;
/** Source-private current route: retain native validation and omit rather than shorten. */
export const MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1 = listFieldUtf8Bytes;
/** Invocation-local opaque frontier; the allocation preserves every admitted lane's token. */
export const MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 = listFieldUtf8Bytes;
/** Bounded non-secret failure detail and provider-required permission description. */
export const MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1 = listFieldUtf8Bytes;
/** A projected fact's source-local id, label or rendered value; the full set stays uncapped. */
export const MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1 = listFieldUtf8Bytes;
