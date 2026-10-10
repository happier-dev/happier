import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { ActionOperationSnapshotV1, ProjectWorkerStatusResultV1 } from '@happier-dev/protocol';
import { projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { consumeActionOperationSnapshotPush } from '@/sync/domains/actionOperations/consumeActionOperationSnapshotPush';
import { installNewSessionComponentsCommonModuleMocks } from '../newSessionComponentsTestHelpers';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), operation: vi.fn() }));
// Substitute Metro's deferred loader only; selection and the admitted Action remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
// The addressed daemon is the network boundary; Action policy and selection remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    return createServerScopedMachineRpcBoundaryMock(async params => params.method === ACTION_OPERATION_RPC_METHODS_V2.get
        ? await rpc.operation(params) : await rpc.machine(params));
});
installNewSessionComponentsCommonModuleMocks();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useMachineSelectionListModel } = await import('./useMachineSelectionListModel');
const { useMachineDestinationWorkerStatus } = await import('@/components/sessions/new/hooks/machines/useMachineDestinationWorkerStatus');
const { getActionOperation } = await import('@/sync/ops/actionOperations');
const { storage } = await import('@/sync/domains/state/storageStore');
const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
const { getServerProfileById, setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
let serverId = '';
let homeProfileId = '';

beforeEach(async () => {
    actionOperationStore.reset();
    await homes.reset();
    // Credential/network leaves must remain installed for this case's real binding lifetime.
    installHomeGovernanceBoundaries(homes);
    await loadSyncSingletonForTests();
    // Match the inventory owner harness: complete the actual Action dependency
    // graph after its boundaries are installed, before waiting on a rendered read.
    await import('@/sync/ops/actions/defaultActionExecutor');
    rpc.machine.mockReset();
    rpc.operation.mockReset();
    homeProfileId = await homes.addHome({ name: 'Worker picker', serverUrl: 'https://worker-picker.test', accountId: 'owner',
        accountEncryptionMode: 'plain', serverIdentityId: 'srv_worker_home' });
    await setServerProfileIdentityForUrl('https://worker-picker.test', 'srv_worker_home');
    serverId = resolveServerProfileScopeIdForIdentifier(homeProfileId);
    homes.answer(homeProfileId, '/v1/machines/managed/actions/list', { body: { machines: [] } });
    expect(await resolveServerCredentialAccountScope(homeProfileId)).toMatchObject({ kind: 'bound',
        scope: { serverId: resolveServerProfileScopeIdForIdentifier(homeProfileId), accountId: 'owner' } });
});
afterEach(async () => { actionOperationStore.reset(); await homes.reset(); });

describe('worker destination list demand', () => {
    it.each(['asleep', 'starting'] as const)('offers a retained finite %s target only through its current controller installation', async wake => {
        const guest = createMachineFixture({ id: 'guest', active: false, activeAt: 0 });
        const controller = createMachineFixture({ id: 'controller', installationId: 'installation', activeAt: Date.now() });
        const managed = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_worker_home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            allocation: 'bound', creationState: 'active', desired: wake === 'starting' ? 'start' : 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            ...(wake === 'starting' ? { submittedNativeEffect: { intent: 'start', intentRevision: 1, requestId: 'start',
                controller: { machineId: 'controller', installationId: 'installation' } } } : {}),
            observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained', daemon: 'disconnected' } });
        homes.answer(homeProfileId, '/v1/machines/managed/actions/list', { body: { machines: [managed] } });
        storage.setState({ machineListByServerId: { [serverId]: [controller, guest] } });
        const hook = await renderHook(() => useMachineSelectionListModel({
            purpose: 'finite', workerPlacement: { workspace: { serverId, refId: 'checkout' } },
            groups: [{ serverId, serverName: 'Worker picker', loading: false, signedOut: false,
                machines: [{ ...guest, serverId, serverName: 'Worker picker' }] }],
            selectedMachine: null, selectedServerId: serverId, recentMachines: [], favoriteMachines: [],
            onSelectMachine: () => {}, onSelectScopedMachine: () => {},
            showFavorites: false, showRecent: false, showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false,
        }));
        try {
            const option = () => hook.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
                .find(option => option.id.endsWith('guest'));
            await waitForHomeGovernance(() => expect(hook.getCurrent().managedWakeByServerId[serverId]?.guest).toBe(wake));
            expect(option()?.disabled).toBe(false);
            expect(rpc.machine).not.toHaveBeenCalled();
            await act(async () => storage.setState({ machineListByServerId: { [serverId]: [{ ...controller, installationId: 'replacement' }, guest] } }));
            expect(hook.getCurrent().managedWakeByServerId[serverId]?.guest).toBeUndefined();
            expect(option()?.disabled).toBe(true);
        } finally { await hook.unmount(); }
    });
    it('labels the stopped retained destination Asleep while keeping actual offline admission unchanged', async () => {
        const machine = createMachineFixture({ id: 'guest', active: false, activeAt: 0 });
        const managed = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_worker_home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained', daemon: 'disconnected' } });
        homes.answer(homeProfileId, '/v1/machines/managed/actions/list', { body: { machines: [managed] } });
        expect(getServerProfileById(serverId)).toMatchObject({ serverIdentityId: managed.homeId });
        const hook = await renderHook(() => useMachineSelectionListModel({
            groups: [{ serverId, serverName: 'Worker picker', loading: false, signedOut: false,
                machines: [{ ...machine, serverId, serverName: 'Worker picker' }] }],
            selectedMachine: null, selectedServerId: null, recentMachines: [], favoriteMachines: [],
            onSelectMachine: () => {}, onSelectScopedMachine: () => {},
            showFavorites: false, showRecent: false, showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false,
        }));
        await waitForHomeGovernance(() => expect({ requests: homes.requests,
            nativeRequests: homes.requestsFor('/v1/machines/managed/actions/list') }).toMatchObject({
                nativeRequests: expect.arrayContaining([expect.objectContaining({ input: { homeId: managed.homeId } })]),
            }));
        await flushHookEffects({ cycles: 20 });
        const option = hook.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id.endsWith('guest'));
        expect(option?.subtitle).toContain('managedPower.asleep');
        expect(option?.disabled).toBe(true);
        await hook.unmount();
    });
    it.each(['finite', 'service-start'] as const)('demands exact %s status and keeps a full queue selectable', async (purpose) => {
        const machine = createMachineFixture({ id: 'worker', active: true, activeAt: Date.now() });
        const worker = { eligible: true, candidate: { serverId, machineId: machine.id },
            load: { kind: 'known', running: 2, queued: 7, accepting: true, runAtMost: 2 }, explanation: 'eligible' };
        rpc.machine.mockResolvedValue(worker);
        const params = {
            purpose,
            workerPlacement: { workspace: { serverId, refId: 'checkout' } },
            groups: [{ serverId, serverName: 'Worker picker', loading: false, signedOut: false,
                machines: [{ ...machine, serverId, serverName: 'Worker picker' }] }],
            selectedMachine: null, selectedServerId: serverId, recentMachines: [], favoriteMachines: [],
            onSelectMachine: () => {}, onSelectScopedMachine: () => {},
            showFavorites: false, showRecent: false, showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false,
        };
        const hook = await renderHook(() => useMachineSelectionListModel(params));
        await vi.waitFor(() => expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            serverId, accountId: 'owner', machineId: 'worker', method: 'projects.worker.status',
            payload: { workspace: { serverId, refId: 'checkout' }, destination: { kind: 'machine', machineId: 'worker' }, purpose },
        })));
        await vi.waitFor(() => {
            const options = hook.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
            expect(options.find(option => option.id === 'worker')?.disabled).toBe(false);
        });
        await hook.unmount();
    });

    it('withdraws status from an older workspace demand, while eligible unknown load stays selectable', async () => {
        const machine = createMachineFixture({ id: 'worker', active: true, activeAt: Date.now() });
        let finishOld!: (status: unknown) => void;
        const unknown = { eligible: true, candidate: { serverId, machineId: machine.id },
            load: { kind: 'unknown' }, explanation: 'load_unknown' };
        rpc.machine.mockImplementationOnce(async () => await new Promise(resolve => { finishOld = resolve; }));
        rpc.machine.mockResolvedValue(unknown);
        const hook = await renderHook((refId: string) => useMachineSelectionListModel({
            purpose: 'finite', workerPlacement: { workspace: { serverId, refId } },
            groups: [{ serverId, serverName: 'Worker picker', loading: false, signedOut: false,
                machines: [{ ...machine, serverId, serverName: 'Worker picker' }] }],
            selectedMachine: null, selectedServerId: serverId, recentMachines: [], favoriteMachines: [],
            onSelectMachine: () => {}, onSelectScopedMachine: () => {},
            showFavorites: false, showRecent: false, showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false,
        }), { initialProps: 'old-checkout' });
        await vi.waitFor(() => expect(rpc.machine).toHaveBeenCalledTimes(1));
        await hook.rerender('new-checkout');
        await vi.waitFor(() => expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ workspace: { serverId, refId: 'new-checkout' } }),
        })));
        await act(async () => {
            finishOld({ eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'workspace_unavailable' });
        });
        await vi.waitFor(() => {
            const options = hook.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
            expect(options.find(option => option.id === 'worker')?.disabled).toBe(false);
        });
        await hook.unmount();
    });

    it('rechecks the same exact candidate after its admitted metadata version changes, not a wrapper-only render', async () => {
        const machine = createMachineFixture({ id: 'worker', active: true, activeAt: Date.now(), metadataVersion: 1 });
        rpc.machine.mockResolvedValueOnce({ eligible: true, candidate: { serverId, machineId: machine.id },
            load: { kind: 'unknown' }, explanation: 'load_unknown' });
        rpc.machine.mockResolvedValue({ eligible: false, candidate: null,
            load: { kind: 'known', running: 0, queued: 0, accepting: false, runAtMost: 2 }, explanation: 'not_accepting' });
        const hook = await renderHook((metadataVersion: number) => useMachineSelectionListModel({
            purpose: 'finite', workerPlacement: { workspace: { serverId, refId: 'checkout' } },
            groups: [{ serverId, serverName: 'Worker picker', loading: false, signedOut: false,
                machines: [{ ...machine, metadataVersion, serverId, serverName: 'Worker picker' }] }],
            selectedMachine: null, selectedServerId: serverId, recentMachines: [], favoriteMachines: [],
            onSelectMachine: () => {}, onSelectScopedMachine: () => {},
            showFavorites: false, showRecent: false, showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false,
        }), { initialProps: 1 });
        const selectable = () => hook.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id === 'worker')?.disabled === false;
        await vi.waitFor(() => expect(selectable()).toBe(true));
        await hook.rerender(1);
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        await hook.rerender(2);
        await vi.waitFor(() => expect(selectable()).toBe(false));
        expect(rpc.machine).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it('refreshes exact load on matching lifecycle and admission phase pushes, not unrelated scopes or label-only revisions', async () => {
        const machine = createMachineFixture({ id: 'worker', active: true, activeAt: Date.now(), metadataVersion: 1 });
        const snapshot = (operationId: string, accountId = 'owner', machineId = machine.id): ActionOperationSnapshotV1 => ({
            version: 1, operationId, revision: 1, actionId: 'projects.script.run', state: 'running',
            scope: { accountId, machineId }, title: 'Run script', createdAt: 1, startedAt: 2, cancellation: 'supported',
            progress: { kind: 'phase', phase: 'running', label: 'Running script' },
        });
        const queued: ActionOperationSnapshotV1 = {
            version: 1, operationId: 'queued-script', revision: 1, actionId: 'projects.script.run', state: 'accepted',
            scope: { accountId: 'owner', machineId: machine.id }, title: 'Run script', createdAt: 1, cancellation: 'supported',
            progress: { kind: 'phase', phase: 'queued', label: 'Queued — 0 ahead' },
        };
        const push = async (sourceServerId: string, operation: ActionOperationSnapshotV1) => {
            rpc.operation.mockResolvedValueOnce({ kind: 'found', operation });
            await consumeActionOperationSnapshotPush({
                update: { type: 'action-operation-updated', machineId: operation.scope.machineId,
                    content: { t: 'plain', v: projectActionOperationSnapshotForV1Reader(operation) } },
                accountId: operation.scope.accountId, accountEncryptionMode: 'plain', sourceServerId,
                // The addressed daemon RPC is the boundary; current-reader parsing, ingress and store stay real.
                readSnapshot: operationId => getActionOperation({ operationId, machineId: operation.scope.machineId,
                    serverId: sourceServerId, accountId: operation.scope.accountId, requireCurrentDomainFacts: true }),
            });
        };
        await push(serverId, snapshot('first-script'));
        await push(serverId, queued);
        let running = 1;
        let queuedCount = 1;
        rpc.machine.mockImplementation(async () => ({
            eligible: true, candidate: { serverId, machineId: machine.id },
            load: { kind: 'known', running, queued: queuedCount, accepting: true, runAtMost: 3 }, explanation: 'eligible',
        } satisfies ProjectWorkerStatusResultV1));
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useMachineDestinationWorkerStatus({
                purpose: 'finite', workerPlacement: { workspace: { serverId, refId: 'checkout' } },
                groups: [{ serverId, loading: false, signedOut: false, machines: [machine] }],
            });
        });
        const load = () => hook.getCurrent()(machine, serverId).worker?.load;
        await vi.waitFor(() => expect(load()).toEqual({ kind: 'known', running: 1, queued: 1, accepting: true, runAtMost: 3 }));
        const stableRenders = renders;
        await act(async () => {
            // Session creation has a real tracked operation, but owns no finite admission reservation.
            await push(serverId, { ...snapshot('session-create'), actionId: 'session.spawn_new', title: 'Create session',
                progress: { kind: 'phase', phase: 'creating', label: 'Creating session' } });
            await push('another-home', snapshot('foreign-home-script'));
            await push(serverId, snapshot('foreign-account-script', 'another-account'));
            await push(serverId, snapshot('foreign-machine-script', 'owner', 'another-machine'));
            await push(serverId, { ...snapshot('first-script'), revision: 2,
                progress: { kind: 'phase', phase: 'running', label: 'Running script output' } });
            await push(serverId, { ...queued, revision: 2,
                progress: { kind: 'phase', phase: 'queued', label: 'Queued — waiting for admission' } });
        });
        await vi.waitFor(() => expect(load()).toEqual({ kind: 'known', running: 1, queued: 1, accepting: true, runAtMost: 3 }));
        expect(rpc.machine).toHaveBeenCalledTimes(1);
        expect(renders).toBe(stableRenders);

        running = 2;
        queuedCount = 0;
        const preparing: ActionOperationSnapshotV1 = { ...queued, revision: 3,
            // Reservation counts as running before the operation's OS-launch state changes.
            progress: { kind: 'phase', phase: 'preparing', label: 'Preparing workspace' } };
        await act(async () => { await push(serverId, preparing); });
        await vi.waitFor(() => expect(load()).toEqual({ kind: 'known', running: 2, queued: 0, accepting: true, runAtMost: 3 }));
        expect(rpc.machine).toHaveBeenCalledTimes(2);
        const preparingRenders = renders;
        await act(async () => {
            await push(serverId, { ...preparing, revision: 4,
                progress: { kind: 'phase', phase: 'preparing', label: 'Preparing reviewed workspace' } });
        });
        expect(load()).toEqual({ kind: 'known', running: 2, queued: 0, accepting: true, runAtMost: 3 });
        expect(rpc.machine).toHaveBeenCalledTimes(2);
        expect(renders).toBe(preparingRenders);

        running = 3;
        await act(async () => { await push(serverId, snapshot('second-script')); });
        await vi.waitFor(() => expect(load()).toEqual({ kind: 'known', running: 3, queued: 0, accepting: true, runAtMost: 3 }));
        expect(rpc.machine).toHaveBeenLastCalledWith(expect.objectContaining({
            serverId, accountId: 'owner', machineId: machine.id,
            payload: { workspace: { serverId, refId: 'checkout' }, destination: { kind: 'machine', machineId: machine.id }, purpose: 'finite' },
        }));
        await hook.unmount();
    });
});
