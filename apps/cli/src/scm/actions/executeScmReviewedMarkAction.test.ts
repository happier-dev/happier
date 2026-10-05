import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmComparison } from '@happier-dev/protocol/scm';
import { createAccountScopedCryptoMaterialSnapshotV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol';
import { encrypt, encodeBase64, decodeBase64, decryptResult } from '@/api/encryption';
import tweetnacl from 'tweetnacl';
import { createCliScmReviewedMarkAction } from './executeScmReviewedMarkAction';

const network = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
// Only the HTTP boundary is replaced; currentness, encryption and intent reconciliation are real.
vi.mock('axios', () => ({ default: network }));
const comparison: ScmComparison = { id: 'basis', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
  endpoints: { before: 'old', after: 'new' }, inventory: { state: 'complete', reasons: [], files: [{
    path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
    evidence: { state: 'available', unifiedDiff: 'patch' }, occurrences: [{ id: 'exact', alias: 'c1', path: 'a.ts', position: 0,
      before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
  }] } };
const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
const resolveAuthorizationHeaders = () => ({ Authorization: 'Bearer token' });

describe('explicit CLI personal reviewed Action', () => {
  beforeEach(() => { network.get.mockReset(); network.post.mockReset(); });
  it('writes marks in keyless plain Account context and never uses machine result storage', async () => {
    network.get.mockImplementation(async (url: string) => url.endsWith('/currentness') ? { status: 200, data: currentness }
      : { status: 404 });
    network.post.mockImplementation(async (_url: string, body: { mutations: { key: string }[] }) => ({ status: 200,
      data: { success: true, results: [{ key: body.mutations[0].key, version: 0 }] } }));
    await expect(createCliScmReviewedMarkAction({ credentials: { token: 'token', encryption: null }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders, comparison, changeRefs: ['exact'], reviewed: true })).resolves.toMatchObject({ success: true,
      record: { comparisonId: 'basis', reviewedChangeRefs: ['exact'] } });
    const value = network.post.mock.calls[0][1].mutations[0].value;
    expect(JSON.parse(Buffer.from(value, 'base64').toString())).toEqual({ t: 'plain', v: { v: 1, comparisonId: 'basis', reviewedChangeRefs: ['exact'] } });
  });
  it('fails before KV mutation on unsupported Account material and unreadable ciphertext', async () => {
    const secret = new Uint8Array(32).fill(7);
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    const encryptedCurrentness = { ...currentness, mode: 'e2ee', signingKeyFingerprint: 'signing',
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) };
    network.get.mockImplementation(async (url: string) => url.endsWith('/currentness') ? { status: 200, data: encryptedCurrentness }
      : { status: 200, data: { key: decodeURIComponent(url.slice(url.indexOf('/v1/kv/') + '/v1/kv/'.length)),
        value: encodeBase64(encrypt(new Uint8Array(32).fill(9), 'legacy', {})), version: 1 } });
    await expect(createCliScmReviewedMarkAction({ credentials: { token: 'token', encryption: null }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders, comparison, changeRefs: ['exact'], reviewed: true })).resolves.toMatchObject({ success: false,
      errorCode: 'account_storage_currentness_unavailable' });
    await expect(createCliScmReviewedMarkAction({ credentials: { token: 'token', encryption: { type: 'legacy', secret } }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders, comparison, changeRefs: ['exact'], reviewed: true })).resolves.toMatchObject({ success: false,
      errorCode: 'account_kv_content_unreadable' });
    expect(network.post).not.toHaveBeenCalled();
  });
  it('does not mutate a retired or unauthorized Account scope', async () => {
    network.get.mockResolvedValue({ status: 200, data: currentness });
    const retired = new AbortController(); retired.abort();
    await expect(createCliScmReviewedMarkAction({ credentials: { token: 'token', encryption: null }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders, comparison, changeRefs: ['exact'], reviewed: true, signal: retired.signal })).resolves.toMatchObject({ success: false });
    await expect(createCliScmReviewedMarkAction({ credentials: { token: 'token', encryption: null }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders: () => null, comparison, changeRefs: ['exact'], reviewed: true })).resolves.toMatchObject({ success: false, errorCode: 'not_authenticated' });
    expect(network.post).not.toHaveBeenCalled();
  });
  it.each(['legacy', 'dataKey'] as const)('writes and opens marks with the actual %s Account codec', async type => {
    const key = new Uint8Array(32).fill(7);
    const encryption = type === 'legacy' ? { type, secret: key } : { type, machineKey: key, publicKey: tweetnacl.box.keyPair.fromSecretKey(key).publicKey };
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: encryption.type === 'legacy' ? { type: 'legacy', secret: key } : { type: 'dataKey', machineKey: key },
      ...(encryption.type === 'dataKey' ? { dataKeyPublicKey: encryption.publicKey } : {}) });
    const admitted = { ...currentness, mode: 'e2ee', signingKeyFingerprint: 'signing',
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) };
    network.get.mockImplementation(async (url: string) => url.endsWith('/currentness') ? { status: 200, data: admitted } : { status: 404 });
    network.post.mockImplementation(async (_url: string, body: { mutations: { key: string }[] }) => ({ status: 200,
      data: { success: true, results: [{ key: body.mutations[0].key, version: 0 }] } }));
    await expect(createCliScmReviewedMarkAction({ credentials: { token: 'token', encryption }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders, comparison, changeRefs: ['exact'], reviewed: true })).resolves.toMatchObject({ success: true });
    const encoded = network.post.mock.calls[0][1].mutations[0].value;
    expect(decryptResult(key, type, decodeBase64(encoded))).toEqual({ status: 'authenticated',
      value: { v: 1, comparisonId: 'basis', reviewedChangeRefs: ['exact'] } });
  });
});
