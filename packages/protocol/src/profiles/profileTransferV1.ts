import tweetnacl from 'tweetnacl';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import {
  PROFILE_TRANSFER_ACCOUNT_SCOPED_BLOB_KIND_V1, ProfileTransferControlV1Schema,
  StoredProfileTransferContentV1Schema, StoredProfileTransferControlV1Schema,
  assertProfileTransferContentForModeV1, type ProfileTransferControlV1, type ProfileTransferContentV1,
} from './profileTransferSchemaV1.js';

export * from './profileTransferSchemaV1.js';

/** Only the authorized Account client opens E2EE transfer authority. */
export function openProfileTransferContentV1(input: Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; content: unknown;
}>): Readonly<{ status: 'opened'; record: ProfileTransferControlV1 }> | Readonly<{
  status: 'unavailable'; reason: 'account-mode-mismatch' | 'encryption-material-unavailable' | 'invalid-stored-content';
}> {
  const parsed = StoredProfileTransferContentV1Schema.safeParse(input.content);
  if (!parsed.success) return { status: 'unavailable', reason: 'invalid-stored-content' };
  try { assertProfileTransferContentForModeV1(parsed.data, input.mode); }
  catch { return { status: 'unavailable', reason: 'account-mode-mismatch' }; }
  if (input.mode === 'plain' && input.material !== null) return { status: 'unavailable', reason: 'account-mode-mismatch' };
  let payload: unknown;
  if (parsed.data.t === 'plain') payload = parsed.data.v;
  else {
    if (!input.material) return { status: 'unavailable', reason: 'encryption-material-unavailable' };
    payload = openAccountScopedBlobCiphertext({ kind: PROFILE_TRANSFER_ACCOUNT_SCOPED_BLOB_KIND_V1, material: input.material, ciphertext: parsed.data.c })?.value;
  }
  const record = StoredProfileTransferControlV1Schema.safeParse(payload);
  return record.success ? { status: 'opened', record: record.data } : { status: 'unavailable', reason: 'invalid-stored-content' };
}

export function sealProfileTransferContentV1(input: Readonly<{
  mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; record: ProfileTransferControlV1;
  randomBytes?: (length: number) => Uint8Array;
}>): ProfileTransferContentV1 {
  const record = ProfileTransferControlV1Schema.parse(input.record);
  if (input.mode === 'plain') {
    if (input.material !== null) throw new Error('account-mode-mismatch');
    return { t: 'plain', v: record };
  }
  if (!input.material) throw new Error('encryption-material-unavailable');
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: PROFILE_TRANSFER_ACCOUNT_SCOPED_BLOB_KIND_V1,
    material: input.material, payload: record, randomBytes: input.randomBytes ?? tweetnacl.randomBytes }) };
}
