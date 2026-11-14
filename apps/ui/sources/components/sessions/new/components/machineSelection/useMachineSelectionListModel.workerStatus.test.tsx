import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';
import type { BuildMachineSelectionListModelParams } from './useMachineSelectionListModel';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { ActionOperationSnapshotV1} from '@happier-dev/protocol/actions/operations/v1';
import type { ProjectWorkerStatusResultV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { linkMachineActivity } from '@/sync/domains/machines/machineActivity';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { consumeActionOperationSnapshotPush } from '@/sync/domains/actionOperations/consumeActionOperationSnapshotPush';
import { installNewSessionComponentsCommonModuleMocks } from '../newSessionComponentsTestHelpers';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), operation: vi.fn() }));
const modal = vi.hoisted(() => ({ show: vi.fn<import('@/modal').IModal['show']>(() => 'copy-modal') }));
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
installNewSessionComponentsCommonModuleMocks({ modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: modal.show } }).module,
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { PlanOptionRow } = await import('@/components/ui/selectionList/SelectionListOptionRow');
const { useMachineSelectionListModel } = await import('./useMachineSelectionListModel');
const { useMachineDestinationWorkerStatus } = await import('@/components/sessions/new/hooks/machines/useMachineDestinationWorkerStatus');
const { getActionOperation } = await import('@/sync/ops/actionOperations');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } = await import('@/sync/domains/machines/reachability/machineReachability');
const { storage } = await import('@/sync/domains/state/storageStore');
const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
const { getServerProfileById, setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
let serverId = '';
let homeProfileId = '';

async function seedAnsweredMachines(machines: Machine[]) {
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, machines);
    for (const machine of machines) {
        const admitted = storage.getState().machineRecordsByServerId[serverId]?.[machine.id];
        if (!admitted) throw new Error('expected an admitted Machine fixture');
        linkMachineActivity(admitted, machine);
    }
}

async function seedAnsweredScopedMachine(machine: Machine) {
    await seedAnsweredMachines([machine]);
    const row = { ...machine, serverId, serverName: 'Worker picker' };
    linkMachineActivity(machine, row);
    return row;
}

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
    modal.show.mockClear();
    homeProfileId = await homes.addHome({ name: 'Worker picker', serverUrl: 'https://worker-picker.test', accountId: 'owner',
        accountEncryptionMode: 'plain', serverIdentityId: 'srv_worker_home' });
    await setServerProfileIdentityForUrl('https://worker-picker.test', 'srv_worker_home');
    serverId = resolveServerProfileScopeIdForIdentifier(homeProfileId);
    storage.setState((state) => ({
        ...state,
        machines: {},
        machineDisplayById: {},
        machineListByServerId: {},
        machineListStatusByServerId: {},
        machineRecordsByServerId: {},
        machinePresenceById: {},
        machinePresenceByServerId: {},
    }));
    homes.answer(homeProfileId, '/v1/machines/managed/actions/list', { body: { machines: [] } });
    expect(await resolveServerCredentialAccountScope(homeProfileId)).toMatchObject({ kind: 'bound',
        scope: { serverId: resolveServerProfileScopeIdForIdentifier(homeProfileId), accountId: 'owner' } });
});
afterEach(async () => { actionOperationStore.reset(); await homes.reset(); });

describe('worker destination list demand', () => {
    it('does zero worker-row inventory work for unrelated operation and relationship pushes at scale', async () => {
        const scope = { serverId, accountId: 'owner' };
        const machine = createMachineFixture({ id: 'demanded-worker', active: true, activeAt: Date.now() });
        await seedAnsweredMachines([machine]);
        const source = { id: 'checkout', serverId, machineId: 'source', rootPath: '/source', createdAtMs: 1 };
        const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const refs = Array.from({ length: 300 }, (_, index) => ({ ...source, id: `copy-${index}`, machineId: index === 299 ? machine.id : `other-${index}` }));
        const relationships: WorkspaceSyncRelationshipV1[] = refs.map((target, index) => ({ v: 1,
            relationshipId: `relationship-${index}`, controllerMachineId: source.machineId,
            alphaWorkspaceRefId: source.id, betaWorkspaceRefId: target.id, mode: 'keep_synced', enabled: true,
            contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1,
            provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: index === 299 ? 'other-source' : source.id, targetWorkspaceRefId: target.id } }));
        const operations: ActionOperationSnapshotV1[] = Array.from({ length: 400 }, (_, index) => ({
            version: 1, operationId: `operation-${index}`, revision: 1, actionId: 'projects.script.run', state: 'running',
            scope: { accountId: index === 399 ? 'other-account' : scope.accountId, machineId: index === 399 ? machine.id : `other-${index}` },
            title: 'Run', createdAt: 1, cancellation: 'supported',
        }));
        storage.getState().activateProfileScope(scope);
        storage.getState().activateProjectAccountRowsScope(scope);
        const publishRelationships = (rows: readonly WorkspaceSyncRelationshipV1[]) => storage.getState().applyProjectAccountRowsForScope(scope,
            { scope, status: 'ready', coverage: 'complete', workspaceRefs: [source, ...refs], relationships: rows,
                organizations: [], revisionsByPhysicalKey: {} });
        publishRelationships(relationships);
        actionOperationStore.mergeSnapshots({ serverId, snapshots: operations });
        rpc.machine.mockResolvedValue({ eligible: true, candidate: { serverId, machineId: machine.id },
            load: { kind: 'unknown' }, explanation: 'load_unknown' } satisfies ProjectWorkerStatusResultV1);
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useMachineDestinationWorkerStatus({ purpose: 'finite', workerPlacement: { workspace: { serverId, refId: source.id } },
                groups: [{ serverId, loading: false, signedOut: false, machines: [machine] }] });
        });
        const counts = { operationRecomputations: 0, operationEntries: 0, relationshipRecomputations: 0, relationshipEntries: 0 };
        // Instrument real published inventories. Producer reconciliation uses keyed map/every operations;
        // the row's whole-inventory queries use these iterators. No internal behavior is substituted.
        const originalValues = Map.prototype.values;
        const operationWalk = vi.spyOn(Map.prototype, 'values').mockImplementation(function (this: Map<unknown, unknown>) {
            const demanded = this === actionOperationStore.getSnapshot().operationsByKey;
            if (demanded) counts.operationRecomputations++;
            const iterator = originalValues.call(this);
            const next = iterator.next.bind(iterator);
            iterator.next = () => {
                const result = next();
                if (demanded && !result.done) counts.operationEntries++;
                return result;
            };
            return iterator;
        });
        const originalIterator = Array.prototype[Symbol.iterator];
        const relationshipWalk = vi.spyOn(Array.prototype, Symbol.iterator).mockImplementation(function (this: unknown[]) {
            const demanded = this === storage.getState().projectAccountRows?.relationships;
            if (demanded) counts.relationshipRecomputations++;
            const iterator = originalIterator.call(this);
            const next = iterator.next.bind(iterator);
            iterator.next = () => {
                const result = next();
                if (demanded && !result.done) counts.relationshipEntries++;
                return result;
            };
            return iterator;
        });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent()(machine, serverId).worker?.eligible).toBe(true));
            Object.assign(counts, { operationRecomputations: 0, operationEntries: 0, relationshipRecomputations: 0, relationshipEntries: 0 });
            const settledRenders = renders;
            rpc.machine.mockClear();
            for (let index = 0; index < 20; index++) {
                await act(async () => actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...operations[index === 0 ? 399 : index]!, revision: 2, state: 'succeeded', settledAt: 2 }] }));
                await act(async () => publishRelationships(relationships.map((row, item) => item === (index === 0 ? 299 : index) ? { ...row, updatedAtMs: 2 } : row)));
            }
            console.info('WORKER-STATUS-PERF unrelated', JSON.stringify({ ...counts, renders: renders - settledRenders, statusReads: rpc.machine.mock.calls.length }));
            expect({ ...counts, renders: renders - settledRenders, statusReads: rpc.machine.mock.calls.length }).toEqual({
                operationRecomputations: 0, operationEntries: 0, relationshipRecomputations: 0, relationshipEntries: 0, renders: 0, statusReads: 0,
            });
            await act(async () => actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...operations[0]!, operationId: 'matching', scope: { ...scope, machineId: machine.id } }] }));
            await waitForHomeGovernance(() => expect(rpc.machine).toHaveBeenCalledOnce());
            console.info('WORKER-STATUS-PERF matching operation', JSON.stringify({ statusRecomputations: rpc.machine.mock.calls.length }));
            rpc.machine.mockClear();
            const matchingTarget = { ...refs[0]!, machineId: machine.id };
            await act(async () => storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
                workspaceRefs: [source, matchingTarget, ...refs.slice(1)], relationships, organizations: [], revisionsByPhysicalKey: {} }));
            await waitForHomeGovernance(() => expect(rpc.machine).toHaveBeenCalledOnce());
            console.info('WORKER-STATUS-PERF matching relationship', JSON.stringify({ statusRecomputations: rpc.machine.mock.calls.length }));
        } finally {
            operationWalk.mockRestore();
            relationshipWalk.mockRestore();
            await hook.unmount();
        }
    });
    it('refreshes a missing-copy worker from the pushed copy relationship without polling or unrelated rereads', async () => {
        const machine = createMachineFixture({ id: 'fresh-worker', active: true, activeAt: Date.now() });
        await seedAnsweredMachines([machine]);
        const scope = { serverId, accountId: 'owner' };
        const source = { id: 'checkout', serverId, machineId: 'source', rootPath: '/source', createdAtMs: 1 };
        const target = { id: 'copy', serverId, machineId: machine.id, rootPath: '/worker', createdAtMs: 1 };
        const contentPolicy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const relationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'worker-copy', controllerMachineId: 'source',
            alphaWorkspaceRefId: source.id, betaWorkspaceRefId: target.id, mode: 'keep_synced', enabled: true,
            contentPolicy: { ...contentPolicy, policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicy) },
            createdAtMs: 1, updatedAtMs: 1, committedAtMs: 1,
            provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: source.id, targetWorkspaceRefId: target.id } };
        const publish = async (relationships: WorkspaceSyncRelationshipV1[]) => act(async () => {
            storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
                workspaceRefs: [source, target], relationships, organizations: [], revisionsByPhysicalKey: {} });
        });
        storage.getState().activateProfileScope(scope);
        storage.getState().activateProjectAccountRowsScope(scope);
        await publish([]);
        let copied = false;
        rpc.machine.mockImplementation(async () => copied
            ? { eligible: true, candidate: { serverId, machineId: machine.id }, load: { kind: 'unknown' }, explanation: 'load_unknown' }
            : { eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'worker_copy_missing',
                workerCopy: { serverId, sourceWorkspaceRefId: source.id, sourceMachineId: source.machineId, targetMachineId: machine.id } });
        const hook = await renderHook(() => useMachineDestinationWorkerStatus({ purpose: 'finite',
            workerPlacement: { workspace: { serverId, refId: source.id } },
            groups: [{ serverId, loading: false, signedOut: false, machines: [machine] }] }));
        const status = () => hook.getCurrent()(machine, serverId).worker;
        try {
            await waitForHomeGovernance(() => expect(status()).toMatchObject({ eligible: false, explanation: 'worker_copy_missing' }));
            rpc.machine.mockClear();
            await publish([{ ...relationship, provenance: undefined }]);
            await flushHookEffects({ cycles: 5 });
            expect(rpc.machine).not.toHaveBeenCalled();
            copied = true;
            await publish([relationship]);
            await waitForHomeGovernance(() => expect(status()?.eligible).toBe(true));
            expect(rpc.machine).toHaveBeenCalledOnce();
        } finally { await hook.unmount(); }
    });
    it.each([{ testID: 'run-picker', otherHome: false }, { testID: 'workers-picker', otherHome: true }])(
        '$testID keeps a missing-copy worker disabled and opens its existing copy step once', async ({ testID, otherHome }) => {
        const machine = createMachineFixture({ id: 'fresh-worker', active: true, activeAt: Date.now() });
        await seedAnsweredMachines([machine]);
        const workspace = { serverId, workspaceId: 'checkout', machineId: 'source', rootPath: '/source' };
        const onChoose = vi.fn();
        rpc.machine.mockResolvedValue({ eligible: false, candidate: null, load: { kind: 'unknown' },
            explanation: 'worker_copy_missing', workerCopy: { serverId, sourceWorkspaceRefId: workspace.workspaceId,
                sourceMachineId: workspace.machineId, targetMachineId: machine.id } } satisfies ProjectWorkerStatusResultV1);
        const hook = await renderHook(() => useMachineSelectionListModel<Machine>({
            purpose: 'finite', workerPlacement: { workspace: { serverId, refId: workspace.workspaceId } },
            groups: [{ serverId, serverName: 'Worker picker', loading: false, signedOut: false,
                machines: [{ ...machine, serverId, serverName: 'Worker picker' }] },
                ...(otherHome ? [{ serverId: 'unrelated-home', serverName: 'Other Home', loading: false, signedOut: true, machines: [] }] : [])],
            selectedMachine: null, selectedServerId: serverId, recentMachines: [], favoriteMachines: [],
            onSelectMachine: onChoose, onSelectScopedMachine: onChoose,
            showFavorites: false, showRecent: false, showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false,
            testIdPrefix: testID,
        }));
        const row = () => hook.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id === (otherHome ? `${serverId}::${machine.id}` : machine.id))!;
        try {
            await waitForHomeGovernance(() => expect(row().subtitle).toContain('projectWorkers.copyMissingFact'));
            expect(row().disabled).toBe(true);
            const screen = await renderScreen(<PlanOptionRow option={row()} rootTestID={testID} stepId="root"
                isSelected={false} isFocused={false} onSelect={onChoose} onPushStep={() => {}} />);
            try {
                await screen.pressByTestIdAsync(`${testID}-option:${machine.id}.setUpCopy`);
                await vi.waitFor(() => expect(modal.show).toHaveBeenCalledOnce());
                expect(modal.show.mock.calls[0]?.[0].props).toMatchObject({
                    source: { id: workspace.workspaceId, serverId, machineId: workspace.machineId },
                    options: { targetMachineId: machine.id, purpose: 'worker_clean_copy' },
                });
                expect(onChoose).not.toHaveBeenCalled();
            } finally { await screen.unmount(); }
        } finally { await hook.unmount(); }
    });
    it('keeps worker demand local to qualified candidates and retains unaffected statuses across one candidate recovery', async () => {
        const machines = Array.from({ length: 100 }, (_, index) => createMachineFixture({
            id: `worker-${index}`, active: true, activeAt: Date.now(), metadataVersion: 1,
        }));
        await seedAnsweredMachines(machines);
        rpc.machine.mockImplementation(async ({ machineId }: { machineId: string }) => ({
            eligible: true, candidate: { serverId, machineId },
            load: { kind: 'known', running: 1, queued: 0, accepting: true, runAtMost: 2 }, explanation: 'eligible',
        } satisfies ProjectWorkerStatusResultV1));
        let renders = 0;
        const hook = await renderHook(() => {
            renders++;
            return useMachineDestinationWorkerStatus({
                purpose: 'finite', workerPlacement: { workspace: { serverId, refId: 'checkout' } },
                groups: [{ serverId, loading: false, signedOut: false, machines }],
            });
        });
        const status = (index: number) => hook.getCurrent()(machines[index]!, serverId).worker;
        try {
            await waitForHomeGovernance(() => expect(machines.every((_, index) => status(index)?.eligible)).toBe(true));
            expect(rpc.machine).toHaveBeenCalledTimes(100);
            const stableStatus = status(1);
            const settledRenders = renders;
            rpc.machine.mockClear();
            await act(async () => {
                recordMachineRequestFailed({ serverId: 'another-home', accountId: 'owner', machineId: machines[0]!.id });
                recordMachineRequestFailed({ serverId, accountId: 'another-account', machineId: machines[0]!.id });
                recordMachineRequestFailed({ serverId, accountId: 'owner', machineId: 'outside-candidates' });
            });
            await flushHookEffects({ cycles: 20 });
            await waitForHomeGovernance(() => expect(status(1)?.eligible).toBe(true));
            expect(rpc.machine).toHaveBeenCalledTimes(0);
            expect(renders).toBe(settledRenders);
            expect(status(1)).toBe(stableStatus);

            await act(async () => recordMachineRequestFailed({ serverId, accountId: 'owner', machineId: machines[0]!.id }));
            expect(status(0)).toBeUndefined();
            expect(status(1)).toBe(stableStatus);
            expect(rpc.machine).toHaveBeenCalledTimes(0);

            await act(async () => recordMachineRequestSucceeded({ serverId, accountId: 'owner', machineId: machines[0]!.id }));
            await waitForHomeGovernance(() => expect(status(0)?.eligible).toBe(true));
            expect(rpc.machine).toHaveBeenCalledTimes(1);
            expect(status(1)).toBe(stableStatus);
        } finally { await hook.unmount(); clearMachineRequestReachabilityForTest(); }
    });
    it('retains another candidate in flight and refreshes only the changed candidate on metadata and lifecycle facts', async () => {
        const machines = ['worker-a', 'worker-b'].map(id => createMachineFixture({ id, active: true,
            activeAt: Date.now(), metadataVersion: 1 }));
        await seedAnsweredMachines(machines);
        const status = (machineId: string, running: number): ProjectWorkerStatusResultV1 => ({
            eligible: true, candidate: { serverId, machineId },
            load: { kind: 'known', running, queued: 0, accepting: true, runAtMost: 3 }, explanation: 'eligible',
        });
        const old = createDeferred<ProjectWorkerStatusResultV1>();
        const other = createDeferred<ProjectWorkerStatusResultV1>();
        const current = createDeferred<ProjectWorkerStatusResultV1>();
        const reads = new Map([['worker-a', [old, current]], ['worker-b', [other]]]);
        rpc.machine.mockImplementation(async ({ machineId }: { machineId: string }) =>
            await (reads.get(machineId)?.shift()?.promise ?? Promise.resolve(status(machineId, 3))));
        const hook = await renderHook((metadataVersion: number) => useMachineDestinationWorkerStatus({
            purpose: 'finite', workerPlacement: { workspace: { serverId, refId: 'checkout' } },
            groups: [{ serverId, loading: false, signedOut: false,
                machines: [{ ...machines[0]!, metadataVersion }, machines[1]!] }],
        }), { initialProps: 1 });
        const worker = (index: number) => hook.getCurrent()(machines[index]!, serverId).worker;
        try {
            await waitForHomeGovernance(() => expect(rpc.machine).toHaveBeenCalledTimes(2));
            await hook.rerender(2);
            await waitForHomeGovernance(() => expect(rpc.machine).toHaveBeenCalledTimes(3));
            await act(async () => {
                old.resolve(status('worker-a', 0));
                other.resolve(status('worker-b', 1));
            });
            await waitForHomeGovernance(() => expect(worker(1)?.load).toMatchObject({ running: 1 }));
            expect(worker(0)).toBeUndefined();
            await act(async () => { current.resolve(status('worker-a', 2)); });
            await waitForHomeGovernance(() => expect(worker(0)?.load).toMatchObject({ running: 2 }));
            const retained = worker(1);
            const operation: ActionOperationSnapshotV1 = {
                version: 1, operationId: 'worker-a-run', revision: 1, actionId: 'projects.script.run', state: 'running',
                scope: { accountId: 'owner', machineId: 'worker-a' }, title: 'Run script', createdAt: 1,
                startedAt: 2, cancellation: 'supported', progress: { kind: 'phase', phase: 'running', label: 'Running' },
            };
            rpc.operation.mockResolvedValueOnce({ kind: 'found', operation });
            await act(async () => {
                await consumeActionOperationSnapshotPush({
                    update: { type: 'action-operation-updated', machineId: 'worker-a',
                        content: { t: 'plain', v: projectActionOperationSnapshotForV1Reader(operation) } },
                    accountId: 'owner', accountEncryptionMode: 'plain', sourceServerId: serverId,
                    readSnapshot: operationId => getActionOperation({ operationId, machineId: 'worker-a', serverId,
                        accountId: 'owner', requireCurrentDomainFacts: true }),
                });
            });
            await waitForHomeGovernance(() => expect(worker(0)?.load).toMatchObject({ running: 3 }));
            expect(rpc.machine).toHaveBeenCalledTimes(4);
            expect(worker(1)).toBe(retained);
        } finally { await hook.unmount(); }
    });
    it.each([
        { wake: 'asleep', hasController: true },
        { wake: 'starting', hasController: true },
        { wake: 'asleep', hasController: false },
    ] as const)('offers a retained finite $wake target only through its current controller installation ($hasController)', async ({ wake, hasController }) => {
        const guest = createMachineFixture({ id: 'guest', active: false, activeAt: 0 });
        const controller = createMachineFixture({ id: 'controller', installationId: 'installation', activeAt: Date.now() });
        const managed = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_worker_home', custodianAccountId: 'owner',
            launch: { provider: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.native', localId: 'vm' }, schemaVersion: 1, value: {} },
            ...(hasController ? { controller: { machineId: 'controller', installationId: 'installation' } } : {}), enrolledMachineId: 'guest',
            allocation: 'bound', creationState: 'active', desired: wake === 'starting' ? 'start' : 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true,
            ...(wake === 'starting' ? { submittedNativeEffect: { intent: 'start', intentRevision: 1, requestId: 'start',
                controller: { machineId: 'controller', installationId: 'installation' } } } : {}),
            observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained' } });
        homes.answer(homeProfileId, '/v1/machines/managed/actions/list', { body: { machines: [managed] } });
        await seedAnsweredMachines([controller, guest]);
        const hook = await renderHook(() => useMachineSelectionListModel<Machine>({
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
            if (!hasController) {
                await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/machines/managed/actions/list')).not.toHaveLength(0));
                await flushHookEffects();
                expect(hook.getCurrent().managedWakeByServerId[serverId]?.guest).toBeUndefined();
                expect(option()?.disabled).toBe(true);
                expect(rpc.machine).not.toHaveBeenCalled();
                return;
            }
            await waitForHomeGovernance(() => expect(hook.getCurrent().managedWakeByServerId[serverId]?.guest).toBe(wake));
            expect(option()?.disabled).toBe(false);
            expect(rpc.machine).not.toHaveBeenCalled();
            await act(async () => publishMachineInventoryForTest({ serverId, accountId: 'owner' },
                [{ ...controller, installationId: 'replacement' }, guest]));
            expect(hook.getCurrent().managedWakeByServerId[serverId]?.guest).toBeUndefined();
            expect(option()?.disabled).toBe(true);
        } finally { await hook.unmount(); }
    });
    it.each([
        { name: 'supported', online: false, wakeOnAcceptedMessage: true, newSessionWake: { kind: 'available' }, selectable: true },
        { name: 'owner disabled', online: false, wakeOnAcceptedMessage: false, newSessionWake: { kind: 'available' }, selectable: false },
        { name: 'no controller', online: false, wakeOnAcceptedMessage: true, newSessionWake: { kind: 'unavailable', reason: 'no_controller' }, selectable: false },
        { name: 'unknown support', online: false, wakeOnAcceptedMessage: true, newSessionWake: undefined, selectable: false },
        { name: 'online without controller', online: true, wakeOnAcceptedMessage: true, newSessionWake: { kind: 'unavailable', reason: 'no_controller' }, selectable: true },
    ] as const)('admits an asleep shared Session target only when start-on-send is enabled and supported ($name)', async ({ online, wakeOnAcceptedMessage, newSessionWake, selectable }) => {
        // This is the public guest projection; B has Use only and cannot read native custody.
        const machine = { ...createMachineFixture({ id: 'guest', active: online, activeAt: online ? Date.now() : 0, isShared: true,
            managedMachineRef: { homeId: 'srv_worker_home', managedId: 'managed' },
            access: { role: 'use', resourceMode: 'plain', accessState: 'ready', custodian: { accountId: 'owner', displayName: 'Owner' } } }),
            managedInputRuntime: { nativeReady: false, wakeState: wakeOnAcceptedMessage ? 'asleep' as const : null, state: 'asleep' as const, newSessionWake } };
        await seedAnsweredMachines([machine]);
        const hook = await renderHook(() => useMachineSelectionListModel<Machine>({
            groups: [{ serverId, serverName: 'Worker picker', loading: false, signedOut: false,
                machines: [{ ...machine, serverId, serverName: 'Worker picker' }] }],
            selectedMachine: null, selectedServerId: null, recentMachines: [], favoriteMachines: [],
            onSelectMachine: () => {}, onSelectScopedMachine: () => {},
            showFavorites: false, showRecent: false, showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false,
        }));
        await flushHookEffects({ cycles: 20 });
        const option = hook.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(option => option.id.endsWith('guest'));
        expect(option?.disabled).toBe(!selectable);
        if (selectable && !online) {
            expect(hook.getCurrent().managedWakeByServerId[serverId]?.guest).toBe('asleep');
            expect(option?.subtitle).toContain('managedPower.asleep');
            expect(option?.subtitle).toContain('managedWake.startsOnSend');
        } else if (online) {
            expect(option?.subtitle).not.toContain('managedWake.startsOnSend');
        } else if (newSessionWake?.kind === 'unavailable') {
            expect(option?.subtitle).toContain('managedWake.startBeforeSend');
        } else if (wakeOnAcceptedMessage) {
            expect(option?.subtitle).toContain('common.unavailable');
        }
        await hook.unmount();
    });
    describe('offline-only classification', () => {
        const paramsFor = (machines: Machine[]): BuildMachineSelectionListModelParams => ({
            purpose: 'finite' as const, workerPlacement: { workspace: { serverId, refId: 'checkout' } },
            groups: [{ serverId, serverName: 'Worker picker', loading: false, signedOut: false,
                machines: machines.map(machine => ({ ...machine, serverId, serverName: 'Worker picker' })) }],
            selectedMachine: null, selectedServerId: serverId, recentMachines: [], favoriteMachines: [],
            onSelectMachine: () => {}, onSelectScopedMachine: () => {},
            showFavorites: false, showRecent: false, showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false,
        });
        const optionFor = (hook: { getCurrent(): { rootStep: { sections: ReadonlyArray<{ kind: string; options?: ReadonlyArray<{ id: string; subtitle?: string; disabled?: boolean }> }> } } }, id: string) =>
            hook.getCurrent().rootStep.sections.flatMap(section => section.options ?? []).find(option => option.id.endsWith(id));

        it('marks a machine as offline-only when presence is its only blocker, and never one refused for access or content', async () => {
            const plain = createMachineFixture({ id: 'studio', active: false, activeAt: 0 });
            const locked = createMachineFixture({ id: 'locked', active: false, activeAt: 0, availability: { kind: 'locked', reason: 'recipient_key_pending' } });
            const pending = createMachineFixture({ id: 'pending', active: false, activeAt: 0, isShared: true,
                access: { custodian: { accountId: 'ben', displayName: 'Ben' }, role: 'use', resourceMode: 'plain', accessState: 'key_pending' } } as Partial<Machine>);
            await seedAnsweredMachines([plain, locked, pending]);
            const hook = await renderHook(() => useMachineSelectionListModel(paramsFor([plain, locked, pending])));
            try {
                await flushHookEffects({ cycles: 20 });
                expect(hook.getCurrent().offlineOnlyMachineIdsByServerId[serverId]).toEqual(['studio']);
                expect(optionFor(hook, 'locked')?.disabled).toBe(true);
                expect(optionFor(hook, 'pending')?.disabled).toBe(true);
                expect(optionFor(hook, 'studio')?.subtitle).not.toContain('projectWorkers.loading');
            } finally { await hook.unmount(); }
        });

        it('re-classifies when a request-reachability failure arrives without any Machine row change', async () => {
            const machine = createMachineFixture({ id: 'worker', active: true, activeAt: Date.now() });
            await seedAnsweredMachines([machine]);
            rpc.machine.mockResolvedValue({ eligible: true, candidate: { serverId, machineId: machine.id },
                load: { kind: 'known', running: 0, queued: 0, accepting: true, runAtMost: null }, explanation: 'eligible' });
            const hook = await renderHook(() => useMachineSelectionListModel(paramsFor([machine])));
            try {
                await waitForHomeGovernance(() => expect(optionFor(hook, 'worker')?.disabled).toBe(false));
                expect(hook.getCurrent().offlineOnlyMachineIdsByServerId[serverId]).toEqual([]);
                await act(async () => recordMachineRequestFailed({ serverId, accountId: 'owner', machineId: machine.id }));
                expect(hook.getCurrent().offlineOnlyMachineIdsByServerId[serverId]).toEqual(['worker']);
            } finally { clearMachineRequestReachabilityForTest(); await hook.unmount(); }
        });
    });
    it.each(['finite', 'service-start'] as const)('demands exact %s status and keeps a full queue selectable', async (purpose) => {
        const machine = createMachineFixture({ id: 'worker', active: true, activeAt: Date.now() });
        const scopedMachine = await seedAnsweredScopedMachine(machine);
        const worker = { eligible: true, candidate: { serverId, machineId: machine.id },
            load: { kind: 'known', running: 2, queued: 7, accepting: true, runAtMost: 2 }, explanation: 'eligible' };
        rpc.machine.mockResolvedValue(worker);
        const params: BuildMachineSelectionListModelParams = {
            purpose,
            workerPlacement: { workspace: { serverId, refId: 'checkout' } },
            groups: [{ serverId, serverName: 'Worker picker', loading: false, signedOut: false,
                machines: [scopedMachine] }],
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
        await seedAnsweredMachines([machine]);
        let finishOld!: (status: unknown) => void;
        const unknown = { eligible: true, candidate: { serverId, machineId: machine.id },
            load: { kind: 'unknown' }, explanation: 'load_unknown' };
        rpc.machine.mockImplementationOnce(async () => await new Promise(resolve => { finishOld = resolve; }));
        rpc.machine.mockResolvedValue(unknown);
        const hook = await renderHook((refId: string) => useMachineSelectionListModel<Machine>({
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
        await seedAnsweredMachines([machine]);
        rpc.machine.mockResolvedValueOnce({ eligible: true, candidate: { serverId, machineId: machine.id },
            load: { kind: 'unknown' }, explanation: 'load_unknown' });
        rpc.machine.mockResolvedValue({ eligible: false, candidate: null,
            load: { kind: 'known', running: 0, queued: 0, accepting: false, runAtMost: 2 }, explanation: 'not_accepting' });
        const hook = await renderHook((metadataVersion: number) => useMachineSelectionListModel<Machine>({
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
        // Missing current status is also disabled (buildMachineDestinationModel.ts:57,83).
        // Wait for the completed refusal, not the intermediate checking state.
        await vi.waitFor(() => {
            const options = hook.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
            expect(options.find(option => option.id === 'worker')?.subtitle).toContain('projectWorkers.notAccepting');
        });
        await vi.waitFor(() => expect(selectable()).toBe(false));
        expect(rpc.machine).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it('refreshes exact load on matching lifecycle and admission phase pushes, not unrelated scopes or label-only revisions', async () => {
        const machine = createMachineFixture({ id: 'worker', active: true, activeAt: Date.now(), metadataVersion: 1 });
        await seedAnsweredMachines([machine]);
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
