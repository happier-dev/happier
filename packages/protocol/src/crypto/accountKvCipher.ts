import nacl from 'tweetnacl';
import { resolveAccountContentSecretKey, type AccountScopedCryptoMaterial } from './accountScopedCipher.js';
import { decodeBase64, encodeBase64 } from './base64.js';
import { parseSerializedJsonValue } from './serializedJsonValue.js';
import type { SessionDataKeyOpenResult } from './sessionDataKeyBundleV0.js';
import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';

/** Platform adapters implement AES-GCM V0; selection and legacy reads live here. */
export type AccountKvDataKeyCipher = Readonly<{
  seal: (value: unknown) => Promise<string>;
  open: (encoded: string) => Promise<SessionDataKeyOpenResult>;
}>;
export type AccountKvCipher = Readonly<{
  seal: (value: unknown) => Promise<string>;
  open: (encoded: string) => Promise<Readonly<{ value: unknown; needsReseal: boolean }>>;
}>;

export class AccountKvCipherError extends Error {
  constructor(readonly code: 'account_stored_json_mode_mismatch' | 'account_kv_content_unreadable'
    | 'account_stored_json_encryption_material_unavailable') {
    super(code === 'account_stored_json_mode_mismatch'
      ? 'Stored Account content does not match its authoritative encryption mode'
      : code === 'account_stored_json_encryption_material_unavailable'
        ? 'Account encryption material is unavailable for encrypted content'
        : 'The encrypted Account KV record could not be opened');
    this.name = 'AccountKvCipherError';
  }
}

/** Persisted Account mode selects representation, never the writer's credential kind. */
export function createAccountKvCipher(params: Readonly<{
  mode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial | null;
  dataKeyCipher: (key: Uint8Array) => AccountKvDataKeyCipher;
}>): AccountKvCipher {
  // Plain Accounts do not even construct a key-bearing platform adapter.
  const material = params.mode === 'e2ee' ? params.material : null;
  if (params.mode === 'e2ee' && !material) {
    throw new AccountKvCipherError('account_stored_json_encryption_material_unavailable');
  }
  const aes = material ? params.dataKeyCipher(resolveAccountContentSecretKey(material)) : null;
  return {
    seal: async value => aes ? await aes.seal(value)
      : encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: value }))),
    open: async encoded => {
      let bytes: Uint8Array;
      try { bytes = decodeBase64(encoded); }
      catch { throw new AccountKvCipherError(params.mode === 'plain' ? 'account_stored_json_mode_mismatch' : 'account_kv_content_unreadable'); }
      let json: unknown;
      let isJson = false;
      try { json = JSON.parse(new TextDecoder().decode(bytes)); isJson = true; }
      catch { /* Released raw ciphertext has no JSON envelope. */ }
      const envelope = isJson ? StoredJsonContentEnvelopeSchema.safeParse(json) : null;
      if (isJson && !envelope?.success) throw new AccountKvCipherError('account_kv_content_unreadable');
      const content = envelope?.success ? envelope.data : null;
      if ((content?.t === 'plain' ? 'plain' : 'e2ee') !== params.mode) {
        throw new AccountKvCipherError('account_stored_json_mode_mismatch');
      }
      if (content?.t === 'plain') return { value: content.v, needsReseal: false };
      if (!aes) throw new AccountKvCipherError('account_stored_json_encryption_material_unavailable');
      const ciphertext = content?.t === 'encrypted' ? content.c : encoded;
      const opened = await aes.open(ciphertext);
      if (opened.status === 'authenticated') return { value: opened.value, needsReseal: false };
      // A legacy nonce may start with zero too. Only authentication decides which
      // cipher opened it; a failed AES attempt never authorizes plaintext fallback.
      if (material?.type === 'legacy') {
        try {
          const bundle = content?.t === 'encrypted' ? decodeBase64(content.c) : bytes;
          const plaintext = nacl.secretbox.open(bundle.subarray(nacl.secretbox.nonceLength),
            bundle.subarray(0, nacl.secretbox.nonceLength), material.secret);
          if (plaintext) return { value: parseSerializedJsonValue(new TextDecoder().decode(plaintext)), needsReseal: true };
        } catch { /* Authentication or JSON failure preserves the stored row. */ }
      }
      throw new AccountKvCipherError('account_kv_content_unreadable');
    },
  };
}

export type AccountKvEncodedSnapshot = Readonly<{ value: string | null; version: number }>;
export type AccountKvJsonSnapshot = Readonly<{ value: unknown; version: number; tombstone?: true }>;

/** One CAS attempt preserves the complete opened JSON before any domain projection. */
export async function openAccountKvJsonRow(params: Readonly<{
  row: AccountKvEncodedSnapshot;
  cipher: AccountKvCipher;
  requireCurrent: () => void;
  compareAndSet: (value: string, version: number) => Promise<
    Readonly<{ success: true; version: number }> | (AccountKvEncodedSnapshot & Readonly<{ success: false }>)>;
}>): Promise<AccountKvJsonSnapshot> {
  params.requireCurrent();
  if (params.row.value === null) return { value: null, version: params.row.version, tombstone: true };
  const opened = await params.cipher.open(params.row.value);
  params.requireCurrent();
  if (!opened.needsReseal) return { value: opened.value, version: params.row.version };
  const encoded = await params.cipher.seal(opened.value);
  params.requireCurrent();
  const result = await params.compareAndSet(encoded, params.row.version);
  params.requireCurrent();
  if (result.success) return { value: opened.value, version: result.version };
  // Return the winner's matching value/version. Never retry with the old value,
  // including when the winner is another legacy writer or a deletion.
  if (result.value === null) return { value: null, version: result.version, tombstone: true };
  const winner = await params.cipher.open(result.value);
  params.requireCurrent();
  return { value: winner.value, version: result.version };
}
