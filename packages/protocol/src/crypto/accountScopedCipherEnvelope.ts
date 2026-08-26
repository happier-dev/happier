import { decodeBase64 } from './base64.js';

/**
 * Versioned Account ciphertext domains. The envelope reader owns this wire
 * allocation independently of the secretbox implementation so structural
 * admission can remain browser-safe.
 */
export type AccountScopedBlobKind =
  | 'account_settings'
  | 'account_session_draft_private_payload'
  | 'action_operation_snapshot'
  | 'automation_conversation_reply_context'
  | 'automation_reply_handoff_receipt'
  | 'automation_run_result'
  | 'automation_run_failure_detail'
  | 'automation_session_start_request'
  | 'automation_trigger_definition'
  | 'automation_trigger_evidence'
  | 'automation_template_payload'
  | 'connected_service_credential'
  | 'connected_service_quota_snapshot'
  | 'provider_account_usage_snapshot'
  | 'qualified_connected_account_attempt_transaction'
  | 'qualified_connected_account_configuration'
  | 'plugin_declarative_settings'
  | 'plugin_collection_private_payload'
  | 'plugin_account_kv_private_payload'
  | 'review_comment_event_sensitive'
  | 'review_comment_sensitive'
  | 'session_first_intent'
  | 'session_owner_metadata'
  | 'session_organization_display'
  | 'session_respawn_environment';

export const ACCOUNT_SCOPED_BLOB_V1_MAGIC = 0xa1;
export const ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES = 2;
export const ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES = 24;
export const ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES = 16;

const ACCOUNT_SCOPED_KIND_BYTE = Object.freeze({
  account_settings: 1,
  automation_template_payload: 2,
  connected_service_credential: 3,
  connected_service_quota_snapshot: 4,
  session_respawn_environment: 5,
  provider_account_usage_snapshot: 6,
  session_organization_display: 7,
  session_first_intent: 8,
  qualified_connected_account_configuration: 9,
  account_session_draft_private_payload: 10,
  review_comment_sensitive: 11,
  review_comment_event_sensitive: 12,
  plugin_declarative_settings: 13,
  automation_run_result: 14,
  automation_conversation_reply_context: 15,
  automation_reply_handoff_receipt: 16,
  plugin_collection_private_payload: 17,
  plugin_account_kv_private_payload: 18,
  automation_trigger_evidence: 19,
  automation_trigger_definition: 20,
  automation_session_start_request: 21,
  automation_run_failure_detail: 22,
  action_operation_snapshot: 23,
  qualified_connected_account_attempt_transaction: 24,
  session_owner_metadata: 26,
} satisfies Record<AccountScopedBlobKind, number>);

/**
 * Returns the canonical padded-base64 size of one account-scoped v1 ciphertext
 * for a JSON plaintext with the given UTF-8 byte length.
 */
export function getAccountScopedBlobCiphertextBase64LengthV1(
  plaintextUtf8Bytes: number,
): number {
  if (!Number.isSafeInteger(plaintextUtf8Bytes) || plaintextUtf8Bytes < 0) {
    throw new Error('Account-scoped ciphertext plaintext length must be a non-negative safe integer');
  }
  const rawCiphertextBytes = (
    ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES
    + ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES
    + ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES
    + plaintextUtf8Bytes
  );
  if (!Number.isSafeInteger(rawCiphertextBytes)) {
    throw new Error('Account-scoped ciphertext length exceeds the safe integer range');
  }
  return 4 * Math.ceil(rawCiphertextBytes / 3);
}

export function getAccountScopedBlobKindByte(kind: AccountScopedBlobKind): number {
  return ACCOUNT_SCOPED_KIND_BYTE[kind];
}

export function readAccountScopedCiphertextKindByte(
  ciphertext: string,
): number | null {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(ciphertext, 'base64');
  } catch {
    return null;
  }
  if (
    bytes.length < (
      ACCOUNT_SCOPED_BLOB_V1_PREFIX_BYTES
      + ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES
      + ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES
    )
    || bytes[0] !== ACCOUNT_SCOPED_BLOB_V1_MAGIC
  ) {
    return null;
  }
  return bytes[1] ?? null;
}

export function isAccountScopedBlobCiphertextForKind(params: Readonly<{
  kind: AccountScopedBlobKind;
  ciphertext: string;
}>): boolean {
  return readAccountScopedCiphertextKindByte(params.ciphertext)
    === getAccountScopedBlobKindByte(params.kind);
}
