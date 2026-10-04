import { describe, expect, it, vi } from 'vitest';
import type { ScmComparison } from '@happier-dev/protocol/scm';
import type { ServerFetch } from '@/sync/http/client';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { dispatchKvBatchUpdate } from '@/sync/engine/socket/kvUpdateDispatcher';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { createAccountScopedCryptoMaterialSnapshotV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol';
import { createScmReviewedMarksOperations, clearScmReviewedMarksForComparisonId } from './reviewedMarks';

const comparison: ScmComparison = { id: 'basis', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
  endpoints: { before: 'a', after: 'b' }, inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts',
    changeKind: 'modified', binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: 'patch' },
    occurrences: [0, 1].map(position => ({ id: `exact:${position}`, alias: `c${position}`, path: 'a.ts', position,
      before: { startLine: position, lineCount: 1 }, after: { startLine: position, lineCount: 1 } })),
  }] } };
const record = (...reviewedChangeRefs: string[]) => ({ v: 1 as const, comparisonId: comparison.id, reviewedChangeRefs });
const plain = (value: unknown) => encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: value });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };

function fixture() {
  let value = record();
  let version = 1;
  const request = vi.fn<ServerFetch>().mockImplementation(async (path, init) => {
    if (path.endsWith('/currentness')) return json(currentness);
    if (init?.method === 'POST') {
      const mutation = JSON.parse(String(init.body)).mutations[0];
      if (mutation.version !== version) return json({ success: false, errors: [{ key: mutation.key, value: plain(value), version, error: 'version-mismatch' }] }, 409);
      value = JSON.parse(new TextDecoder().decode(Buffer.from(mutation.value, 'base64'))).v;
      return json({ success: true, results: [{ key: mutation.key, version: ++version }] });
    }
    return json({ key: decodeURIComponent(path.slice('/v1/kv/'.length)), value: plain(value), version });
  });
  return { request, remote: (refs: string[]) => { value = record(...refs); version++; }, version: () => version };
}

describe('personal marks Account adapter and live prefix projection', () => {
  it('clears only the deleted comparison identity through real keyless Account transport', async () => {
    const home = fixture();
    home.remote(['exact:0', 'exact:1']);
    const params = { comparisonId: comparison.id, credentials: { token: 'Account-A' }, request: home.request,
      encryption: null, shouldContinue: () => true };
    expect(await clearScmReviewedMarksForComparisonId(params)).toMatchObject({ success: true, record: record() });
    const mounted = createScmReviewedMarksOperations({ ...params, comparison });
    try { expect((await mounted.read()).record).toEqual(record()); }
    finally { mounted.retire(); }
    home.request.mockClear();
    expect(await clearScmReviewedMarksForComparisonId({ ...params, shouldContinue: () => false }))
      .toMatchObject({ success: false, errorCode: 'account_kv_scope_retired' });
    expect(home.request).not.toHaveBeenCalled();
    home.request.mockImplementation(async path => path.endsWith('/currentness') ? json(currentness)
      : json({ key: 'workspace:scm-reviewed:v1:basis', value: plain({ ...record('exact:0'), comparisonId: 'other' }), version: 3 }));
    expect(await clearScmReviewedMarksForComparisonId(params)).toMatchObject({ success: false, errorCode: 'reviewed_marks_invalid_record' });
    expect(home.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('opens and writes real encrypted marks, then hides prior marks when ciphertext becomes unreadable', async () => {
    const secret = new Uint8Array(32).fill(7); const encryption = await Encryption.create(secret);
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    const admitted = { ...currentness, mode: 'e2ee', signingKeyFingerprint: 'signing',
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) };
    let stored = await encryption.encryptRaw(record()); let version = 1;
    const request = vi.fn<ServerFetch>().mockImplementation(async (path, init) => {
      if (path.endsWith('/currentness')) return json(admitted);
      if (init?.method === 'POST') {
        const mutation = JSON.parse(String(init.body)).mutations[0]; stored = mutation.value;
        return json({ success: true, results: [{ key: mutation.key, version: ++version }] });
      }
      return json({ key: decodeURIComponent(path.slice('/v1/kv/'.length)), value: stored, version });
    });
    const ops = createScmReviewedMarksOperations({ comparison, credentials: { token: 'Account-A', secret: encodeBase64(secret, 'base64url') },
      request, encryption, shouldContinue: () => true });
    try {
      await ops.setReviewed(['exact:0'], true);
      await expect(encryption.decryptRaw(stored)).resolves.toEqual(record('exact:0'));
      await expect(clearScmReviewedMarksForComparisonId({ comparisonId: comparison.id,
        credentials: { token: 'Account-A', secret: encodeBase64(secret, 'base64url') },
        request, encryption, shouldContinue: () => true })).resolves.toMatchObject({ success: true, record: record() });
      await expect(encryption.decryptRaw(stored)).resolves.toEqual(record());
      stored = 'corrupt-ciphertext';
      await expect(ops.read()).rejects.toMatchObject({ code: 'account_kv_content_unreadable' });
      expect(ops.getSnapshot()).toMatchObject({ record: null, status: 'error', errorCode: 'account_kv_content_unreadable' });
    } finally { ops.retire(); }
  });
  it('updates another mounted device through the existing dispatcher and preserves unrelated marks', async () => {
    const home = fixture();
    const args = { comparison, credentials: { token: 'Account-A' }, request: home.request, encryption: null, shouldContinue: () => true };
    const a = createScmReviewedMarksOperations(args); const b = createScmReviewedMarksOperations(args);
    try {
      await Promise.all([a.read(), b.read()]);
      await a.setReviewed(['exact:0'], true);
      await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: a.key, value: 'opaque-hint', version: home.version() }] },
        credentials: args.credentials, shouldContinue: () => true, applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } });
      await vi.waitFor(() => expect(b.getSnapshot().record?.reviewedChangeRefs).toEqual(['exact:0']));
      home.remote(['exact:0', 'exact:1']);
      await a.setReviewed(['exact:0'], false);
      expect(a.getSnapshot().record?.reviewedChangeRefs).toEqual(['exact:1']);
    } finally { a.retire(); b.retire(); }
  });
  it('suppresses old Account pushes and clears the visible projection when retired', async () => {
    const home = fixture(); let current = true;
    const ops = createScmReviewedMarksOperations({ comparison, credentials: { token: 'Account-A' }, request: home.request,
      encryption: null, shouldContinue: () => current });
    await ops.setReviewed(['exact:0'], true);
    current = false;
    expect(ops.getSnapshot().record).toBeNull();
    await expect(ops.setReviewed(['exact:1'], true)).resolves.toMatchObject({ success: false, errorCode: 'account_kv_scope_retired' });
    ops.retire();
    home.request.mockClear();
    await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: ops.key, value: null, version: 9 }] }, credentials: { token: 'Account-A' },
      shouldContinue: () => true, applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } });
    expect(home.request).not.toHaveBeenCalled();
  });
  it('retains reference identity and subscriber locality on equal remote echoes', async () => {
    const home = fixture();
    const ops = createScmReviewedMarksOperations({ comparison, credentials: { token: 'Account-A' }, request: home.request,
      encryption: null, shouldContinue: () => true });
    try {
      await ops.read(); const first = ops.getSnapshot(); const listener = vi.fn(); const unsubscribe = ops.subscribe(listener);
      await ops.read();
      expect(ops.getSnapshot()).toBe(first); expect(listener).not.toHaveBeenCalled(); unsubscribe();
    } finally { ops.retire(); }
  });
  it('fails closed on a wrong-mode push instead of displaying cached reviewed content', async () => {
    const home = fixture();
    const ops = createScmReviewedMarksOperations({ comparison, credentials: { token: 'Account-A' }, request: home.request,
      encryption: null, shouldContinue: () => true });
    try {
      await ops.setReviewed(['exact:0'], true);
      home.request.mockImplementation(async path => path.endsWith('/currentness') ? json(currentness)
        : json({ key: ops.key, value: 'encrypted-content', version: 3 }));
      await expect(ops.read()).rejects.toMatchObject({ code: 'account_stored_json_mode_mismatch' });
      expect(ops.getSnapshot()).toMatchObject({ record: null, status: 'error', errorCode: 'account_stored_json_mode_mismatch' });
    } finally { ops.retire(); }
  });
});
