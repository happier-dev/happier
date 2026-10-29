import axios from '@/api/client/credentialAxios';
import { z } from 'zod/mini';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createAccountKvCipher, openAccountKvJsonRow } from '@happier-dev/protocol/crypto/accountKvCipher';
import type { ScmReviewedMarksJsonTransport } from '@happier-dev/protocol/scm';
import type { AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import type { StoredCredentials } from '@/persistence';
import { decodeBase64, encodeBase64, decryptResult, encrypt } from '@/api/encryption';
import { readRequesterAccountEncryptionCurrentness } from './accountEncryptionCurrentnessObservation';
import { fetchAccountEncryptionCurrentness } from './accountEncryptionCurrentness';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type AccountKvAuthorizationRequest = Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>;
export type CliAccountKvJsonTransportParams = Readonly<{
  credentials: StoredCredentials; key: string; serverBaseUrl?: string; signal?: AbortSignal; shouldContinue?: () => boolean;
  resolveAuthorizationHeaders: (request: AccountKvAuthorizationRequest) => Readonly<Record<string, string>> | null;
}>;
class AccountKvJsonTransportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
/** Identity reads may borrow; sealing and final authority use fresh admission by default. */
export async function resolveCliAccountStorageContext(params: Readonly<{
  credentials: StoredCredentials; serverBaseUrl?: string; signal?: AbortSignal; shouldContinue?: () => boolean;
  authorizationHeaders?: Readonly<Record<string, string>>;
  usage?: 'identity' | 'fresh-authority';
}>) {
  const readCurrentness = params.usage === 'identity' ? readRequesterAccountEncryptionCurrentness : fetchAccountEncryptionCurrentness;
  const currentness = await readCurrentness({ token: params.credentials.token,
    ...(params.serverBaseUrl ? { serverBaseUrl: params.serverBaseUrl } : {}),
    ...(params.authorizationHeaders ? { authorizationHeaders: params.authorizationHeaders } : {}),
    ...(params.signal ? { signal: params.signal } : {}) });
  if (params.signal?.aborted || params.shouldContinue?.() === false) throw new AccountKvJsonTransportError('account_kv_scope_retired', 'The captured Account storage scope retired');
  if (currentness.mode === 'plain') return { mode: 'plain' as const, material: null };
  const encryption = params.credentials.encryption;
  if (!encryption) throw new AccountKvJsonTransportError('account_storage_currentness_unavailable', 'Account encryption material is unavailable');
  const material = encryption.type === 'legacy' ? { type: 'legacy' as const, secret: encryption.secret }
    : { type: 'dataKey' as const, machineKey: encryption.machineKey };
  const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material,
    ...(encryption.type === 'dataKey' ? { dataKeyPublicKey: encryption.publicKey } : {}) });
  if (convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) !== currentness.contentKeyFingerprint) {
    throw new AccountKvJsonTransportError('account_storage_currentness_unavailable', 'Account content-key fingerprint mismatch');
  }
  return { mode: 'e2ee' as const, encryption, material };
}
const storedItem = z.strictObject({ key: z.string(), value: z.string(), version: z.number().check(z.int(), z.nonnegative()) });
const mutationResponse = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), results: z.array(z.strictObject({ key: z.string(), version: z.number().check(z.int(), z.nonnegative()) })) }),
  z.strictObject({ success: z.literal(false), errors: z.array(z.strictObject({ key: z.string(), error: z.literal('version-mismatch'),
    version: z.number().check(z.int(), z.minimum(-1)), value: z.nullable(z.string()) })) }),
]);

/** Account mode/fingerprint admission and opaque JSON/CAS, shared by CLI domain operations. */
export function createCliAccountKvJsonTransport(params: CliAccountKvJsonTransportParams): ScmReviewedMarksJsonTransport {
  const collection = createCliAccountKvJsonCollectionTransport(params);
  return {
    read: () => collection.read(params.key),
    compareAndSet: async (value, version) => {
      const result = await collection.mutate([{ key: params.key, value, version }]);
      if (result.success) {
        const row = result.results.find(row => row.key === params.key);
        if (!row) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation omitted its result');
        return { success: true, version: row.version };
      }
      const row = result.errors.find(row => row.key === params.key);
      if (!row) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation omitted its conflict');
      return { success: false, value: row.value, version: row.version, ...(row.value === null ? { tombstone: true as const } : {}) };
    },
  };
}

/** The same raw Account namespace and mode admission, including atomic multi-key intents. */
export function createCliAccountKvJsonCollectionTransport(params: Omit<CliAccountKvJsonTransportParams, 'key'>): AccountJsonKvCollectionPort {
  const base = (params.serverBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const check = () => {
    if (params.signal?.aborted || params.shouldContinue?.() === false) throw new AccountKvJsonTransportError('account_kv_scope_retired', 'The captured Account KV scope retired');
  };
  const headers = (request: AccountKvAuthorizationRequest) => {
    check(); const value = params.resolveAuthorizationHeaders(request);
    if (!value) throw new AccountKvJsonTransportError('not_authenticated', 'Account authorization is unavailable');
    return value;
  };
  const context = async (usage: 'identity' | 'fresh-authority') => {
    return resolveCliAccountStorageContext({ credentials: params.credentials, serverBaseUrl: base,
      authorizationHeaders: headers({ method: 'GET', path: '/v1/account/encryption/currentness' }),
      signal: params.signal, shouldContinue: params.shouldContinue, usage });
  };
  type Context = Awaited<ReturnType<typeof context>>;
  const cipher = (admitted: Context) => createAccountKvCipher({ mode: admitted.mode, material: admitted.material,
    dataKeyCipher: key => ({
      seal: async value => encodeBase64(encrypt(key, 'dataKey', value)),
      open: async encoded => {
        try { return decryptResult(key, 'dataKey', decodeBase64(encoded)); }
        catch { return { status: 'authentication_failed' }; }
      },
    }),
  });
  const mutateEncoded = async (mutations: readonly { key: string; value: string; version: number }[]) => {
    const body = { mutations };
    const response = await axios.post(`${base}/v1/kv`, body,
      { headers: headers({ method: 'POST', path: '/v1/kv', body }), validateStatus: () => true, ...(params.signal ? { signal: params.signal } : {}) });
    check();
    if (response.status !== 200 && response.status !== 409) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation failed');
    return mutationResponse.parse(response.data);
  };
  const openRow = (row: { key: string; value: string | null; version: number }, admitted: Context) => openAccountKvJsonRow({
    row, cipher: {
      open: cipher(admitted).open,
      seal: async value => {
        // Legacy reads become writes here. A socket identity cannot authorize a
        // re-seal after a committed change whose publication is still pending.
        const current = await context('fresh-authority');
        if (current.mode !== admitted.mode) {
          throw new AccountKvJsonTransportError('account_storage_currentness_unavailable', 'Account encryption mode changed before re-sealing');
        }
        return await cipher(current).seal(value);
      },
    }, requireCurrent: check,
    compareAndSet: async (value, version) => {
      const result = await mutateEncoded([{ key: row.key, value, version }]);
      if (result.success) {
        const stored = result.results.find(item => item.key === row.key);
        if (!stored) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV re-seal omitted its result');
        return { success: true, version: stored.version };
      }
      const conflict = result.errors.find(item => item.key === row.key);
      if (!conflict) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV re-seal omitted its conflict');
      return { success: false, value: conflict.value, version: conflict.version };
    },
  });
  return {
    read: async key => {
      check(); const admitted = await context('identity'); const path = `/v1/kv/${encodeURIComponent(key)}`;
      const response = await axios.get(`${base}${path}`, { headers: headers({ method: 'GET', path }), validateStatus: () => true,
        ...(params.signal ? { signal: params.signal } : {}) });
      check(); if (response.status === 404) return { value: null, version: -1 };
      if (response.status !== 200) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV read failed');
      const item = storedItem.parse(response.data);
      if (item.key !== key) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV read returned another key');
      return await openRow(item, admitted);
    },
    list: async prefix => {
      check(); const admitted = await context('identity');
      const rows: { key: string; value: unknown; version: number }[] = [];
      const seen = new Set<string>();
      let afterKey: string | undefined;
      for (;;) {
        // The HTTP KV owner admits at most 1,000 records per page, not per Account.
        const query = new URLSearchParams({ prefix, limit: '1000', ...(afterKey ? { afterKey } : {}) });
        const path = `/v1/kv?${query}`;
        const response = await axios.get(`${base}${path}`, { headers: headers({ method: 'GET', path }), validateStatus: () => true,
          ...(params.signal ? { signal: params.signal } : {}) });
        check();
        if (response.status !== 200) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV list failed');
        const page = z.strictObject({ items: z.array(storedItem) }).parse(response.data).items;
        for (const row of page) {
          if (!row.key.startsWith(prefix) || seen.has(row.key)) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV list returned invalid membership');
          seen.add(row.key);
          const opened = await openRow(row, admitted);
          if (!opened.tombstone) rows.push({ key: row.key, ...opened });
        }
        if (page.length < 1000) return rows;
        afterKey = page[page.length - 1]!.key;
      }
    },
    mutate: async mutations => {
      check(); const admitted = await context('fresh-authority');
      const codec = cipher(admitted);
      const result = await mutateEncoded(await Promise.all(mutations.map(async row => ({ key: row.key, value: await codec.seal(row.value), version: row.version }))));
      if (result.success) {
        return result;
      }
      if (result.errors.length === 0) throw new AccountKvJsonTransportError('account_kv_unavailable', 'Account KV mutation omitted its conflict');
      return { success: false, errors: await Promise.all(result.errors.map(async row => ({ key: row.key, ...await openRow(row, admitted) }))) };
    },
  };
}
