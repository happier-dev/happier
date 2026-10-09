import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const scopedAccount = createProviderSettingsAccountHarness();
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const navigation = createExpoRouterMock();
vi.doMock('expo-router', () => navigation.module);
const machineRpc = vi.fn(async () => ({ status: 'success', action: 'delete', deletedConnectionId: 'pc_a' }));
// Only Machine transport is replaced: Action admission, Artifact writes and Inbox execution stay real.
vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
await loadSyncSingletonForTests();
const { useProviderConnectionMutation } = await import('./useProviderConnectionMutation');
const { mutateProviderConnection } = await import('@/providers/actions/client');
const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
const { useActionApprovalContinuation } = await import('@/components/approvals/useActionApprovalContinuation');
const { useServerCredentialAccountScopeResolution } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');

beforeEach(async () => {
    standardCleanup(); await harness.reset(); installHomeGovernanceBoundaries(harness);
    machineRpc.mockClear(); navigation.spies.push.mockClear();
});
afterEach(standardCleanup);
describe('Provider mutation deferred approval', () => {
    it('never reads the original result Artifact through a replacement Account on the same Home', async () => {
        const serverId = await harness.addHome({ name: 'Provider captured Artifact', serverUrl: 'https://provider-captured-artifact.test', accountId: 'account-a' });
        await harness.requireUiApproval(serverId, 'providers.connections.delete');
        const onExecuted = () => {};
        const hook = await renderHook(() => ({
            follower: useActionApprovalContinuation({ scopeKey: 'provider-original-account', serverId, onExecuted }),
            resolution: useServerCredentialAccountScopeResolution(serverId),
        }));
        const caller = new AbortController();
        let execution: Promise<void> | undefined;
        let settlement: unknown = 'pending';
        try {
            await act(async () => {
                execution = mutateProviderConnection({ serverId,
                    request: { action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' },
                }, { scope: { serverId, accountId: 'account-a' }, signal: caller.signal,
                    onApprovalPending: hook.getCurrent().follower.requestApproval,
                }).then(value => { settlement = { value }; }, failure => { settlement = { failure }; });
            });
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
            const artifactId = harness.artifacts(serverId).list()[0]!.id;
            const path = `/v1/artifacts/${artifactId}`;
            await waitForHomeGovernance(() => expect(harness.requestsFor(path)).not.toHaveLength(0));
            const originalToken = harness.requestsFor(path)[0]!.token;
            expect(originalToken).toBeTruthy();
            expect(settlement).toBe('pending');
            // Account B does not own A's Artifact. Its server refuses it, but the original
            // mounted follower must not address that result through B's credential at all.
            harness.answer(serverId, path, { status: 404, body: { error: 'not_found' } });
            await act(async () => { await harness.switchAccount(serverId, 'account-b'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().resolution).toMatchObject({
                kind: 'bound', scope: { serverId, accountId: 'account-b' },
            }));
            await flushHookEffects();
            expect(harness.requestsFor(path).filter(request => request.token !== originalToken)).toEqual([]);
            expect(machineRpc).not.toHaveBeenCalled();
            expect(caller.signal.aborted).toBe(false);
        } finally {
            await act(async () => { caller.abort(); await execution; });
        }
    });
    it('follows each queued result-bearing approval on its captured Home when two Homes share one mounted registrar', async () => {
        const { serverId: homeA } = await scopedAccount.restore({ accountId: 'account-a' });
        const home = scopedAccount.home;
        const homeB = await scopedAccount.addHome({ name: 'Provider multi B', serverUrl: 'https://provider-multi-b.test', accountId: 'account-b', active: false });
        await home.requireUiApproval(homeB, 'providers.connections.delete');
        // The real Sync Home and both live Account scopes stay on A; B has its own
        // persisted policy and may not publish its Artifact into A's projection.
        await home.requireUiApproval(homeA, 'providers.connections.delete');
        const onExecuted = () => {};
        const hook = await renderHook(() => useActionApprovalContinuation({
            scopeKey: 'provider-two-captured-homes', serverId: homeA, onExecuted,
        }));
        const caller = new AbortController();
        const settlements = new Map<string, unknown>();
        const executions: Promise<void>[] = [];
        try {
            const request = async (serverId: string, accountId: string) => {
                await act(async () => {
                    executions.push(mutateProviderConnection({ serverId,
                        request: { action: 'delete', machineId: 'machine-shared', connectionId: 'pc_a' },
                    }, { scope: { serverId, accountId }, signal: caller.signal,
                        onApprovalPending: hook.getCurrent().requestApproval,
                    }).then(value => { settlements.set(serverId, { value }); }, failure => { settlements.set(serverId, { failure }); }));
                });
                await waitForHomeGovernance(() => expect(home.artifacts(serverId).list()).toHaveLength(1));
            };
            await request(homeA, 'account-a');
            const artifactA = home.artifacts(homeA).list()[0]!.id;
            await waitForHomeGovernance(() => expect(hook.getCurrent().approvalId).toBe(artifactA));
            await request(homeB, 'account-b');
            const artifactB = home.artifacts(homeB).list()[0]!.id;
            expect(machineRpc).not.toHaveBeenCalled();
            // The second result may settle durably before the first queue head.
            await expect(decideApprovalAsInbox(homeB, artifactB, 'approve')).resolves.toMatchObject({ ok: true });
            await expect(decideApprovalAsInbox(homeA, artifactA, 'approve')).resolves.toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(settlements.get(homeA)).toMatchObject({ value: { status: 'success', action: 'delete' } }));
            await waitForHomeGovernance(() => expect(home.requestsFor(`/v1/artifacts/${artifactB}`)).not.toHaveLength(0));
            // Assert the outward wrong-Home request before waiting for the result it cannot return.
            expect([...new Set(home.requestsFor(`/v1/artifacts/${artifactB}`).map(request => request.serverId))]).toEqual([homeB]);
            await waitForHomeGovernance(() => expect(settlements.size).toBe(2));
            expect(settlements.get(homeB)).toMatchObject({ value: { status: 'success', action: 'delete' } });
            expect(machineRpc).toHaveBeenCalledTimes(2);
        } finally {
            await act(async () => { caller.abort(); await Promise.all(executions); });
            await hook.unmount();
            await scopedAccount.reset();
        }
    });
    it('preserves an acknowledged direct mutation after the captured Account retires', async () => {
        const serverId = await harness.addHome({ name: 'Provider receipt', serverUrl: 'https://provider-receipt.test', accountId: 'account-a' });
        await harness.requireUiApproval(serverId, 'providers.connections.delete');
        const { storage } = await import('@/sync/domains/state/storage');
        const settings = {
            ...storage.getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: {}, approvalWaivedSurfaces: { 'providers.connections.delete': ['ui'] },
            }),
        };
        storage.setState({ settings });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        let releaseResponse: () => void = () => {};
        const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
        machineRpc.mockImplementationOnce(async () => {
            await responseGate;
            return { status: 'success', action: 'delete', deletedConnectionId: 'pc_a' };
        });
        const capturedAccount = new AbortController();
        const settled = mutateProviderConnection({ serverId,
            request: { action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' },
        }, { scope: { serverId, accountId: 'account-a' }, signal: capturedAccount.signal,
            onApprovalPending: () => { throw new Error('The Account waived approval for this direct mutation'); },
        }).then(value => ({ value }), failure => ({ failure }));
        await waitForHomeGovernance(() => expect(machineRpc).toHaveBeenCalledOnce());
        await harness.switchAccount(serverId, 'account-b');
        capturedAccount.abort();
        releaseResponse();
        await expect(settled).resolves.toMatchObject({ value: { status: 'success', action: 'delete', deletedConnectionId: 'pc_a' } });
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(machineRpc).toHaveBeenCalledOnce();
    });

    it('opens the existing approval route and consumes its typed terminal result without replaying the mutation', async () => {
        const serverId = await harness.addHome({ name: 'Provider approvals', serverUrl: 'https://provider-approval.test', accountId: 'account-a' });
        await harness.requireUiApproval(serverId, 'providers.connections.delete');
        const refresh = vi.fn(async () => {});
        const resolveTarget = () => ({ serverId, machineId: 'machine-a' });
        const hook = await renderHook(() => useProviderConnectionMutation({ resolveTarget, refresh }));
        let execution: ReturnType<ReturnType<typeof useProviderConnectionMutation>['run']> | undefined;
        await act(async () => {
            execution = hook.getCurrent().run({ action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' });
        });
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        const artifactId = harness.artifacts(serverId).list()[0]!.id;
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(true);
        expect(machineRpc).not.toHaveBeenCalled();
        expect(navigation.spies.push).toHaveBeenCalledWith(`/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(serverId)}`);
        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        await act(async () => { await expect(execution).resolves.toMatchObject({ status: 'success', action: 'delete' }); });
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().isPending('delete:pc_a')).toBe(false);
        expect(machineRpc).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('ends pending local interest on Account retirement even when the explicit caller signal stays live', async () => {
        const serverId = await harness.addHome({ name: 'Provider load approval', serverUrl: 'https://provider-load-approval.test', accountId: 'account-a' });
        await harness.requireUiApproval(serverId, 'providers.models.load');
        const hook = await renderHook(() => useProviderActionClient(serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        const caller = new AbortController();
        let settlement: unknown = 'pending';
        let execution: Promise<void> | undefined;
        try {
            await act(async () => {
                execution = hook.getCurrent().loadProviderModel({ serverId, machineId: 'machine-a', connectionId: 'pc_a',
                    modelId: 'model-a', signal: caller.signal,
                }).then(value => { settlement = { value }; }, failure => { settlement = { failure }; });
            });
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
            expect(settlement).toBe('pending');
            await act(async () => { await harness.switchAccount(serverId, 'account-b'); });
            await flushHookEffects();
            expect(settlement).toMatchObject({ failure: { code: 'action_account_scope_changed' } });
            expect(caller.signal.aborted).toBe(false);
            expect(machineRpc).not.toHaveBeenCalled();
        } finally {
            // Dispose the test's explicit interest even when the missing lifetime merge fails.
            await act(async () => { caller.abort(); await execution; });
        }
    });
});
