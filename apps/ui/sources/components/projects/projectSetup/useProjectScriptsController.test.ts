import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance as waitForRequests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Authenticated remote daemon RPC is a genuine system boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc.machine }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Cold loading of the real Sync graph belongs to collection, not the behavior test's budget.
await loadSyncSingletonForTests();

function waitForHomeGovernance(assertion: () => void) {
    return waitForRequests(async () => { await flushHookEffects(); assertion(); });
}

function operation(serverId: string): ActionOperationProjection {
    return { serverId, observation: 'available', isUnavailableProjection: false,
        snapshot: { version: 1, operationId: 'operation-1', revision: 1, actionId: 'projects.prepare',
            state: 'running', scope: { accountId: 'alice', machineId: 'machine-1' },
            title: 'Setup', createdAt: 1, startedAt: 2, cancellation: 'supported' } };
}

describe('Project Scripts Setup controls', () => {
    beforeEach(async () => { await harness.reset(); actionOperationStore.reset(); rpc.machine.mockReset(); });
    afterEach(() => standardCleanup());

    it('exposes the same live Setup Stop and review opener to compact Scripts hosts', async () => {
        const { useProjectScriptsController } = await import('@/components/projects/projectSetup/useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const home = await harness.addHome({ name: 'Setup Home', serverUrl: 'https://setup-stop.test', accountId: 'alice' });
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        harness.answer(home, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'] } },
        } } } });
        const workspace = { serverId, workspaceId: 'setup-workspace', machineId: 'machine-1', rootPath: '/repo' };
        const setup = { ...operation(serverId).snapshot, actionId: 'projects.prepare', scope: { accountId: 'alice', machineId: 'machine-1' },
            domainRef: { kind: 'projectCommand' as const, purpose: 'setup' as const, serverId, machineId: 'machine-1',
                workspaceRefId: workspace.workspaceId, cwd: '/repo', sourceWorkspace: workspace },
        };
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [setup] });
        const homes = [serverId];
        const changed = () => {};
        const hook = await renderHook(() => useProjectScriptsController(workspace, changed,
            useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            expect(hook.getCurrent().setupOperation?.snapshot.operationId).toBe(setup.operationId);
            expect(hook.getCurrent().setupReviewOpen).toBe(false);
            act(() => hook.getCurrent().openSetupReview());
            expect(hook.getCurrent().setupReviewOpen).toBe(true);
            act(() => hook.getCurrent().dismissConsent());
            expect(hook.getCurrent().setupReviewOpen).toBe(false);
            expect(rpc.machine).not.toHaveBeenCalled();
            rpc.machine.mockResolvedValue({ kind: 'requested' });
            act(() => hook.getCurrent().setupStop.requestStop());
            await waitForHomeGovernance(() => expect(hook.getCurrent().setupStop.feedback).toBe('requested'));
            expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine-1',
                method: 'actionOperation.cancel.v1', payload: { operationId: setup.operationId } }));
            expect(hook.getCurrent().setupOperation?.snapshot.state).toBe('running');
            expect(hook.getCurrent().setupStop.stopRequested).toBe(true);
            act(() => hook.getCurrent().openSetupReview());
            await act(async () => { await harness.switchAccount(home, 'bob'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().accountId).toBe('bob'));
            expect(hook.getCurrent().setupOperation).toBeNull();
            expect(hook.getCurrent().setupReviewOpen).toBe(false);
            await act(async () => { await harness.switchAccount(home, 'alice'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().accountId).toBe('alice'));
            expect(hook.getCurrent().setupReviewOpen).toBe(false);
        } finally { await hook.unmount(); }
    });

});
