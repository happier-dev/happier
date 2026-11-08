import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, createRenderCommitCounter, renderHook, useRenderCommitCounter } from '@/dev/testkit';
import { applyScmReviewedMarkIntent, buildScmChangeKeys, ScmReviewedMarkResponseSchema, type ScmComparison } from '@happier-dev/protocol/scm';
import type { ServerFetch } from '@/sync/http/client';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { dispatchKvBatchUpdate } from '@/sync/engine/socket/kvUpdateDispatcher';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { type ActionExecutorDeps} from '@happier-dev/protocol/actions/executor/types';
import { createAccountScopedCryptoMaterialSnapshotV1} from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createScmReviewedMarksOperationsWithTransport as createScmReviewedMarksOperations } from '@/dev/testkit/harness/scmActionTransport';
import { useWalkthroughReading } from '@/components/sessions/files/walkthrough/useWalkthroughReading';
import { useWalkthroughReviewedStop } from '@/components/sessions/files/walkthrough/useWalkthroughReviewed';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';

const comparison: ScmComparison = { id: 'a'.repeat(64), source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
  endpoints: { before: 'a', after: 'b' }, inventory: { state: 'complete', reasons: [], files: [{ path: 'a.ts',
    changeKind: 'modified', binary: false, generated: false, lockfile: false, evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n@@ -5 +5 @@\n-before\n+after\n' },
    occurrences: [0, 1].map(position => ({ id: `exact:${position}`, alias: `c${position}`, path: 'a.ts', position,
      before: { startLine: position, lineCount: 1 }, after: { startLine: position, lineCount: 1 } })),
  }] } };
const record = (...refs: string[]) => applyScmReviewedMarkIntent(comparison, null, refs, true);
const plain = (value: unknown) => encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: value });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const currentness = { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };

function fixture() {
  let value = record();
  let version = 1;
  const request = vi.fn<ServerFetch>().mockImplementation(async (path, init) => {
    if (path.endsWith('/currentness')) return json(currentness);
    if (path === '/v1/kv/bulk') return json({ values: JSON.parse(String(init?.body)).keys.map((key: string) => ({ key, value: plain(value), version })) });
    if (init?.method === 'POST') {
      const mutation = JSON.parse(String(init.body)).mutations[0];
      if (mutation.version !== version) return json({ success: false, errors: [{ key: mutation.key, value: plain(value), version, error: 'version-mismatch' }] }, 409);
      value = JSON.parse(new TextDecoder().decode(Buffer.from(mutation.value, 'base64'))).v;
      return json({ success: true, results: [{ key: mutation.key, version: ++version }] });
    }
    throw new Error(`Unexpected reviewed-marks fixture path: ${path}`);
  });
  return { request, remote: (refs: string[]) => { value = record(...refs); version++; }, version: () => version };
}

describe('personal marks Account adapter and live prefix projection', () => {
  it('settles a first Review without HTTP errors for absent marks and still reads saved marks', async () => {
    const kv = createAccountKvHttpFixture();
    const statuses: number[] = [];
    const request: ServerFetch = async (path, init) => {
      if (path.endsWith('/currentness')) return json(currentness);
      const response = await kv.handleFetch(new URL(path, 'https://captured.example.test'), init);
      if (!response) throw new Error(`Unexpected Account fixture path: ${path}`);
      statuses.push(response.status);
      return response;
    };
    const ops = createScmReviewedMarksOperations({ comparison, credentials: { token: 'Account-A' }, request,
      encryption: null, shouldContinue: () => true });
    try {
      await expect(ops.read()).resolves.toEqual({ record: record(), version: -1 });
      expect(ops.getSnapshot()).toMatchObject({ status: 'ready', record: record() });
      expect(statuses).toEqual([200]);
      expect(kv.readRequests()).toHaveLength(1);

      const saved = record('exact:0');
      await kv.handleFetch('https://captured.example.test/v1/kv', { method: 'POST', body: JSON.stringify({
        mutations: [{ key: ops.key, value: plain(saved), version: -1 }],
      }) });
      await expect(ops.read()).resolves.toEqual({ record: saved, version: 0 });
      expect(statuses).toEqual([200, 200]);
    } finally { ops.retire(); }
  });
  it('does no read or second render for an acknowledged mark echo while another observer receives genuine mark and unmark changes', async () => {
    const home = fixture();
    const args = { comparison, credentials: { token: 'Account-A' }, request: home.request, encryption: null, shouldContinue: () => true };
    const author = createScmReviewedMarksOperations(args);
    const other = createScmReviewedMarksOperations(args);
    await Promise.all([author.read(), other.read()]);
    let statusPublications = 0;
    const stopStatus = author.subscribeStatus(() => { statusPublications++; });
    const authorCounter = createRenderCommitCounter();
    const otherCounter = createRenderCommitCounter();
    const mount = (ops: typeof author, counter: typeof authorCounter) => renderHook(() => {
      useRenderCommitCounter(counter);
      return React.useSyncExternalStore(ops.subscribe, ops.getSnapshot, ops.getSnapshot);
    });
    const authorView = await mount(author, authorCounter);
    const otherView = await mount(other, otherCounter);
    const screenCounter = createRenderCommitCounter();
    const readingView = await renderHook(() => {
      useRenderCommitCounter(screenCounter);
      return useWalkthroughReading({ comparison, analysis: null, reviewed: null, reviewedRecordSource: author.recordSource,
        walkthrough: { state: 'complete', value: { title: 'Reading', intro: '', otherChangeRefs: [],
          stops: [0, 1].map(index => ({ id: `stop-${index}`, title: `Change ${index}`, explanationMarkdown: 'Captured change.', changeRefs: [`exact:${index}`] })) } } }, 'keyed');
    });
    const reading = readingView.getCurrent();
    const changedCounter = createRenderCommitCounter();
    const unchangedCounter = createRenderCommitCounter();
    const mountRow = (index: number, counter: typeof changedCounter) => renderHook(() => {
      useRenderCommitCounter(counter);
      return useWalkthroughReviewedStop(reading.reviewedSource, reading.stops[index]!);
    });
    const changedRow = await mountRow(0, changedCounter);
    const unchangedRow = await mountRow(1, unchangedCounter);
    const push = () => dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: author.key, value: 'opaque-hint', version: home.version() }] },
      credentials: args.credentials, shouldContinue: () => true, applyTodoSocketUpdates: async () => {},
      invalidateTodosSync: () => {}, log: { log: () => {} } });
    try {
      for (const reviewed of [true, false]) {
        authorCounter.reset(); otherCounter.reset();
        screenCounter.reset(); changedCounter.reset(); unchangedCounter.reset();
        await act(async () => { await author.setReviewed(['exact:0'], reviewed); });
        expect(authorView.getCurrent().record).toEqual(reviewed ? record('exact:0') : record());
        expect(authorCounter.read()).toEqual({ renders: 1, commits: 1 });
        expect(changedRow.getCurrent().reviewed).toBe(reviewed);
        expect(unchangedRow.getCurrent().reviewed).toBe(false);
        expect(changedCounter.read()).toEqual({ renders: 1, commits: 1 });
        expect(unchangedCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(screenCounter.read()).toEqual({ renders: 0, commits: 0 });
        authorCounter.reset(); home.request.mockClear();
        await act(async () => { await push(); });
        await vi.waitFor(() => expect(otherView.getCurrent().record).toEqual(authorView.getCurrent().record));
        // Only the observer behind this authoritative KV version needs a read.
        expect(home.request.mock.calls.filter(([path]) => path === '/v1/kv/bulk')).toHaveLength(1);
        expect(authorCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(otherCounter.read()).toEqual({ renders: 1, commits: 1 });
        home.request.mockClear(); otherCounter.reset();
        await act(async () => { await push(); });
        expect(home.request).not.toHaveBeenCalled();
        expect(authorCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(otherCounter.read()).toEqual({ renders: 0, commits: 0 });
        expect(statusPublications).toBe(0);
      }
    } finally {
      stopStatus(); await changedRow.unmount(); await unchangedRow.unmount(); await readingView.unmount();
      await authorView.unmount(); await otherView.unmount(); author.retire(); other.retire();
    }
  });
  it('keeps the Account observer mounted while displayed content membership changes', async () => {
    const home = fixture();
    let displayed = { repositoryRootPath: '/repo', source: comparison.source,
      changeKeys: [...buildScmChangeKeys(comparison).values()].flat() };
    const ops = createScmReviewedMarksOperations({ source: displayed, getSelection: () => ({ source: displayed }),
      credentials: { token: 'Account-A' }, request: home.request, encryption: null, shouldContinue: () => true });
    try {
      await ops.read(); const key = ops.key;
      const first = displayed.changeKeys[0]!;
      await ops.setReviewedKeys([first], true);
      displayed = { ...displayed, changeKeys: ['changed-content-key'] };
      expect(await ops.setReviewedKeys(displayed.changeKeys, true)).toMatchObject({ success: true, record: {
        reviewedChangeKeys: [first, 'changed-content-key'],
      } });
      expect(ops.key).toBe(key);
      expect(await ops.setReviewedKeys([first], false)).toMatchObject({ success: false, errorCode: 'reviewed_marks_invalid_selection' });
    } finally { ops.retire(); }
  });
  it.each(['refs', 'keys', 'reset'] as const)('honors normalized %s refusal without writing directly to the Account record', async intent => {
    const home = fixture();
    const executor = createActionExecutor({ isActionEnabled: () => false,
      scmActionExecute: async () => { throw new Error('Disabled mark reached Machine transport'); },
    // The fixture retains real Action admission above the Machine boundary.
    } as unknown as ActionExecutorDeps);
    const params = { comparison, credentials: { token: 'Account-A' }, request: home.request,
      shouldContinue: () => true,
      setReviewedAction: async (input: import('@happier-dev/protocol/scm').ScmReviewedUnmarkInput, reviewed: boolean) => {
        const action = await executor.execute(reviewed ? 'scm.diffSummary.reviewed.mark' : 'scm.diffSummary.reviewed.unmark', {
          ...input,
        }, { surface: 'ui', externalActionTarget: { kind: 'machine', machineId: 'machine' } });
        return action.ok ? ScmReviewedMarkResponseSchema.parse(action.result)
          : { success: false as const, errorCode: action.errorCode ?? 'reviewed_marks_unavailable', error: action.error };
      },
    };
    const ops = createScmReviewedMarksOperations(params);
    try {
      const result = intent === 'refs' ? await ops.setReviewed(['exact:0'], true)
        : intent === 'keys' ? await ops.setReviewedKeys(buildScmChangeKeys(comparison).get('exact:0')!, true)
        : await ops.clear();
      expect(result).toMatchObject({ success: false, errorCode: 'action_disabled' });
      expect(ops.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'action_disabled', record: null });
      expect(home.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    } finally { ops.retire(); }
  });
  it('resets review explicitly through real keyless Account transport', async () => {
    const home = fixture();
    home.remote(['exact:0', 'exact:1']);
    const params = { comparison, credentials: { token: 'Account-A' }, request: home.request,
      encryption: null, shouldContinue: () => true };
    const mounted = createScmReviewedMarksOperations(params);
    expect(await mounted.clear()).toMatchObject({ success: true, record: record() });
    expect((await mounted.read()).record).toEqual(record());
    mounted.retire();
    home.request.mockClear();
    const retired = createScmReviewedMarksOperations({ ...params, shouldContinue: () => false });
    expect(await retired.clear())
      .toMatchObject({ success: false, errorCode: 'account_kv_scope_retired' });
    expect(home.request).not.toHaveBeenCalled();
    home.request.mockImplementation(async path => path.endsWith('/currentness') ? json(currentness)
      : json({ values: [{ key: mounted.key, value: plain({ ...record('exact:0'), scopeId: 'other' }), version: 3 }] }));
    const malformed = createScmReviewedMarksOperations(params);
    expect(await malformed.clear()).toMatchObject({ success: false, errorCode: 'reviewed_marks_invalid_record' });
    retired.retire(); malformed.retire();
    expect(home.request.mock.calls.some(([path, init]) => path === '/v1/kv' && init?.method === 'POST')).toBe(false);
  });
  it('opens and writes real encrypted marks, then hides prior marks when ciphertext becomes unreadable', async () => {
    const secret = new Uint8Array(32).fill(7); const encryption = await Encryption.create(secret);
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    const admitted = { ...currentness, mode: 'e2ee', signingKeyFingerprint: 'signing',
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint) };
    let stored = await encryption.encryptRaw(record()); let version = 1;
    const request = vi.fn<ServerFetch>().mockImplementation(async (path, init) => {
      if (path.endsWith('/currentness')) return json(admitted);
      if (path === '/v1/kv/bulk') return json({ values: JSON.parse(String(init?.body)).keys.map((key: string) => ({ key, value: stored, version })) });
      if (init?.method === 'POST') {
        const mutation = JSON.parse(String(init.body)).mutations[0]; stored = mutation.value;
        return json({ success: true, results: [{ key: mutation.key, version: ++version }] });
      }
      throw new Error(`Unexpected reviewed-marks fixture path: ${path}`);
    });
    const ops = createScmReviewedMarksOperations({ comparison, credentials: { token: 'Account-A', secret: encodeBase64(secret, 'base64url') },
      request, encryption, shouldContinue: () => true });
    try {
      await ops.setReviewed(['exact:0'], true);
      await expect(encryption.decryptRaw(stored)).resolves.toEqual(record('exact:0'));
      await expect(ops.clear()).resolves.toMatchObject({ success: true, record: record() });
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
      await vi.waitFor(() => expect(b.getSnapshot().record?.reviewedChangeKeys).toEqual(record('exact:0').reviewedChangeKeys));
      home.remote(['exact:0', 'exact:1']);
      await a.setReviewed(['exact:0'], false);
      expect(a.getSnapshot().record?.reviewedChangeKeys).toEqual(record('exact:1').reviewedChangeKeys);
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
  it('fails closed on wrong-mode content and recovers on a same-version push after the failure', async () => {
    const home = fixture();
    const normalRequest = home.request.getMockImplementation()!;
    const ops = createScmReviewedMarksOperations({ comparison, credentials: { token: 'Account-A' }, request: home.request,
      encryption: null, shouldContinue: () => true });
    try {
      await ops.setReviewed(['exact:0'], true);
      home.request.mockImplementation(async path => path.endsWith('/currentness') ? json(currentness)
        : json({ values: [{ key: ops.key, value: 'encrypted-content', version: 3 }] }));
      await expect(ops.read()).rejects.toMatchObject({ code: 'account_stored_json_mode_mismatch' });
      expect(ops.getSnapshot()).toMatchObject({ record: null, status: 'error', errorCode: 'account_stored_json_mode_mismatch' });
      expect(ops.recordSource.getSnapshot()).toBeNull();
      home.request.mockImplementation(normalRequest);
      await dispatchKvBatchUpdate({ kvUpdate: { changes: [{ key: ops.key, value: null, version: home.version() }] },
        credentials: { token: 'Account-A' }, shouldContinue: () => true,
        applyTodoSocketUpdates: async () => {}, invalidateTodosSync: () => {}, log: { log: () => {} } });
      await vi.waitFor(() => expect(ops.getSnapshot()).toMatchObject({ status: 'ready', record: record('exact:0') }));
    } finally { ops.retire(); }
  });
});
