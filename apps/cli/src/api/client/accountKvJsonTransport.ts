import axios from 'axios';
import { z } from 'zod';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import type { ScmReviewedMarksJsonTransport } from '@happier-dev/protocol/scm';
import type { StoredCredentials } from '@/persistence';
import { decodeBase64, encodeBase64, decryptResult, encrypt } from '@/api/encryption';
import { fetchAccountEncryptionCurrentness } from './connectedServiceCredentialApi';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type AccountKvAuthorizationRequest = Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>;
export type CliAccountKvJsonTransportParams = Readonly<{
  credentials: StoredCredentials; key: string; serverBaseUrl?: string; signal?: AbortSignal; shouldContinue?: () => boolean;
  resolveAuthorizationHeaders: (request: AccountKvAuthorizationRequest) => Readonly<Record<string, string>> | null;
}>;
class AccountKvJsonTransportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const storedItem = z.object({ key: z.string(), value: z.string(), version: z.number().int().nonnegative() }).strict();
const mutationResponse = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), results: z.array(z.object({ key: z.string(), version: z.number().int().nonnegative() }).strict()) }).strict(),
  z.object({ success: z.literal(false), errors: z.array(z.object({ key: z.string(), error: z.literal('version-mismatch'),
    version: z.number().int().min(-1), value: z.string().nullable() }).strict()) }).strict(),
]);

/** Account mode/fingerprint admission and opaque JSON/CAS, shared by CLI domain operations. */
export function createCliAccountKvJsonTransport(params: CliAccountKvJsonTransportParams): ScmReviewedMarksJsonTransport {
  const base = (params.serverBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const check = () => {
    if (params.signal?.aborted || params.shouldContinue?.() === false) throw new AccountKvJsonTransportError('account_kv_scope_retired', 'The captured Account KV scope retired');
  };
  const headers = (request: AccountKvAuthorizationRequest) => {
    check(); const value = params.resolveAuthorizationHeaders(request);
    if (!value) throw new AccountKvJsonTransportError('not_authenticated', 'Account authorization is unavailable');
    return value;
  };
  const context = async () => {
    const currentness = await fetchAccountEncryptionCurrentness({ token: params.credentials.token, serverBaseUrl: base,
      authorizationHeaders: headers({ method: 'GET', path: '/v1/account/encryption/currentness' }), ...(params.signal ? { signal: params.signal } : {}) });
    check();
    if (currentness.mode === 'plain') return { mode: 'plain' as const };
    const encryption = params.credentials.encryption;
    if (!encryption) throw new AccountKvJsonTransportError('account_storage_currentness_unavailable', 'Account encryption material is unavailable');
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: encryption.type === 'legacy' ? { type: 'legacy', secret: encryption.secret } : { type: 'dataKey', machineKey: encryption.machineKey },
      ...(encryption.type === 'dataKey' ? { dataKeyPublicKey: encryption.publicKey } : {}) });
    if (convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) !== currentness.contentKeyFingerprint) {
      throw new AccountKvJsonTransportError('account_storage_currentness_unavailable', 'Account content-key fingerprint mismatch');
    }
    return { mode: 'e2ee' as const, encryption };
  };
  type Context = Awaited<ReturnType<typeof context>>;
  const encode = (value: unknown, admitted: Context): string => {
    if (admitted.mode === 'plain') return encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: value })));
    const material = admitted.encryption;
    return encodeBase64(encrypt(material.type === 'legacy' ? material.secret : material.machineKey, material.type, value));
  };
  const decode = (encoded: string, admitted: Context): unknown => {
    let envelope: z.infer<typeof StoredJsonContentEnvelopeSchema> | null = null;
    try { const parsed = StoredJsonContentEnvelopeSchema.safeParse(JSON.parse(new TextDecoder().decode(decodeBase64(encoded))));
      if (parsed.success) envelope = parsed.data; } catch { /* Released ciphertext-only E2EE is not JSON. */ }
    if ((envelope?.t === 'plain' ? 'plain' : 'e2ee') !== admitted.mode) {
      throw new AccountKvJsonTransportError('account_stored_json_mode_mismatch', 'Stored Account content does not match its authoritative mode');
    }
    if (envelope?.t === 'plain') return envelope.v;
    if (admitted.mode !== 'e2ee') throw new AccountKvJsonTransportError('account_stored_json_mode_mismatch', 'Encrypted Account content requires E2EE mode');
    const material = admitted.encryption;
    let ciphertext: Uint8Array;
    try { ciphertext = decodeBase64(envelope?.t === 'encrypted' ? envelope.c : encoded); }
    catch { throw new AccountKvJsonTransportError('account_kv_content_unreadable', 'The encrypted Account KV record could not be opened'); }
    const result = decryptResult(material.type === 'legacy' ? material.secret : material.machineKey, material.type, ciphertext);
    if (result.status !== 'authenticated') throw new AccountKvJsonTransportError('account_kv_content_unreadable', 'The encrypted Account KV record could not be opened');
    return result.value;
  };
  return {
    read: async () => {
      check(); const admitted = await context(); const path = `/v1/kv/${encodeURIComponent(params.key)}`;
      const response = await axios.get(`${base}${path}`, { headers: headers({ method: 'GET', path }), validateStatus: () => true,
        ...(params.signal ? { signal: params.signal } : {}) });
      check(); if (response.status === 404) return { value: null, version: -1 };
      if (response.status !== 200) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV read failed');
      const item = storedItem.parse(response.data);
      if (item.key !== params.key) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV read returned another key');
      return { value: decode(item.value, admitted), version: item.version };
    },
    compareAndSet: async (value, version) => {
      check(); const admitted = await context();
      const body = { mutations: [{ key: params.key, value: encode(value, admitted), version }] };
      const response = await axios.post(`${base}/v1/kv`, body,
        { headers: headers({ method: 'POST', path: '/v1/kv', body }), validateStatus: () => true, ...(params.signal ? { signal: params.signal } : {}) });
      check();
      if (response.status !== 200 && response.status !== 409) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation failed');
      const result = mutationResponse.parse(response.data);
      if (result.success) {
        const stored = result.results.find(item => item.key === params.key);
        if (!stored) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation omitted its result');
        return { success: true, version: stored.version };
      }
      const conflict = result.errors.find(item => item.key === params.key);
      if (!conflict) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation omitted its conflict');
      return { success: false, value: conflict.value === null ? null : decode(conflict.value, admitted), version: conflict.version,
        ...(conflict.value === null ? { tombstone: true as const } : {}) };
    },
  };
}
