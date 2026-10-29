import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, ScmPullRequestPrepareWorktreeRequestSchema, buildScmChangeKeys,
    buildScmReviewedMarksKey, buildScmReviewScopeId, type ScmComparison } from '@happier-dev/protocol/scm';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { subscribeAcknowledgedWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const { storage } = await import('@/sync/domains/state/storage');
const { createUiScmAction } = await import('./scmActionDeps');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { sessionScmCommitUndoLast } = await import('@/sync/ops/sessionScm');
const { answerScmRunMachineCustodyForTests } = await import('@/dev/testkit/harness/scmActionTransport');

const executeCanonicalAction = async () => ({ ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' });
const expectedHeadOid = 'a'.repeat(40);

beforeEach(async () => {
    await harness.reset();
    storage.setState(storage.getInitialState(), true);
    rpc.mockReset();
    rpc.mockImplementation(async ({ method }: { method: string }) => method === 'scm.backend.describe'
        ? { success: true, capabilities: createScmCapabilities({ writeCommitUndoLast: true }) }
        : method === 'scm.pullRequest.prepareWorktree' ? { success: true, targetPath: '/repo/review' }
        : { success: true, undoneCommitSha: expectedHeadOid });
});
afterEach(() => standardCleanup());

describe('SCM Action target binding', () => {
    it('validates captured exact keys and scope reset against host evidence before Account CAS', async () => {
        const serverId = await harness.addHome({ name: 'Marks Home', serverUrl: 'https://marks.test',
            serverIdentityId: 'srv_marks', accountId: 'requester', currentAccount: true });
        const comparison: ScmComparison = { id: 'a'.repeat(64), source: { kind: 'session', sessionId: 'session-a' },
            repository: { rootPath: '/repo' }, endpoints: { before: 'old', after: 'new' }, inventory: { state: 'complete', reasons: [], files: [{
                path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: '@@ -1,5 +1,5 @@\n-old\n+new\n middle\n-before\n+after\n tail\n last\n' },
                occurrences: [{ id: 'exact', alias: 'c1', path: 'a.ts', position: 0,
                    before: { startLine: 1, lineCount: 5 }, after: { startLine: 1, lineCount: 5 } }],
            }] } };
        const keys = buildScmChangeKeys(comparison).get('exact')!;
        expect(keys).toHaveLength(2);
        const kv = createAccountKvHttpFixture();
        const key = buildScmReviewedMarksKey(buildScmReviewScopeId({ repositoryRootPath: '/repo', source: comparison.source }));
        const kvPath = `/v1/kv/${encodeURIComponent(key)}`;
        const liveKey = buildScmReviewedMarksKey(buildScmReviewScopeId({ repositoryRootPath: '/repo', source: { kind: 'workingTree' } }));
        for (const path of ['/v1/kv', kvPath, `/v1/kv/${encodeURIComponent(liveKey)}`]) harness.answer(serverId, path, { select: async (_input, request) => {
            const response = await kv.handleFetch(request.url, request.init);
            if (!response) throw new Error('Missing KV boundary');
            return { status: response.status, body: await response.json() };
        } });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method !== 'scm.diffSummary.capture') throw new Error('Captured selection read a live diff');
            return { success: true, comparison, metadata: { source: comparison.source, sourceKey: comparison.id } };
        });
        const account = await captureLazyActionAccountContext(serverId);
        const invoke = createUiScmAction(account);
        const context = { serverId, runtimeAccountId: 'requester', externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
        const selector = { v: 2, cwd: '/repo', source: comparison.source, comparisonId: comparison.id };
        const readKeys = () => JSON.parse(Buffer.from(kv.read(key)!.value!, 'base64').toString()).v.reviewedChangeKeys;
        try {
            expect(await invoke({ actionId: 'scm.diffSummary.reviewed.mark', input: { ...selector, changeKeys: [keys[0]] },
                context, executeCanonicalAction })).toMatchObject({ success: true, record: { reviewedChangeKeys: [keys[0]] } });
            expect(readKeys()).toEqual([keys[0]]);
            expect(await invoke({ actionId: 'scm.diffSummary.reviewed.mark', input: { ...selector, changeKeys: ['forged'] },
                context, executeCanonicalAction })).toMatchObject({ success: false, errorCode: 'reviewed_marks_invalid_selection' });
            expect(readKeys()).toEqual([keys[0]]);
            expect(await invoke({ actionId: 'scm.diffSummary.reviewed.mark', input: { ...selector,
                source: { kind: 'session', sessionId: 'different-session' }, changeKeys: [keys[0]] },
                context, executeCanonicalAction })).toMatchObject({ success: false, errorCode: 'reviewed_marks_unavailable' });
            expect(readKeys()).toEqual([keys[0]]);
            const row = kv.read(key)!;
            await kv.handleFetch('https://marks.test/v1/kv', { method: 'POST', body: JSON.stringify({ mutations: [{ key,
                value: Buffer.from(JSON.stringify({ t: 'plain', v: { v: 1, scopeId: buildScmReviewScopeId({ repositoryRootPath: '/repo', source: comparison.source }),
                    reviewedChangeKeys: [...keys, 'obsolete-key'] } })).toString('base64'), version: row.version }] }) });
            expect(await invoke({ actionId: 'scm.diffSummary.reviewed.unmark', input: { ...selector, reset: true },
                context, executeCanonicalAction })).toMatchObject({ success: true, record: { reviewedChangeKeys: [] } });
            expect(readKeys()).toEqual([]);
            rpc.mockResolvedValueOnce({ success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Evidence host offline' });
            expect(await invoke({ actionId: 'scm.diffSummary.reviewed.unmark', input: { ...selector, reset: true },
                context, executeCanonicalAction })).toMatchObject({ success: false, errorCode: 'reviewed_marks_unavailable' });
            const liveReads: string[] = [];
            rpc.mockImplementation(async ({ method }: { method: string }) => {
                liveReads.push(method);
                if (method !== 'scm.status.snapshot') throw new Error('Reset fetched unneeded file bodies');
                return { success: true, snapshot: { projectKey: 'machine:/repo', fetchedAt: 1,
                    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' }, capabilities: createScmCapabilities(),
                    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false }, hasConflicts: false,
                    entries: [{ path: 'a.ts', kind: 'modified', includeStatus: '.', pendingStatus: 'M', hasPendingDelta: true }],
                    totals: { includedFiles: 0, pendingFiles: 1, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0,
                        pendingAdded: 1, pendingRemoved: 1, isComplete: true } } };
            });
            expect(await invoke({ actionId: 'scm.diffSummary.reviewed.unmark', input: { v: 2, cwd: '/repo', source: { kind: 'workingTree' }, reset: true },
                context, executeCanonicalAction })).toMatchObject({ success: true, record: { reviewedChangeKeys: [] } });
            // Reset needs repository/scope authority, never per-file content bodies.
            expect(liveReads).toEqual(['scm.status.snapshot']);
        } finally { account.dispose(); }
    });
    it.each((['scm.diffSummary.generate', 'scm.diffSummary.draftPullRequest', 'scm.diffSummary.refine',
        'scm.diffSummary.addOutputs', 'scm.diffSummary.discuss'] as const).flatMap(actionId =>
        (['machine', 'session'] as const).map(targetKind => ({ actionId, targetKind }))))
    ('carries the original Project requester to retained analysis for $actionId on $targetKind', async ({ actionId, targetKind }) => {
        const homeId = 'srv_scm_requester';
        const serverId = await harness.addHome({ name: 'SCM requester', serverUrl: 'https://scm-requester.test',
            serverIdentityId: homeId, accountId: 'requester', currentAccount: true });
        const installation = answerScmRunMachineCustodyForTests(harness, serverId, actionId,
            { homeId, accountId: 'requester', machineId: 'machine', installationId: 'installation' });
        if (targetKind === 'session') storage.setState({ sessions: { selected: createSessionFixture({ id: 'selected', serverId,
            metadata: { path: '/repo', machineId: 'machine', host: 'host', homeDir: '/home/user' },
        }) } });
        const path = `/v1/actions/${actionId}`;
        const cwd = targetKind === 'session' ? '/not-the-session-repository' : '/repo';
        const saved = { cwd, resultId: 'saved', expectedRevision: 0 };
        const authoredInput = actionId === 'scm.diffSummary.refine'
            ? { ...saved, output: 'commitPlan', instructions: 'Explain the commit groups.' }
            : actionId === 'scm.diffSummary.addOutputs' ? { ...saved, outputs: ['commitPlan'] }
            : actionId === 'scm.diffSummary.discuss' ? { ...saved, message: 'Explain the change.' }
            : { cwd, source: { kind: 'workingTree' }, outputs: ['commitPlan'] };
        const input = getActionSpec(actionId).inputSchema.parse(authoredInput);
        harness.answer(serverId, path, { select: body => {
            const envelope = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            if (envelope.envelope.v !== 1) throw new Error('Plain Account must send a plain Action envelope');
            expect(envelope.envelope.input).toEqual({ ...authoredInput, cwd: '/repo',
                ...(targetKind === 'session' && (actionId === 'scm.diffSummary.generate'
                    || actionId === 'scm.diffSummary.draftPullRequest') ? { sessionId: 'selected' } : {}) });
            expect(openExternalActionRequesterAccountContextV1({ authorization: envelope.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation', serverIdentityId: homeId,
                installationPrivateKey: installation.secretKey, includeInvocation: true })).toMatchObject({
                invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
            });
            return { body: { v: 1, actionId, requestId: envelope.envelope.requestId,
                execution: { ok: false, errorCode: 'target_unavailable', error: 'Requester retired' } } };
        } });
        const account = await captureLazyActionAccountContext(serverId);
        try {
            expect(await createUiScmAction(account)({ actionId, input, context: {
                serverId, runtimeAccountId: 'requester', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                ...(targetKind === 'session' ? { defaultSessionId: 'selected', externalActionTarget: { kind: 'session' as const, sessionId: 'selected' } }
                    : { externalActionTarget: { kind: 'machine' as const, machineId: 'machine', project: { machineId: 'machine', directory: '/repo' } } }),
            }, executeCanonicalAction })).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(harness.requestsFor(path)).toHaveLength(1);
            expect(harness.requestsFor(`${path}/execution-authorization`)).toHaveLength(1);
            expect(rpc).not.toHaveBeenCalled();
        } finally { account.dispose(); }
    });
    it('refuses an unresolved Session run without issuing an Action or falling back to raw RPC', async () => {
        const serverId = await harness.addHome({ name: 'Missing Session', serverUrl: 'https://scm-missing.test',
            serverIdentityId: 'srv_scm_missing', accountId: 'requester', currentAccount: true });
        const account = await captureLazyActionAccountContext(serverId);
        try {
            expect(await createUiScmAction(account)({ actionId: 'scm.diffSummary.generate', input: {
                cwd: '/not-the-session-repository', source: { kind: 'workingTree' },
            }, context: { serverId, runtimeAccountId: 'requester', surface: 'ui', authority: 'present_user',
                actionCaller: { kind: 'host' }, externalActionTarget: { kind: 'session', sessionId: 'missing' },
            }, executeCanonicalAction })).toMatchObject({ ok: false, errorCode: 'BACKEND_UNAVAILABLE' });
            expect(harness.requestsFor('/v1/actions/scm.diffSummary.generate')).toHaveLength(0);
            expect(rpc).not.toHaveBeenCalled();
        } finally { account.dispose(); }
    });
    it('acknowledges Discard and Restore hashes but not refused or kept-edited files', async ({ onTestFinished }) => {
        const hashes: Array<string | null> = [];
        const dispose = subscribeAcknowledgedWorkspaceFileWrites({ serverId: 'home', accountId: 'account',
            machineId: 'machine', rootPath: '/repo' }, 'file.txt', write => { hashes.push(write.hash); });
        onTestFinished(dispose);
        const invoke = createUiScmAction();
        const input = { cwd: '/repo', entries: [{ path: 'file.txt', kind: 'modified' as const }] };
        const context = { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
        for (const [status, hashAfter] of [['reverted', 'a'.repeat(64)], ['recreated', 'b'.repeat(64)],
            ['deleted', null], ['kept_edited', 'c'.repeat(64)], ['refused', null]] as const) {
            rpc.mockResolvedValueOnce({ success: true, entries: [{ path: 'file.txt', status,
                hashBefore: 'd'.repeat(64), hashAfter }] });
            await invoke({ actionId: 'scm.change.discard', input, context, executeCanonicalAction });
        }
        expect(hashes).toEqual(['a'.repeat(64), 'b'.repeat(64), null]);
    });
    it('acknowledges a Session discard on its resolved workspace, never the authored cwd', async () => {
        const serverId = await harness.addHome({ name: 'Selected Home', serverUrl: 'https://selected.example',
            accountId: 'account-other', serverIdentityId: 'srv_selected', currentAccount: true });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        storage.setState({ sessions: { selected: createSessionFixture({ id: 'selected', serverId,
            metadata: { path: '/repo/selected', machineId: 'machine-other', host: 'host', homeDir: '/home/user' },
        }) } });
        const hashes: Array<string | null> = [];
        const workspace = { serverId, accountId: 'account-other', machineId: 'machine-other', rootPath: '/repo/selected' };
        const dispose = subscribeAcknowledgedWorkspaceFileWrites(workspace, 'file.txt', write => { hashes.push(write.hash); });
        const wrong: Array<string | null> = [];
        const disposeWrong = subscribeAcknowledgedWorkspaceFileWrites({ ...workspace, rootPath: '/repo/not-selected' }, 'file.txt',
            write => { wrong.push(write.hash); });
        try {
            rpc.mockResolvedValue({ success: true, entries: [{ path: 'file.txt', status: 'restored',
                hashBefore: 'a'.repeat(64), hashAfter: 'b'.repeat(64) }] });
            const result = await createUiScmAction()({ actionId: 'scm.change.discard',
                input: { cwd: '/repo/not-selected', entries: [{ path: 'file.txt', kind: 'modified' }] },
                context: { serverId, runtimeAccountId: 'account-other', defaultSessionId: 'selected' }, executeCanonicalAction });
            expect(result).toMatchObject({ success: true, entries: [{ path: 'file.txt', hashAfter: 'b'.repeat(64) }] });
            expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-other',
                method: 'scm.change.discard', payload: expect.objectContaining({ cwd: '/repo/selected' }),
                authorization: { kind: 'session.write', sessionId: 'selected' } }));
            expect(hashes).toEqual(['b'.repeat(64)]);
            expect(wrong).toEqual([]);
        } finally { dispose(); disposeWrong(); }
    });
    it('acknowledges committed siblings in a partially refused Discard result', async ({ onTestFinished }) => {
        const hashes: Array<string | null> = [];
        onTestFinished(subscribeAcknowledgedWorkspaceFileWrites({ serverId: 'home', accountId: 'account',
            machineId: 'machine', rootPath: '/repo' }, 'file.txt', write => { hashes.push(write.hash); }));
        rpc.mockResolvedValue({ success: false, errorCode: 'CHANGE_MOVED_ON', error: 'Other file changed', entries: [
            { path: 'file.txt', status: 'reverted', hashBefore: 'a'.repeat(64), hashAfter: 'b'.repeat(64) },
            { path: 'other.txt', status: 'refused', hashBefore: null, hashAfter: null, errorCode: 'CHANGE_MOVED_ON' },
        ] });
        const result = await createUiScmAction()({ actionId: 'scm.change.discard',
            input: { cwd: '/repo', entries: [{ path: 'file.txt', kind: 'modified' }, { path: 'other.txt', kind: 'modified' }] },
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } },
            executeCanonicalAction });
        expect(result).toMatchObject({ success: false });
        expect(hashes).toEqual(['b'.repeat(64)]);
    });
    it('resolves an address on a Machine without a checkout or repository payload', async () => {
        const result = { success: true, kind: 'unknown' };
        rpc.mockResolvedValue(result);
        expect(await createUiScmAction()({ actionId: 'scm.hostingRepository.resolveAddress', input: { address: 'forge.test/team/repo' },
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        })).toEqual(result);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', serverId: 'home',
            method: 'scm.hostingRepository.resolveAddress', payload: { address: 'forge.test/team/repo' } }));
    });
    it('reads repository visibility on the selected Machine without a checkout and refuses an implicit Session', async () => {
        const input = { selector: { provider: { id: 'plugin/forge', kind: 'custom', displayName: 'Forge', baseUrl: 'https://forge.test' },
            repository: { nameWithOwner: 'team/repo' }, protocol: 'https' } };
        const result = { success: true, kind: 'private' };
        rpc.mockResolvedValue(result);
        const invoke = createUiScmAction();
        expect(await invoke({ actionId: 'scm.hostingRepository.get', input,
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } },
            executeCanonicalAction })).toEqual(result);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', serverId: 'home',
            method: 'scm.hostingRepository.get', payload: input }));
        expect(await invoke({ actionId: 'scm.hostingRepository.get', input,
            context: { defaultSessionId: 'session' }, executeCanonicalAction })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
    });
    it('routes machine inventory without inventing a repository and rejects a Session inventory request', async () => {
        const inventory = { success: true, results: [], count: 0, bytes: 0,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
        rpc.mockResolvedValue(inventory);
        expect(await createUiScmAction()({ actionId: 'scm.diffSummary.result.list', input: {},
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        })).toEqual(inventory);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', payload: {}, method: 'scm.diffSummary.result.list' }));
        expect(await createUiScmAction()({ actionId: 'scm.diffSummary.result.list', input: {},
            context: { defaultSessionId: 'session' }, executeCanonicalAction,
        })).toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
    });
    it('does not attach a Git reconciliation outcome to an unconfirmed result edit', async () => {
        rpc.mockRejectedValue(new Error('Disconnected'));
        const response = await createUiScmAction()({ actionId: 'scm.diffSummary.result.edit',
            input: { cwd: '/repo', resultId: 'saved', expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'Draft' } },
            context: { externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        });
        expect(ActionExecuteFailureSchema.parse(response)).toMatchObject({ ok: false, errorCode: 'COMMAND_OUTCOME_UNKNOWN' });
        expect(response).not.toHaveProperty('outcome');
    });
    it('sends strict saved-result requests without Git mutation envelope fields', async () => {
        storage.setState({ settings: { ...storage.getState().settings, scmGitRepoPreferredBackend: 'sapling' } });
        rpc.mockResolvedValue({ success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 2 });
        const input = { cwd: '/repo', resultId: 'saved', expectedRevision: 1, edit: { kind: 'renameWalkthrough', title: 'Draft' } };
        expect(await createUiScmAction()({ actionId: 'scm.diffSummary.result.edit', input,
            context: { serverId: 'home', runtimeAccountId: 'account', externalActionTarget: { kind: 'machine', machineId: 'machine' } }, executeCanonicalAction,
        })).toEqual({ success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 2 });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ payload: input }));
    });
    it('refuses machine undo without an explicit repository instead of using daemon cwd', async () => {
        expect(await createUiScmAction()({ actionId: 'scm.commit.undoLast', input: { expectedHeadOid },
            context: { serverId: 'home-other', runtimeAccountId: 'account-other', externalActionTarget: { kind: 'machine', machineId: 'machine-other' } }, executeCanonicalAction,
        })).toMatchObject({ ok: false, errorCode: 'invalid_input' });
        expect(rpc).not.toHaveBeenCalled();
    });

    it('binds session undo and prepared-worktree source to the selected session repository', async () => {
        const serverId = await harness.addHome({ name: 'Selected Home', serverUrl: 'https://selected.example',
            accountId: 'account-other', serverIdentityId: 'srv_selected', currentAccount: true });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        storage.setState({ sessions: { selected: createSessionFixture({ id: 'selected', serverId,
            metadata: { path: '/repo/selected', machineId: 'machine-other', host: 'host', homeDir: '/home/user' },
        }) } });
        const context = { serverId, runtimeAccountId: 'account-other', defaultSessionId: 'selected' };
        await createUiScmAction()({ actionId: 'scm.commit.undoLast', input: { cwd: '/repo/not-selected', expectedHeadOid }, context, executeCanonicalAction });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ serverId, accountId: 'account-other', machineId: 'machine-other',
            method: 'scm.commit.undoLast', payload: { cwd: '/repo/selected', expectedHeadOid, outcomeVersion: 1 },
        }));
        const preparedInput = ScmPullRequestPrepareWorktreeRequestSchema.parse({ cwd: '/repo/not-selected', sourcePath: '/repo/not-selected', prReference: { number: 7 } });
        await createUiScmAction()({ actionId: 'scm.pullRequest.prepareWorktree', input: preparedInput, context, executeCanonicalAction });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'scm.pullRequest.prepareWorktree', payload: {
            ...preparedInput, cwd: '/repo/selected', sourcePath: '/repo/selected', outcomeVersion: 1,
        } }));
        // Action binding must not change the ordinary facade's relative-path contract.
        const receipt = await sessionScmCommitUndoLast('selected', { cwd: 'nested', expectedHeadOid }, serverId);
        expect(receipt, JSON.stringify({ receipt, http: harness.requests.map(({ serverUrl, path }) => ({ serverUrl, path })) }))
            .toMatchObject({ success: true, undoneCommitSha: expectedHeadOid });
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine-other',
            method: 'scm.commit.undoLast', payload: { cwd: '/repo/selected/nested', expectedHeadOid, outcomeVersion: 1 },
        }));
    });
});
