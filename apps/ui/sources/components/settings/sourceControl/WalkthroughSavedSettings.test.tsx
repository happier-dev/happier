import * as React from 'react';
import '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ScmDiffSummaryResultSchema, ScmReviewedMarksRecordSchema, applyScmReviewedKeysIntent, buildScmReviewedMarksKey, buildScmReviewScopeId } from '@happier-dev/protocol/scm';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { decideApprovalAsInbox, installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { decodeBase64StoredJsonContentEnvelope, encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { t } from '@/text';

const boundary = vi.hoisted(() => ({
    list: async (_machineId: string, _input?: unknown): Promise<unknown> => { throw new Error('Owning machine unavailable'); },
    read: async (): Promise<unknown> => { throw new Error('Saved result unavailable'); },
    capture: async (): Promise<unknown> => { throw new Error('Captured comparison unavailable'); },
    clear: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

// Device custody and the remote machine are external; binding, schemas and saved operations stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const rpc = async (request: { machineId: string; method: string; payload: unknown }) => {
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST) return boundary.list(request.machineId, request.payload);
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_READ) return boundary.read();
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) return boundary.capture();
        if (request.method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_DELETE) return boundary.clear();
        throw new Error(`Unexpected machine method: ${request.method}`);
    };
    // Method-specific wire answers at the external generic RPC boundary.
    return createServerScopedMachineRpcBoundaryMock(rpc as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});

// Native rendering adapters only; the settings store and credential binding remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@expo/vector-icons/Ionicons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    const icons = createExpoVectorIconsMock();
    return { default: icons.Ionicons, Ionicons: icons.Ionicons };
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const disposeActionLoader = await installRealActionExecutorModuleLoader();
const { renderSettingsView } = await import('@/dev/testkit/harness/settingsViewHarness');
const { Switch } = await import('@/components/ui/forms/Switch');
const { WalkthroughSavedSettings } = await import('./WalkthroughSavedSettings');
const { Modal } = await import('@/modal');
afterAll(disposeActionLoader);
beforeEach(async () => {
    await homes.reset();
    boundary.clear.mockReset();
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
});
afterEach(async () => { standardCleanup(); await homes.reset(); });
async function addHome(name: string) {
    const id = await homes.addHome({ name, serverUrl: 'https://saved-settings.example.test', accountId: 'saved-account',
        serverIdentityId: 'srv_saved_settings_home', accountEncryptionMode: 'plain', currentAccount: true });
    homes.answer(id, '/v1/account/encryption/currentness', { body: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    return { id };
}

function savedResultFixture() {
    const comparisonId = 'a'.repeat(64);
    return ScmDiffSummaryResultSchema.parse({ resultId: 'saved', revision: 1, canUndo: false,
        output: { success: true, resultId: 'saved', revision: 1, sourceKey: comparisonId,
            metadata: { source: { kind: 'workingTree' }, sourceKey: comparisonId }, requestedOutputs: ['summary'],
            outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Saved explanation' } } },
            analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
            comparison: { id: comparisonId, source: { kind: 'workingTree' }, repository: { rootPath: '/repo' },
                endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
        },
    });
}

describe('Prepare walkthrough preference', () => {
    it.each([
        { policy: 'default', confirm: true, prompts: 1, deleted: true, approvals: 0 },
        { policy: 'require', confirm: true, prompts: 0, deleted: true, approvals: 1 },
        { policy: 'require', confirm: false, prompts: 0, deleted: false, approvals: 1 },
        { policy: 'waive', confirm: true, prompts: 0, deleted: true, approvals: 0 },
        { policy: 'default', confirm: false, prompts: 1, deleted: false, approvals: 0 },
    ] as const)('uses shared $policy approval for Clear (confirmed: $confirm)', async ({ policy, confirm, prompts, deleted, approvals }) => {
        const home = await addHome('Saved approval');
        await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId: home.id,
            accountId: 'saved-account', machineId: 'approval-machine' });
        const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
        const machine = createMachineFixture({ id: 'approval-machine' });
        await publishMachineInventoryForTest({ serverId: home.id, accountId: 'saved-account' },
            [{ ...machine, metadata: { ...machine.metadata!, displayName: 'Studio' } }]);
        homes.answer(home.id, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: policy === 'require'
                ? { 'scm.diffSummary.result.clear': { approvalRequiredSurfaces: ['ui'] } } : {},
                ...(policy === 'waive' ? { approvalWaivedSurfaces: { 'scm.diffSummary.result.clear': ['ui'] } } : {}),
            },
        } } } });
        const saved = savedResultFixture();
        const kv = createAccountKvHttpFixture();
        const reviewScope = buildScmReviewScopeId({ repositoryRootPath: '/repo', source: saved.output.comparison!.source });
        for (const path of ['/v1/kv', `/v1/kv/${encodeURIComponent(buildScmReviewedMarksKey(reviewScope))}`]) homes.answer(home.id, path, {
            select: async (_input, request) => {
                const response = await kv.handleFetch(request.url, request.init);
                if (!response) throw new Error('Missing Account KV boundary');
                return { status: response.status, body: await response.json() };
            },
        });
        let exists = true;
        let lists = 0;
        const usageReads: boolean[] = [];
        const inventory = { success: true, results: [{ cwd: '/repo', resultId: 'saved', revision: 1,
            comparisonId: saved.output.sourceKey, source: { kind: 'workingTree' }, bytes: 12, updatedAtMs: 1 }],
            count: 1, bytes: 12, sevenDayCost: { status: 'partial', estimatedUsd: 0.25,
                pricedRunCount: 1, unpricedRunCount: 1, sinceMs: 0, untilMs: 1 } };
        boundary.list = async (_machineId, input) => {
            lists++;
            const includeUsage = Boolean(input && typeof input === 'object' && 'includeUsage' in input && input.includeUsage);
            usageReads.push(includeUsage);
            const { sevenDayCost, ...withoutUsage } = inventory;
            const selected = includeUsage ? inventory : withoutUsage;
            return exists ? selected : { ...selected, results: [], count: 0, bytes: 0 };
        };
        boundary.read = async () => ({ success: true, result: saved });
        boundary.capture = async () => ({ success: true, comparison: saved.output.comparison, metadata: saved.output.metadata });
        boundary.clear.mockImplementation(async () => {
            exists = false;
            return { success: true, resultId: 'saved', comparisonId: saved.output.sourceKey };
        });
        vi.mocked(Modal.confirm).mockResolvedValue(confirm);
        const screen = await renderSettingsView(<WalkthroughSavedSettings machineId="approval-machine" serverId={home.id}
            machineName="Studio" machineAvailability="online" prepareAfterTurn={false}
            onPrepareAfterTurn={() => {}} modelAvailable />);
        const clearButton = () => screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear');
        await vi.waitFor(() => expect(clearButton()?.props.disabled, screen.getTextContent()).toBe(false));
        expect(lists).toBe(1);
        const costText = t('walkthroughSettings.cost', { amount: new Intl.NumberFormat(undefined,
            { style: 'currency', currency: 'USD' }).format(0.25), partial: true });
        expect(screen.getTextContent()).toContain(costText);
        await screen.update(<WalkthroughSavedSettings machineId="approval-machine" serverId={home.id}
            machineName="Studio" machineAvailability="online" prepareAfterTurn={false}
            onPrepareAfterTurn={() => {}} modelAvailable={false} />);
        expect(lists).toBe(1);
        await screen.pressByTestIdAsync('settings.sourceControl.savedWalkthroughs.clear');
        if (policy === 'require') {
            await vi.waitFor(() => expect(homes.artifacts(home.id).list()).toHaveLength(1));
            expect(exists).toBe(true);
            expect(boundary.clear).not.toHaveBeenCalled();
            expect(clearButton()?.props.disabled).toBe(true);
            const approvalId = homes.artifacts(home.id).list()[0]!.id;
            const pending = ApprovalRequestV2Schema.parse(JSON.parse(homes.artifacts(home.id).readPlainBody(approvalId)!));
            expect(pending.approval?.flow).toBe('blocking');
            const decision = await decideApprovalAsInbox(home.id, approvalId, confirm ? 'approve' : 'reject');
            expect(decision.ok).toBe(true);
            const status = decision.ok && decision.result && typeof decision.result === 'object' && 'status' in decision.result
                ? decision.result.status : null;
            const terminal = ApprovalRequestV2Schema.parse(JSON.parse(homes.artifacts(home.id).readPlainBody(approvalId)!));
            const failure = terminal.execution?.ok === false ? terminal.execution : null;
            const reason = failure?.details && typeof failure.details === 'object' && 'reason' in failure.details
                ? failure.details.reason : null;
            expect(confirm ? status === 'approved' || status === 'executed' : status === 'rejected',
                JSON.stringify({ status, errorCode: failure?.errorCode, reason })).toBe(true);
        }
        await vi.waitFor(() => {
            expect(deleted ? clearButton() === null : clearButton()?.props.disabled === false,
                JSON.stringify({ exists, deletions: boundary.clear.mock.calls.length, text: screen.getTextContent() })).toBe(true);
            expect(homes.artifacts(home.id).list()).toHaveLength(approvals);
        });
        // Confirmation cardinality and its answer are the visible policy contract.
        // Clear's own inventory read remains; only mount may request the separate usage projection.
        expect(usageReads.filter(Boolean)).toHaveLength(1);
        if (deleted) expect(usageReads.at(-1)).toBe(false);
        expect(screen.getTextContent()).toContain(costText);
        expect(Modal.confirm).toHaveBeenCalledTimes(prompts);
        if (prompts > 0) expect(Modal.confirm).toHaveBeenCalledWith(t('walkthroughSettings.clearTitle'),
            t('walkthroughSettings.clearDescription', { machine: 'Studio' }), expect.objectContaining({ destructive: true,
                confirmText: t('walkthroughSettings.clear') }));
        expect(exists).toBe(!deleted);
        expect(boundary.clear).toHaveBeenCalledTimes(deleted ? 1 : 0);
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.clearFailed'));
        await screen.unmount();
    });

    it('fails closed when a required Clear loses its mounted invocation', async () => {
        const home = await addHome('Saved retired approval');
        await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId: home.id,
            accountId: 'saved-account', machineId: 'retired-machine' });
        await homes.requireUiApproval(home.id, 'scm.diffSummary.result.clear');
        const saved = savedResultFixture();
        boundary.list = async () => ({ success: true, results: [{ cwd: '/repo', resultId: saved.resultId,
            revision: saved.revision, comparisonId: saved.output.sourceKey, source: { kind: 'workingTree' },
            bytes: 12, updatedAtMs: 1 }], count: 1, bytes: 12 });
        boundary.read = async () => ({ success: true, result: saved });
        boundary.clear.mockResolvedValue({ success: true, resultId: saved.resultId, comparisonId: saved.output.sourceKey });
        const screen = await renderSettingsView(<WalkthroughSavedSettings machineId="retired-machine" serverId={home.id}
            machineName="Studio" machineAvailability="online" prepareAfterTurn={false}
            onPrepareAfterTurn={() => {}} modelAvailable />);
        await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings.sourceControl.savedWalkthroughs.clear');
        await vi.waitFor(() => expect(homes.artifacts(home.id).list()).toHaveLength(1));
        const approvalId = homes.artifacts(home.id).list()[0]!.id;
        await screen.unmount();
        await vi.waitFor(() => expect(ApprovalRequestV2Schema.parse(JSON.parse(homes.artifacts(home.id).readPlainBody(approvalId)!)).status).toBe('canceled'));
        const decision = await decideApprovalAsInbox(home.id, approvalId, 'approve');
        expect(decision.ok).toBe(false);
        expect(boundary.clear).not.toHaveBeenCalled();
        expect(Modal.confirm).not.toHaveBeenCalled();
    });

    it.each(['default', 'require'] as const)('retains marks-cleanup failure after the saved inventory empties and retries only the marks (%s)', async retryPolicy => {
        const home = await addHome('Saved cleanup');
        await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId: home.id,
            accountId: 'saved-account', machineId: 'cleanup-machine' });
        if (retryPolicy === 'require') homes.answer(home.id, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'scm.diffSummary.reviewed.unmark': { approvalRequiredSurfaces: ['ui'] } } },
        } } } });
        const saved = savedResultFixture();
        const comparison = saved.output.comparison!;
        const scopeId = buildScmReviewScopeId({ repositoryRootPath: comparison.repository.rootPath, source: comparison.source });
        const key = buildScmReviewedMarksKey(scopeId);
        const kv = createAccountKvHttpFixture();
        const marked = applyScmReviewedKeysIntent(scopeId, null, ['previously-reviewed-change'], true);
        await kv.handleFetch('https://saved-settings.example.test/v1/kv', { method: 'POST', body: JSON.stringify({
            mutations: [{ key, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: marked }), version: -1 }],
        }) });
        let cleanupUnavailable = true;
        for (const path of ['/v1/kv', `/v1/kv/${encodeURIComponent(key)}`]) homes.answer(home.id, path, {
            select: async (_input, request) => {
                if (request.init?.method === 'POST' && cleanupUnavailable) return { status: 503, body: { error: 'unavailable' } };
                const response = await kv.handleFetch(request.url, request.init);
                if (!response) throw new Error('Missing Account KV boundary');
                return { status: response.status, body: await response.json() };
            },
        });
        let exists = true;
        let resultReads = 0;
        const inventory = { success: true, results: [{ cwd: '/repo', resultId: saved.resultId, revision: saved.revision,
            comparisonId: comparison.id, source: comparison.source, bytes: 12, updatedAtMs: 1 }], count: 1, bytes: 12 };
        boundary.list = async () => exists ? inventory : { ...inventory, results: [], count: 0, bytes: 0 };
        boundary.read = async () => { resultReads++; return { success: true, result: saved }; };
        // Captured comparison evidence remains readable after deleting its saved narration.
        boundary.capture = async () => ({ success: true, comparison, metadata: saved.output.metadata });
        boundary.clear.mockImplementation(async () => {
            exists = false;
            return { success: true, resultId: saved.resultId, comparisonId: comparison.id };
        });
        const screen = await renderSettingsView(<WalkthroughSavedSettings machineId="cleanup-machine" serverId={home.id}
            machineName="Studio" machineAvailability="online" prepareAfterTurn={false}
            onPrepareAfterTurn={() => {}} modelAvailable />);
        await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings.sourceControl.savedWalkthroughs.clear');
        await vi.waitFor(() => expect(exists).toBe(false));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('walkthroughSettings.clearMarksCleanupFailed')));
        expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear') === null).toBe(true);
        await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retryMarksCleanup')?.props.disabled).toBe(false));
        const readsBeforeRetry = resultReads;
        cleanupUnavailable = false;
        await screen.pressByTestIdAsync('settings.sourceControl.savedWalkthroughs.retryMarksCleanup');
        if (retryPolicy === 'require') {
            await vi.waitFor(() => expect(homes.artifacts(home.id).list()).toHaveLength(1));
            expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retryMarksCleanup')?.props.disabled).toBe(true);
            expect(await decideApprovalAsInbox(home.id, homes.artifacts(home.id).list()[0]!.id, 'reject')).toMatchObject({ ok: true });
            await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retryMarksCleanup')?.props.disabled).toBe(false));
            expect(screen.getTextContent()).toContain(t('walkthroughSettings.clearMarksCleanupFailed'));
            await screen.pressByTestIdAsync('settings.sourceControl.savedWalkthroughs.retryMarksCleanup');
            await vi.waitFor(() => expect(homes.artifacts(home.id).list()).toHaveLength(2));
            expect(await decideApprovalAsInbox(home.id, homes.artifacts(home.id).list()[1]!.id, 'approve')).toMatchObject({ ok: true });
        }
        await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retryMarksCleanup') === null).toBe(true));
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.clearMarksCleanupFailed'));
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.savedCount', { count: 0, bytes: '0 B' }));
        expect(boundary.clear).toHaveBeenCalledTimes(1);
        expect(resultReads).toBe(readsBeforeRetry);
        const value = kv.read(key)?.value;
        expect(value).toBeTruthy();
        const envelope = decodeBase64StoredJsonContentEnvelope(value!);
        if (envelope?.t !== 'plain') throw new Error('Expected a plain Account fixture');
        expect(ScmReviewedMarksRecordSchema.parse(envelope.v).reviewedChangeKeys).toEqual([]);
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it.each([
        { status: 'unavailable' as const, pricedRunCount: 0, unpricedRunCount: 3 },
        { status: 'unavailable' as const, pricedRunCount: 0, unpricedRunCount: 0 },
        { status: 'partial' as const, estimatedUsd: 0.12, pricedRunCount: 2, unpricedRunCount: 1 },
        { status: 'partial' as const, estimatedUsd: 0, pricedRunCount: 1, unpricedRunCount: 0 },
    ])('discloses settled $status costs with $unpricedRunCount unpriced runs independently of model availability', async cost => {
        const home = await addHome('Saved costs');
        const pending = createDeferred<unknown>();
        boundary.list = async () => pending.promise;
        const view = (modelAvailable: boolean) => <WalkthroughSavedSettings
            machineId="cost-machine" serverId={home.id} machineName="Computer" machineAvailability="online"
            prepareAfterTurn={false} onPrepareAfterTurn={() => {}} modelAvailable={modelAvailable} />;
        const screen = await renderSettingsView(view(false));
        const amount = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cost.estimatedUsd ?? 0);
        const expected = cost.status === 'unavailable' ? t('walkthroughSettings.costUnavailable')
            : t('walkthroughSettings.cost', { amount, partial: true });
        expect(screen.getTextContent()).not.toContain(expected);
        await act(async () => { pending.resolve({ success: true, results: [], count: 0, bytes: 0,
            sevenDayCost: { ...cost, sinceMs: 0, untilMs: 1 } }); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('walkthroughSettings.savedCount', { count: 0, bytes: '0 B' })));
        expect(screen.getTextContent()).toContain(expected);
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.chooseModelFirst'));
        if (cost.status === 'unavailable') expect(screen.getTextContent()).not.toContain(amount);
        await screen.update(view(true));
        expect(screen.getTextContent()).toContain(expected);
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.chooseModelFirst'));
        await screen.unmount();
    });

    it('offers Retry for a failed online read and uses reconnect copy only for offline presence', async () => {
        const home = await addHome('Saved retry');
        const pending = createDeferred<unknown>();
        boundary.list = async () => pending.promise;
        const view = (machineAvailability: 'online' | 'offline' | 'unselected') => <WalkthroughSavedSettings
            machineId="retry-machine" serverId={home.id} machineName="Computer" machineAvailability={machineAvailability}
            prepareAfterTurn={false} onPrepareAfterTurn={() => {}} modelAvailable={false} />;
        const screen = await renderSettingsView(view('online'));
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.unavailableData'));
        await act(async () => { pending.resolve({ success: false, errorCode: 'result_unavailable', error: 'Saved inventory read failed' }); });
        await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retry')).not.toBeNull());
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.unavailableData'));
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.costUnavailable'));
        await screen.update(view('unselected'));
        expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retry') === null).toBe(true);
        await screen.update(view('online'));
        await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retry')).not.toBeNull());
        boundary.list = async () => ({ success: true, results: [], count: 0, bytes: 0,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } });
        await screen.pressByTestIdAsync('settings.sourceControl.savedWalkthroughs.retry');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('walkthroughSettings.savedCount', { count: 0, bytes: '0 B' })));
        await screen.update(view('offline'));
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.unavailableData'));
        await screen.unmount();
    });
    it('hides Clear only after the owning machine confirms an empty saved inventory', async () => {
        const empty = createDeferred<unknown>();
        const listed = { success: true, results: [{ cwd: '/repo', resultId: 'saved', revision: 1,
            comparisonId: 'comparison', source: { kind: 'workingTree' }, bytes: 12, updatedAtMs: 1 }], count: 1, bytes: 12,
            sevenDayCost: { status: 'unavailable', pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 0, untilMs: 1 } };
        boundary.list = async machineId => {
            if (machineId === 'empty') return empty.promise;
            if (machineId === 'populated') return listed;
            throw new Error('Owning machine offline');
        };
        const home = await addHome('Saved Settings');
        const { createScmDiffSummarySavedResultOperations } = await import('@/sync/ops/scmDiffSummary/savedResultOperations');
        expect(await createScmDiffSummarySavedResultOperations({ machineId: 'populated', serverId: home.id,
            accountId: 'saved-account', shouldContinue: () => true }).list()).toEqual(listed);
        const view = (machineId: string) => <WalkthroughSavedSettings machineId={machineId} serverId={home.id} machineName="Computer"
            machineAvailability="online"
            prepareAfterTurn={false} onPrepareAfterTurn={() => {}} modelAvailable={false} />;
        const screen = await renderSettingsView(view('empty'));
        const clear = () => screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear');
        // Nothing destructive is offered until the machine says there is something to clear.
        expect(clear()).toBeNull();
        await act(async () => { empty.resolve({ ...listed, results: [], count: 0, bytes: 0 }); });
        // Establish that the real binding and strict inventory parser settled before the visibility RED.
        await vi.waitFor(() => expect(screen.getTextContent())
            .toContain(t('walkthroughSettings.savedCount', { count: 0, bytes: '0 B' })));
        await vi.waitFor(() => expect(clear() === null).toBe(true));
        await screen.update(view('populated'));
        await vi.waitFor(() => expect(clear()?.props.disabled).toBe(false));
        await screen.update(view('offline'));
        await vi.waitFor(() => expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.retry')).not.toBeNull());
        expect(clear()).toBeNull();
        await screen.unmount();
    });

    it('names its machine prerequisite and offers no Clear while no machine is chosen', async () => {
        const screen = await renderSettingsView(<WalkthroughSavedSettings machineId={null} serverId={null} machineName=""
            machineAvailability="unselected" prepareAfterTurn={false} onPrepareAfterTurn={() => {}} modelAvailable />);
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.chooseMachine'));
        expect(screen.getTextContent()).not.toContain(t('settingsSourceControl.page.routing.chooseMachineDescription'));
        expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear')).toBeNull();
        await screen.unmount();
    });

    it('waits for a chosen machine by name instead of asking to choose one', async () => {
        const screen = await renderSettingsView(<WalkthroughSavedSettings machineId={null} serverId={null} machineName="Studio Mac"
            machineAvailability="missing" prepareAfterTurn={false} onPrepareAfterTurn={() => {}} modelAvailable />);
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.waitingMachine', { machine: 'Studio Mac' }));
        expect(screen.getTextContent()).not.toContain(t('walkthroughSettings.chooseMachine'));
        expect(screen.findHostByTestId('settings.sourceControl.savedWalkthroughs.clear')).toBeNull();
        await screen.unmount();
    });

    it('allows opting out with an unavailable model but refuses opting in', async () => {
        function Controlled() {
            const [enabled, setEnabled] = React.useState(true);
            return <WalkthroughSavedSettings machineId={null} serverId={null} machineName=""
                machineAvailability="unselected"
                prepareAfterTurn={enabled} onPrepareAfterTurn={setEnabled} modelAvailable={false} />;
        }
        const screen = await renderSettingsView(<Controlled />);
        // Without an eligible model the row still says what it does, then what it needs first.
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.prefetchDescription'));
        expect(screen.getTextContent()).toContain(t('walkthroughSettings.chooseModelFirst'));
        const toggle = () => screen.findAll(node => node.type === Switch)[0];
        expect(toggle().props.value).toBe(true);
        expect(toggle().props.disabled).toBe(false);
        await act(async () => { toggle().props.onValueChange(false); });
        expect(toggle().props.value).toBe(false);
        expect(toggle().props.disabled).toBe(true);
        await act(async () => { toggle().props.onValueChange(true); });
        expect(toggle().props.value).toBe(false);
        await screen.unmount();
    });
});
