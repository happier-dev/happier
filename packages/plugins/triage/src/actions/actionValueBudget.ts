/**
 * The one transport budget shared by every Triage Action value.
 *
 * `AgentRuntimeJsonValueV1Schema` rejects the complete encoded value at 1 MiB.
 * The protocol package is development-only here, so production cannot import
 * that host schema; `maximumEncodedActionValue.test.ts` measures these derived
 * values through the real owner and catches drift at the boundary.
 */
export const TRIAGE_ACTION_VALUE_GATE_UTF8_BYTES_V1 = 1_024 * 1_024;

/** Headroom used by the Session-start prompt budget; list paging derives directly from its full frame. */
export const TRIAGE_ACTION_VALUE_MARGIN_UTF8_BYTES_V1 = 32 * 1_024;
