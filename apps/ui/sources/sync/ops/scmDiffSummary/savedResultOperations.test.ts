import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScmDiffSummaryResultSchema} from '@happier-dev/protocol/scm/diffSummaryResult';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { createAccountScopedCryptoMaterialSnapshotV1} from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { applyScmReviewedKeysIntent, buildScmReviewedMarksKey, buildScmReviewScopeId, type ScmDiffSummaryResultFailure } from '@happier-dev/protocol/scm';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { AuthContextType } from '@/auth/context/AuthContext';
import type { ServerFetch } from '@/sync/http/client';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await import('@/sync/ops/actions/defaultActionExecutor');
const { createScmDiffSummarySavedResultOperations } = await import('./savedResultOperations');
const comparisonId = 'a'.repeat(64);
const listed = { success: true as const, results: [{ cwd: '/repo', sessionId: 'session', resultId: 'saved', revision: 1,
  comparisonId, source: { kind: 'workingTree' as const }, bytes: 12, updatedAtMs: 1 }], count: 1, bytes: 12,
  sevenDayCost: { status: 'unavailable' as const, pricedRunCount: 0, unpricedRunCount: 1, sinceMs: 0, untilMs: 1 } };
const input = { results: [{ cwd: '/repo', sessionId: 'session', resultId: 'saved', expectedRevision: 1, comparisonId }] };
const savedResult = ScmDiffSummaryResultSchema.parse({ resultId: 'saved', revision: 1, canUndo: false,
  output: { success: true, resultId: 'saved', revision: 1, sourceKey: comparisonId, metadata: { source: { kind: 'workingTree' }, sourceKey: comparisonId },
    requestedOutputs: ['summary'], outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Saved explanation' } } },
    analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
    comparison: { id: comparisonId, source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } } } });
async function addHome() {
  return harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account', serverIdentityId: 'srv_stable-home-a' });
}
beforeEach(async () => { rpc.mockReset(); await harness.reset(); });
afterEach(() => standardCleanup());

describe('machine saved result operations', () => {
  it('restores a Session reading through the public Action and Session-scoped Machine transport', async () => {
    const serverId = await addHome();
    rpc.mockResolvedValue(listed);
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', sessionId: 'session',
      serverId, accountId: 'account', shouldContinue: () => true });
    const query = { cwd: '/repo', sessionId: 'session', comparisons: [
      { comparisonId: 'comparison', source: { kind: 'workingTree' as const }, outputs: ['walkthrough' as const] },
    ] };
    expect(await ops.list({ query })).toMatchObject({ success: true, results: [{ resultId: 'saved' }] });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'scm.diffSummary.result.list',
      payload: { query }, authorization: { kind: 'session.write', sessionId: 'session' } }));
  });
  it('requests narrow restoration separately from settings usage through the real Action schema', async () => {
    const requests: unknown[] = [];
    const actionExecutor = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ scmActionExecute: async ({ input }) => {
      requests.push(input);
      return listed;
    } })));
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', shouldContinue: () => true, actionExecutor });
    const query = { cwd: '/repo', sessionId: 'session', comparisons: [
      { comparisonId: 'comparison', source: { kind: 'workingTree' as const }, outputs: ['walkthrough' as const] },
    ] };
    expect(await ops.list({ query })).toMatchObject({ success: true });
    expect(await ops.list({ includeUsage: true })).toMatchObject({ success: true });
    expect(requests).toEqual([{ query }, { includeUsage: true }]);
  });
  it('preserves a disabled Clear outcome before machine deletion', async () => {
    const actionExecutor = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ isActionEnabled: () => false,
      scmActionExecute: async () => { throw new Error('Disabled Clear reached Machine transport'); } })));
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', shouldContinue: () => true, actionExecutor });
    expect(await ops.clear(input)).toMatchObject({ success: false, errorCode: 'action_disabled' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('delegates API-token Clear and its marks cleanup to the canonical remote Action authority', async () => {
    const { getCurrentAuth, setCurrentAuth } = await import('@/auth/context/currentAuth');
    const previous = getCurrentAuth();
    setCurrentAuth({ isAuthenticated: true, credentials: { token: 'api-token' }, credentialAuthorityKind: 'api_token',
      login: async () => ({ kind: 'completed' }), loginWithCredentials: async () => ({ kind: 'completed' }), logout: async () => ({ kind: 'completed' }),
      refreshFromActiveServer: async () => {} } satisfies AuthContextType);
    try {
      const serverId = await addHome();
      const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
      // An API token enters the signed Home Action API, not the native Account/Machine adapter.
      const request: ServerFetch = async (path, init) => {
        expect(path).toBe('/v1/actions/scm.diffSummary.result.clear');
        expect(JSON.parse(String(init?.body))).toMatchObject({ v: 1, target: { kind: 'machine', machineId: 'machine' }, input });
        return new Response(JSON.stringify({ v: 1, actionId: 'scm.diffSummary.result.clear', execution: { ok: true,
          result: { success: true, deleted: [{ success: true, resultId: 'saved', comparisonId }], failures: [] } } }));
      };
      const actionExecutor = createFrontDoorActionExecute(createDefaultActionExecutor({ apiTokenAction: { request, target: { kind: 'machine', machineId: 'machine' } } }));
      const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => true, actionExecutor });
      const cleared = await ops.clear(input);
      expect(cleared, JSON.stringify(cleared)).toMatchObject({ success: true, deleted: [{ resultId: 'saved' }] });
      expect(harness.requestsFor('/v1/kv')).toEqual([]);
      expect(rpc).not.toHaveBeenCalled();
    } finally { setCurrentAuth(previous); }
  });
  it.each(['plain', 'e2ee'] as const)('clears confirmed deleted result marks through the %s Account owner and forwards locked Machine refusals', async mode => {
    const secret = new Uint8Array(32).fill(9);
    const encryption = mode === 'e2ee' ? await Encryption.create(secret) : null;
    const credentials = mode === 'e2ee' ? { secret: encodeBase64(secret, 'base64url'), token: createAccountTokenForTests('account') } : undefined;
    const serverId = await harness.addHome({ name: 'Clear Account', serverUrl: 'https://clear-account.example',
      accountId: 'account', accountEncryptionMode: mode, ...(credentials ? { credentials } : {}) });
    if (mode === 'e2ee') {
      const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
      harness.answer(serverId, '/v1/account/encryption/currentness', { body: { mode, version: 1, signingKeyFingerprint: 'signing',
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint), updatedAt: 1 } });
    }
    const kv = createAccountKvHttpFixture();
    const scopeId = buildScmReviewScopeId({ repositoryRootPath: '/repo', source: savedResult.output.comparison!.source });
    const key = buildScmReviewedMarksKey(scopeId);
    const record = applyScmReviewedKeysIntent(scopeId, null, ['retained-old-key'], true);
    const value = encryption ? await encryption.encryptRaw(record) : encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: record });
    await kv.handleFetch('https://clear-account.example/v1/kv', { method: 'POST', body: JSON.stringify({ mutations: [{ key, value, version: -1 }] }) });
    for (const path of ['/v1/kv', '/v1/kv/bulk']) harness.answer(serverId, path, { select: async (_body, request) => {
      const response = await kv.handleFetch(request.url, request.init);
      if (!response) throw new Error('Unexpected Account KV request');
      return { status: response.status, body: await response.json() };
    } });
    let current = savedResult; let saved = true; let deletes = 0;
    let deletionFailure: ScmDiffSummaryResultFailure | null = null;
    const deleteRequests: unknown[] = [];
    rpc.mockImplementation(async ({ method, payload }) => {
      if (method === 'scm.diffSummary.result.read') return { success: true, result: current };
      if (method === 'scm.diffSummary.capture') return { success: true, comparison: current.output.comparison, metadata: current.output.metadata };
      if (method === 'scm.diffSummary.result.list') return saved ? listed : { ...listed, results: [], count: 0, bytes: 0 };
      if (method === 'scm.diffSummary.result.delete') {
        deleteRequests.push(payload);
        // RPC is the boundary. The real Machine owns revision/application checks under its lock.
        if (deletionFailure) return deletionFailure;
        deletes++; saved = false;
        return { success: true, resultId: 'saved', comparisonId };
      }
      throw new Error('Unexpected machine operation');
    });
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => true });
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [{ resultId: 'saved' }], failures: [] });
    expect(await ops.list()).toMatchObject({ success: true, count: 0 });
    expect(harness.requestsFor('/v1/kv')).toHaveLength(1);
    const stored = kv.read(key)!.value;
    expect(encryption ? await encryption.decryptRaw(stored!) : JSON.parse(new TextDecoder().decode(Buffer.from(stored!, 'base64'))).v)
      .toEqual({ ...record, reviewedChangeKeys: [] });
    saved = true;
    current = ScmDiffSummaryResultSchema.parse({ ...savedResult, revision: 2, output: { ...savedResult.output, revision: 2 } });
    deletionFailure = { success: false, errorCode: 'revision_conflict', error: 'A newer edit won under the deletion lock', latestRevision: 3 };
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [], failures: [{ errorCode: 'revision_conflict', latestRevision: 3 }] });
    expect(deleteRequests).toHaveLength(2);
    current = ScmDiffSummaryResultSchema.parse({ ...savedResult, application: { acceptedRevision: 0,
      acceptance: { comparisonId: 'comparison', repositoryRootPath: '/repo', expectedHeadOid: null, expectedRef: 'refs/heads/main', groups: [], leftOutChangeRefs: [] },
      status: 'applying', steps: [], nextGroupIndex: 0, stopAfterCurrent: false } });
    deletionFailure = { success: false, errorCode: 'application_locked', error: 'The accepted application is still applying', latestRevision: 1 };
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [], failures: [{ errorCode: 'application_locked' }] });
    expect(deleteRequests).toHaveLength(3);
    current = savedResult;
    deletionFailure = { success: false, errorCode: 'revision_conflict', error: 'A newer edit won', latestRevision: 2 };
    expect(await ops.clear(input)).toMatchObject({ success: true, deleted: [], failures: [{ errorCode: 'revision_conflict' }] });
    expect(deleteRequests).toEqual(Array.from({ length: 4 }, () => ({ cwd: '/repo', resultId: 'saved', expectedRevision: 1 })));
    expect(deletes).toBe(1);
    expect(harness.requestsFor('/v1/kv')).toHaveLength(1);
  });
  it('reports unavailable and retired inventory without claiming zero saved results', async () => {
    let current = true; const serverId = await addHome();
    rpc.mockImplementation(async () => { throw new Error('Owning Machine offline'); });
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => current });
    expect(await ops.list()).toMatchObject({ success: false, errorCode: 'result_unavailable' });
    expect(await ops.clear(input)).toMatchObject({ success: false, errorCode: 'result_unavailable' });
    expect(harness.requestsFor('/v1/kv')).toEqual([]);
    rpc.mockImplementation(async () => { current = false; return listed; });
    expect(await ops.list()).toMatchObject({ success: false, errorCode: 'result_unavailable' });
  });
  it('uses shared Action approval before deletion', async () => {
    const serverId = await addHome(); await harness.requireUiApproval(serverId, 'scm.diffSummary.result.clear');
    const ops = createScmDiffSummarySavedResultOperations({ machineId: 'machine', serverId, accountId: 'account', shouldContinue: () => true });
    expect(await ops.clear(input)).toMatchObject({ success: false, errorCode: 'approval_required', approvalArtifactId: expect.any(String) });
    expect(rpc).not.toHaveBeenCalled(); expect(harness.requestsFor('/v1/kv')).toEqual([]);
    expect(harness.artifacts(serverId).list()).toHaveLength(1);
  });
});
