import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance as waitForRequests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createActionExecutor } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createDeferred } from '@/dev/testkit';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

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

    it.each(['one-off', 'preset', 'cancel', 'enrollment-pending'] as const)('keeps %s creation sessionless and continues only the current finite Run after actual enrollment', async mode => {
        const kind = mode === 'preset' ? 'preset' : 'one-off';
        const enrollmentGate = createDeferred<void>();
        const { useProjectScriptsController } = await import('./useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const home = await harness.addHome({ name: 'Finite Home', serverUrl: 'https://finite-create.test', serverIdentityId: 'srv_finite_home', accountId: 'alice' });
        const homeId = getServerProfileById(home)!.serverIdentityId!;
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        const workspace = { serverId, workspaceId: 'checkout', machineId: 'source', rootPath: '/repo' };
        const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Worker', choices: {} };
        const controller = { machineId: 'controller', installationId: 'installation' };
        const retention = { kind: 'until-delete' } as const;
        const draft = createManagedMachineSelectionDraft({ selection: kind === 'preset'
            ? { kind: 'preset', homeId, id: 'preset', revision: 1 }
            : { kind: 'one-off', homeId, launch, controller, retention, wakeOnAcceptedMessage: false },
            receipt: { launch, controller, optionStatus: 'current', prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention, wakeOnAcceptedMessage: false } });
        let machine: ManagedMachineV1 = { id: 'paid', homeId, custodianAccountId: 'alice', launch, controller,
            allocation: 'bound', resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1, retention, wakeOnAcceptedMessage: false };
        const admissions: unknown[] = [];
        const acquisitions: unknown[] = [];
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'machines.managed.acquire': ['ui'], 'projects.script.run': ['ui'],
        } });
        const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context, getActionSpec(id).safety),
            // Actual controller/Account and guest Action transports; all admission and continuation logic stays real.
            managedMachineAction: async request => {
                if (request.actionId === 'machines.managed.acquire') { acquisitions.push(request.input); return { managedId: 'paid', operation: { operationId: 'install' } }; }
                if (request.actionId === 'machines.managed.get') return machine;
                throw new Error('unexpected_managed_transport');
            },
            actionOperationAction: async () => {
                if (mode === 'cancel') await enrollmentGate.promise;
                if (mode !== 'enrollment-pending') machine = { ...machine, enrolledMachineId: 'actual-guest' };
                return { kind: 'found', operation: { version: 1, operationId: 'install', revision: 2, actionId: 'machines.managed.acquire', state: 'succeeded',
                    scope: { accountId: 'alice', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported' } };
            },
            projectAction: async request => {
                if (request.actionId !== 'projects.script.run') throw new Error('unexpected_project_transport');
                admissions.push(request.input);
                return { operation: { version: 1, operationId: 'finite', revision: 1, actionId: 'projects.script.run', state: 'accepted',
                    scope: { accountId: 'alice', machineId: 'actual-guest' }, title: 'Test', createdAt: 2, cancellation: 'supported' } };
            },
        })));
        const homes = [serverId];
        const changed = () => {};
        const hook = await renderHook(() => useProjectScriptsController(workspace, changed,
            useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null, { execute }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            expect(acquisitions).toEqual([]);
            expect(admissions).toEqual([]);
            if (mode === 'cancel') {
                let running: Promise<void> | undefined;
                act(() => { running = hook.getCurrent().run('test', { kind: 'named', name: 'test' }, undefined, draft); });
                await waitForHomeGovernance(() => expect(hook.getCurrent().managedCreation?.acquisition.managedId).toBe('paid'));
                act(() => hook.getCurrent().cancelRun());
                enrollmentGate.resolve();
                await act(async () => { await running; });
                expect(admissions).toEqual([]);
                expect(acquisitions).toHaveLength(1);
                expect(hook.getCurrent().managedCreation?.acquisition.managedId).toBe('paid');
                expect(hook.getCurrent().retainedOperation).toBeNull();
                return;
            }
            await act(async () => { await hook.getCurrent().run('test', { kind: 'named', name: 'test' }, undefined, draft); });
            if (mode === 'enrollment-pending') {
                expect(admissions).toEqual([]);
                expect(hook.getCurrent().managedCreation?.progress.kind).toBe('enrollment_pending');
                machine = { ...machine, enrolledMachineId: 'actual-guest' };
                act(() => publishHomeAccountChange(serverId));
                await waitForHomeGovernance(() => expect(admissions).toHaveLength(1));
            }
            expect(acquisitions).toHaveLength(1);
            expect(acquisitions[0]).not.toHaveProperty('agentStart');
            expect(hook.getCurrent().failure, JSON.stringify(hook.getCurrent().managedCreation)).toBeNull();
            expect(admissions).toEqual([{ workspace, selection: { kind: 'named', name: 'test' },
                choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'actual-guest' } } }]);
            await act(async () => { await hook.getCurrent().run('test', { kind: 'named', name: 'test' }, undefined, draft); });
            expect(acquisitions).toHaveLength(1);
            expect(admissions).toHaveLength(2);
        } finally { await hook.unmount(); }
    });

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
