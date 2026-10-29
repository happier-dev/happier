import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyScmReviewedMarkIntent, buildScmChangeKeys, type ScmComparison } from '@happier-dev/protocol/scm';
import { createAccountScopedCryptoMaterialSnapshotV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';
import { encrypt, encodeBase64, decodeBase64, decryptResult } from '@/api/encryption';
import tweetnacl from 'tweetnacl';
import { createCliScmReviewedMarkAction } from './executeScmReviewedMarkAction';

const network = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
// Only the HTTP boundary is replaced; currentness, encryption and intent reconciliation are real.
vi.mock('axios', () => ({ default: network }));
const comparison: ScmComparison = { id: 'basis', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
  endpoints: { before: 'old', after: 'new' }, inventory: { state: 'complete', reasons: [], files: [{
    path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
    evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' }, occurrences: [{ id: 'exact', alias: 'c1', path: 'a.ts', position: 0,
      before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
  }] } };
const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
const resolveAuthorizationHeaders = () => ({ Authorization: 'Bearer token' });
const marked = () => applyScmReviewedMarkIntent(comparison, null, ['exact'], true);

describe('explicit CLI personal reviewed Action', () => {
  beforeEach(() => { network.get.mockReset(); network.post.mockReset(); });
  it('keeps captured keys exact and clears obsolete keys only on an explicit unmark reset', async () => {
    let value = { ...marked(), reviewedChangeKeys: [...marked().reviewedChangeKeys, 'obsolete-key'] };
    let version = 1;
    network.get.mockImplementation(async (url: string) => url.endsWith('/currentness') ? { status: 200, data: currentness }
      : { status: 200, data: { key: decodeURIComponent(url.slice(url.indexOf('/v1/kv/') + '/v1/kv/'.length)),
        value: Buffer.from(JSON.stringify({ t: 'plain', v: value })).toString('base64'), version } });
    network.post.mockImplementation(async (_url: string, body: { mutations: { key: string; value: string }[] }) => {
      value = JSON.parse(Buffer.from(body.mutations[0].value, 'base64').toString()).v;
      return { status: 200, data: { success: true, results: [{ key: body.mutations[0].key, version: ++version }] } };
    });
    const params = { credentials: { token: 'token', encryption: null }, serverBaseUrl: 'https://home', resolveAuthorizationHeaders, comparison };
    const keys = [...buildScmChangeKeys(comparison).values()].flat();
    expect(await createCliScmReviewedMarkAction({ ...params, changeKeys: keys, reviewed: false }))
      .toMatchObject({ success: true, record: { reviewedChangeKeys: ['obsolete-key'] } });
    expect(await createCliScmReviewedMarkAction({ ...params, reset: true, reviewed: true }))
      .toMatchObject({ success: false, errorCode: 'reviewed_marks_invalid_selection' });
    expect(value.reviewedChangeKeys).toEqual(['obsolete-key']);
    expect(await createCliScmReviewedMarkAction({ ...params, reset: true, reviewed: false }))
      .toMatchObject({ success: true, record: { reviewedChangeKeys: [] } });
  });
  it('writes marks in keyless plain Account context and never uses machine result storage', async () => {
    network.get.mockImplementation(async (url: string) => url.endsWith('/currentness') ? { status: 200, data: currentness }
      : { status: 404 });
    network.post.mockImplementation(async (_url: string, body: { mutations: { key: string }[] }) => ({ status: 200,
      data: { success: true, results: [{ key: body.mutations[0].key, version: 0 }] } }));
    await expect(createCliScmReviewedMarkAction({ credentials: { token: 'token', encryption: null }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders, comparison, changeRefs: ['exact'], reviewed: true })).resolves.toMatchObject({ success: true,
      record: marked() });
    const value = network.post.mock.calls[0][1].mutations[0].value;
    expect(JSON.parse(Buffer.from(value, 'base64').toString())).toEqual({ t: 'plain', v: marked() });
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
    // An absent record keeps the KV read valid, so only the retired signal can refuse the mutation.
    network.get.mockImplementation(async (url: string) => url.endsWith('/currentness') ? { status: 200, data: currentness }
      : { status: 404 });
    const retired = new AbortController(); retired.abort();
    await expect(createCliScmReviewedMarkAction({ credentials: { token: 'token', encryption: null }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders, comparison, changeRefs: ['exact'], reviewed: true, signal: retired.signal }))
      .resolves.toMatchObject({ success: false, errorCode: 'account_kv_scope_retired' });
    await expect(createCliScmReviewedMarkAction({ credentials: { token: 'token', encryption: null }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders: () => null, comparison, changeRefs: ['exact'], reviewed: true })).resolves.toMatchObject({ success: false, errorCode: 'not_authenticated' });
    expect(network.post).not.toHaveBeenCalled();
  });
  it('reports a typed mode mismatch without disclosing or overwriting stored marks', async () => {
    network.get.mockImplementation(async (url: string) => url.endsWith('/currentness') ? { status: 200, data: currentness }
      : { status: 200, data: { key: decodeURIComponent(url.slice(url.indexOf('/v1/kv/') + '/v1/kv/'.length)), value: 'encrypted-content', version: 1 } });
    expect(await createCliScmReviewedMarkAction({ credentials: { token: 'token', encryption: null }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders, comparison, changeRefs: ['exact'], reviewed: true }))
      .toMatchObject({ success: false, errorCode: 'account_stored_json_mode_mismatch' });
    expect(network.post).not.toHaveBeenCalled();
  });
  it('never writes the custodian personal record on behalf of another authenticated Machine actor', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
    let retainedRecord: string | undefined;
    network.get.mockImplementation(async (url: string) => url.endsWith('/currentness') ? { status: 200, data: currentness }
      : { status: 404 });
    network.post.mockImplementation(async (_url: string, body: { mutations: { key: string; value: string }[] }) => {
      retainedRecord = body.mutations[0].value;
      return { status: 200, data: { success: true, results: [{ key: body.mutations[0].key, version: 0 }] } };
    });
    const params = { credentials: { token, encryption: null }, serverBaseUrl: 'https://home',
      resolveAuthorizationHeaders: () => ({ Authorization: `Bearer ${token}` }), comparison };
    await expect(createCliScmReviewedMarkAction({ ...params, requesterAccountId: 'collaborator',
      changeRefs: ['exact'], reviewed: true })).resolves.toMatchObject({ success: false, errorCode: 'reviewed_marks_unavailable' });
    expect(retainedRecord).toBeUndefined();
    await expect(createCliScmReviewedMarkAction({ ...params, requesterAccountId: 'custodian',
      changeRefs: ['exact'], reviewed: true })).resolves.toMatchObject({ success: true,
        record: marked() });
    expect(retainedRecord).toBeDefined();
  });
  it.each(['legacy', 'dataKey'] as const)('writes data-key-readable marks from actual %s Account credentials', async type => {
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
    expect(decryptResult(type === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(key) : key, 'dataKey', decodeBase64(encoded))).toEqual({ status: 'authenticated',
      value: marked() });
  });
});
