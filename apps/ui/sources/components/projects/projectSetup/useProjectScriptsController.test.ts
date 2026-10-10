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

    it('admits independent Scripts while another Run awaits its Action result', async () => {
        const firstGate = createDeferred<void>();
        const { useProjectScriptsController } = await import('./useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const home = await harness.addHome({ name: 'Parallel Home', serverUrl: 'https://parallel-script.test', accountId: 'alice' });
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        const workspace = { serverId, workspaceId: 'checkout', machineId: 'source', rootPath: '/repo' };
        const admissions: string[] = [];
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'projects.script.run': ['ui'] } });
        const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context, getActionSpec(id).safety),
            projectAction: async request => {
                const name = request.input.selection?.kind === 'named' ? request.input.selection.name : '';
                admissions.push(name);
                if (name === 'first') await firstGate.promise;
                return { operation: { version: 1, operationId: `finite-${name}`, revision: 1, actionId: 'projects.script.run', state: 'accepted',
                    scope: { accountId: 'alice', machineId: 'source' }, title: name, createdAt: 2, cancellation: 'supported' } };
            },
        })));
        const homes = [serverId];
        const changed = () => {};
        const hook = await renderHook(() => useProjectScriptsController(workspace, changed,
            useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null, { execute }));
        let first: Promise<void> | undefined;
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            act(() => { first = hook.getCurrent().run('first', { kind: 'named', name: 'first' }); });
            await waitForHomeGovernance(() => expect(admissions).toEqual(['first']));
            await act(async () => { await hook.getCurrent().run('second', { kind: 'named', name: 'second' }); });
            expect(admissions).toEqual(['first', 'second']);
            // Completing B cannot clear A's row-local pending state.
            expect(hook.getCurrent().pendingKeys.first).toBe(true);
            expect(hook.getCurrent().pendingKeys.second).toBeUndefined();
        } finally {
            firstGate.resolve();
            await act(async () => { await first; });
            await hook.unmount();
        }
    });

    it('retains both acquired resources and cancels only the selected Script continuation', async () => {
        const { useProjectScriptsController } = await import('./useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const home = await harness.addHome({ name: 'Two Workers', serverUrl: 'https://two-workers.test', serverIdentityId: 'srv_two_workers', accountId: 'alice' });
        const homeId = getServerProfileById(home)!.serverIdentityId!;
        const serverId = resolveServerProfileScopeIdForIdentifier(home);
        const workspace = { serverId, workspaceId: 'checkout', machineId: 'source', rootPath: '/repo' };
        const controller = { machineId: 'controller', installationId: 'installation' };
        const retention = { kind: 'until-delete' } as const;
        const launch = (name: string) => ({ provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name, choices: {} });
        const draft = (name: string) => createManagedMachineSelectionDraft({
            selection: { kind: 'one-off', homeId, launch: launch(name), controller, retention, wakeOnAcceptedMessage: false },
            receipt: { launch: launch(name), controller, optionStatus: 'current', prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention, wakeOnAcceptedMessage: false },
        });
        let machines: ManagedMachineV1[] = ['first', 'second'].map(id => ({ id, homeId, custodianAccountId: 'alice', launch: launch(id), controller,
            allocation: 'bound', resource: { contributionRef: launch(id).provider, schemaVersion: 1, value: { id } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1, retention, wakeOnAcceptedMessage: false }));
        const purchases: string[] = [];
        const admissions: unknown[] = [];
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.managed.acquire': ['ui'], 'projects.script.run': ['ui'] } });
        const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context, getActionSpec(id).safety),
            managedMachineAction: async request => {
                if (request.actionId === 'machines.managed.list') return { machines };
                if (request.actionId === 'machines.managed.get') return machines.find(machine => machine.id === request.input.managedId);
                if (request.actionId === 'machines.managed.acquire') {
                    const id = request.input.selection.kind === 'one-off' ? request.input.selection.launch.name : '';
                    purchases.push(id);
                    return { managedId: id, operation: { operationId: `install-${id}` } };
                }
                throw new Error('unexpected_managed_transport');
            },
            actionOperationAction: async request => ({ kind: 'found', operation: {
                version: 1, operationId: request.input.operationId, revision: 2, actionId: 'machines.managed.acquire', state: 'succeeded',
                scope: { accountId: 'alice', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
            } }),
            projectAction: async request => {
                admissions.push(request.input);
                const name = request.input.selection?.kind === 'named' ? request.input.selection.name : '';
                return { operation: { version: 1, operationId: `finite-${name}`, revision: 1, actionId: 'projects.script.run', state: 'accepted',
                    scope: { accountId: 'alice', machineId: `guest-${name}` }, title: name, createdAt: 2, cancellation: 'supported' } };
            },
        })));
        const homes = [serverId];
        const changed = () => {};
        const hook = await renderHook(() => useProjectScriptsController(workspace, changed,
            useServerCredentialAccountScopeBindings(homes).get(serverId) ?? null, { execute }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
            await act(async () => { await hook.getCurrent().run('first', { kind: 'named', name: 'first' }, undefined, draft('first')); });
            await act(async () => { await hook.getCurrent().run('second', { kind: 'named', name: 'second' }, undefined, draft('second')); });
            expect(purchases).toEqual(['first', 'second']);
            expect(Object.keys(hook.getCurrent().managedCreations)).toEqual(['first', 'second']);
            act(() => hook.getCurrent().cancelRun('first'));
            machines = machines.map(machine => ({ ...machine, enrolledMachineId: `guest-${machine.id}` }));
            act(() => publishHomeAccountChange(serverId));
            await waitForHomeGovernance(() => expect(admissions).toHaveLength(1));
            expect(admissions[0]).toEqual({ workspace, selection: { kind: 'named', name: 'second' },
                choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'guest-second' } } });
            expect(hook.getCurrent().managedCreations.first?.progress).toMatchObject({ kind: 'failed', code: 'continuation_retired' });
            await act(async () => { await hook.getCurrent().resumeManagedRun('first'); });
            expect(purchases).toEqual(['first', 'second']);
            expect(admissions).toHaveLength(2);
            expect(admissions[1]).toEqual({ workspace, selection: { kind: 'named', name: 'first' },
                choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'guest-first' } } });
        } finally { await hook.unmount(); }
    });

    it.each(['one-off', 'preset', 'cancel', 'enrollment-pending', 'acquiring-pending', 'pending-cancel', 'pending-retire'] as const)('keeps %s creation sessionless and continues only the current finite Run after actual enrollment', async mode => {
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
                if (request.actionId === 'machines.managed.list') return { machines: [machine] };
                throw new Error('unexpected_managed_transport');
            },
            actionOperationAction: async () => {
                if (mode === 'cancel') await enrollmentGate.promise;
                const pending = mode === 'acquiring-pending' || mode === 'pending-cancel' || mode === 'pending-retire';
                if (mode !== 'enrollment-pending' && !pending) machine = { ...machine, enrolledMachineId: 'actual-guest' };
                return { kind: 'found', operation: { version: 1, operationId: 'install', revision: 2, actionId: 'machines.managed.acquire', state: 'succeeded',
                    scope: { accountId: 'alice', machineId: 'controller' }, title: 'Install', createdAt: 1, startedAt: 1,
                    ...(pending ? { state: 'running' as const } : { settledAt: 2 }), cancellation: 'supported' } };
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
                await waitForHomeGovernance(() => expect(hook.getCurrent().managedCreations.test?.acquisition.managedId).toBe('paid'));
                act(() => hook.getCurrent().cancelRun('test'));
                enrollmentGate.resolve();
                await act(async () => { await running; });
                expect(admissions).toEqual([]);
                expect(acquisitions).toHaveLength(1);
                expect(hook.getCurrent().managedCreations.test?.acquisition.managedId).toBe('paid');
                expect(hook.getCurrent().retainedOperation).toBeNull();
                return;
            }
            await act(async () => { await hook.getCurrent().run('test', { kind: 'named', name: 'test' }, undefined, draft); });
            if (mode === 'pending-cancel' || mode === 'pending-retire') {
                expect(admissions).toEqual([]);
                expect(hook.getCurrent().managedCreations.test?.progress.kind).toBe('acquiring');
                if (mode === 'pending-cancel') act(() => hook.getCurrent().cancelRun('test'));
                else await act(async () => { await harness.switchAccount(home, 'bob'); });
                machine = { ...machine, enrolledMachineId: 'actual-guest' };
                act(() => publishHomeAccountChange(serverId));
                await flushHookEffects();
                expect(admissions).toEqual([]);
                expect(acquisitions).toHaveLength(1);
                return;
            }
            if (mode === 'enrollment-pending' || mode === 'acquiring-pending') {
                expect(admissions).toEqual([]);
                expect(hook.getCurrent().managedCreations.test?.progress.kind).toBe(mode === 'enrollment-pending' ? 'enrollment_pending' : 'acquiring');
                machine = { ...machine, enrolledMachineId: 'actual-guest' };
                act(() => publishHomeAccountChange(serverId));
                await waitForHomeGovernance(() => expect(admissions).toHaveLength(1));
            }
            expect(acquisitions).toHaveLength(1);
            expect(acquisitions[0]).not.toHaveProperty('agentStart');
            expect(hook.getCurrent().failure, JSON.stringify(hook.getCurrent().managedCreations.test)).toBeNull();
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
