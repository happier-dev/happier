import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ProjectSourcesCreateInputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import { createUiScmAction } from '@/sync/ops/actions/scmActionDeps';
import { storage } from '@/sync/domains/state/storage';
import { createProjectSourcesController } from './projectSourcesController';
import { readProjectSourceAddressMachines } from './projectSourceAddressMachines';
import type { ProjectSourceAddressMachines } from './resolveProjectSourceAddress';
import type { ServerFetch } from '@/sync/http/client';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';

const rpc = vi.hoisted(() => vi.fn());
// Only network transports are mocked; Action admission, SCM routing and Source serialization are real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
const scope = { serverId: 'home-a', accountId: 'account-a' };
const selector = { provider: { id: 'example.forge/forge', kind: 'custom' as const, displayName: 'Forge', baseUrl: 'https://forge.test' },
    repository: { nameWithOwner: 'team/repo', cloneUrl: 'https://forge.test/team/repo' }, protocol: 'https' as const };
const machines = [{ id: 'online', active: true }, { id: 'preferred', active: true }, { id: 'offline', active: false }];
const inventory = { machines, inventoryStatus: 'idle' as const };
function harness(readAddressMachines: () => ProjectSourceAddressMachines = () => inventory) {
    const request = vi.fn<ServerFetch>().mockImplementation(async (_path, init) => {
        const { serverId: _serverId, requestKey: _requestKey, ...draft } = ProjectSourcesCreateInputV1Schema.parse(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true,
            source: { ...draft, id: 'source', revision: 1, createdByAccountId: scope.accountId }, canManage: true }));
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ scmActionExecute: createUiScmAction(),
        ...createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'account', request,
            assertCurrent() {}, workflowArtifacts: { read: async () => null } }),
    }));
    const execute = vi.fn<Parameters<typeof createProjectSourcesController>[1]>((id, input, context) =>
        executor.execute(id, input, { ...context, runtimeAccountId: scope.accountId, authority: 'present_user', bypassApprovals: true }));
    return { controller: createProjectSourcesController(scope, execute, readAddressMachines), execute, request };
}
beforeEach(() => {
    clearMachineRequestReachabilityForTest();
    storage.setState(storage.getInitialState(), true);
    rpc.mockReset();
    rpc.mockResolvedValue({ success: true, kind: 'resolved', selector });
});

describe('Source editor address producer', () => {
    it('distinguishes a pending Machine list from settled absence through the real inventory reader', async () => {
        const { controller, execute } = harness(() => readProjectSourceAddressMachines(scope.serverId));
        storage.setState({ isDataReady: true, machines: {}, machineListByServerId: {},
            machineListStatusByServerId: { [scope.serverId]: 'loading' } });
        await controller.resolveAddress('forge.test/team/repo');
        expect(controller.getSnapshot().addressSaveDisabledReason).toBe('projects.sources.loading');
        storage.setState({ machineListStatusByServerId: { [scope.serverId]: 'error' } });
        await controller.resolveAddress('forge.test/team/repo');
        expect(controller.getSnapshot().addressSaveDisabledReason).toBe('projects.sources.backendUnavailable');
        storage.setState({ isDataReady: false, machineListByServerId: { [scope.serverId]: [] },
            machineListStatusByServerId: { [scope.serverId]: 'idle' } });
        await controller.resolveAddress('forge.test/team/repo');
        expect(controller.getSnapshot().addressSaveDisabledReason).toBe('projects.sources.addressNoMachine');
        expect(execute).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('skips a heartbeat-online Machine whose requests failed in this Account, preserving another Account', async () => {
        recordMachineRequestFailed({ ...scope, machineId: 'preferred' });
        recordMachineRequestFailed({ ...scope, accountId: 'other-account', machineId: 'online' });
        const { controller, execute } = harness();
        await controller.resolveAddress('forge.test/team/repo', { ...inventory, preferredMachineId: 'preferred' });
        expect(execute.mock.calls[0]?.[2]?.externalActionTarget).toEqual({ kind: 'machine', machineId: 'online' });
    });
    it('submits one controller creation draft with custom name, ref, contained folder and audience through admission', async () => {
        const { controller, request } = harness();
        controller.beginCreate();
        controller.editCreation({ name: 'Custom', defaultRef: 'release', subdir: 'apps/mobile', audience: [] });
        await controller.resolveAddress('forge.test/team/repo');
        controller.editCreation({ subdir: '../escape' });
        await controller.save();
        expect(request).not.toHaveBeenCalled();
        controller.editCreation({ subdir: 'apps/mobile' });
        await controller.save();
        expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
            serverId: scope.serverId, requestKey: expect.any(String), name: 'Custom', repository: selector,
            defaultRef: 'release', subdir: 'apps/mobile', audience: [],
        });
        expect(controller.getSnapshot().creationDraft).toBeNull();
        expect(controller.getSnapshot().current).toMatchObject({ name: 'Custom', defaultRef: 'release', subdir: 'apps/mobile' });
    });
    it("reads a checkout's address on that checkout's own Machine, over the SCM preference and the first Machine", async () => {
        const { controller, execute } = harness(() => ({ ...inventory, preferredMachineId: 'online' }));
        controller.beginCreate({ name: 'Repository', checkoutMachineId: 'preferred' });
        await controller.resolveAddress('forge.test/team/repo');
        expect(execute.mock.calls[0]?.[2]?.externalActionTarget).toEqual({ kind: 'machine', machineId: 'preferred' });
        expect(controller.getSnapshot().addressResolution).toMatchObject({ kind: 'resolved', machineId: 'preferred' });
        // A Source created without a checkout keeps the incumbent choice.
        controller.discard();
        controller.beginCreate({ name: 'Other' });
        await controller.resolveAddress('forge.test/team/repo');
        expect(execute.mock.calls[1]?.[2]?.externalActionTarget).toEqual({ kind: 'machine', machineId: 'online' });
    });
    it('says which Machine could not check the address, with its failure code, instead of blaming the repository', async () => {
        rpc.mockRejectedValue(Object.assign(new Error('boom'), { code: 'RPC_METHOD_NOT_AVAILABLE' }));
        const { controller } = harness();
        controller.beginCreate({ name: 'Repository', checkoutMachineId: 'preferred' });
        await controller.resolveAddress('forge.test/team/repo');
        expect(controller.getSnapshot().addressResolution).toMatchObject({ kind: 'unavailable', machineId: 'preferred', errorCode: expect.any(String) });
        expect(controller.getSnapshot().addressSaveDisabledReason).toBe('projects.sources.addressCheckFailed');
    });
    it('prefers the selected reachable Machine and exposes resolution before saving its selector', async () => {
        let finish!: (value: unknown) => void;
        rpc.mockImplementation(async () => await new Promise(done => { finish = done; }));
        const { controller, execute } = harness();
        const pending = controller.resolveAddress('forge.test/team/repo', { ...inventory, preferredMachineId: 'preferred' });
        expect(controller.getSnapshot().addressResolution).toMatchObject({ kind: 'resolving', machineId: 'preferred' });
        expect(execute.mock.calls[0]).toEqual(['scm.hostingRepository.resolveAddress', { address: 'forge.test/team/repo' }, expect.objectContaining({
            serverId: scope.serverId, expectedAccountId: scope.accountId, externalActionTarget: { kind: 'machine', machineId: 'preferred' },
        })]);
        await vi.waitFor(() => expect(finish).toBeDefined());
        finish({ success: true, kind: 'resolved', selector });
        await pending;
        expect(controller.getSnapshot().addressResolution).toMatchObject({ kind: 'resolved', selector });
        await controller.save();
        expect(execute.mock.calls.at(-1)?.[0]).toBe('projects.sources.create');
    });
    it('refuses Save without a reachable Machine and discards stale and retired transport replies', async () => {
        const finishes: Array<(value: unknown) => void> = [];
        rpc.mockImplementation(async () => await new Promise(done => finishes.push(done)));
        const { controller, execute } = harness();
        await controller.resolveAddress('forge.test/team/repo', { inventoryStatus: 'idle', machines: [{ id: 'offline', active: false },
            { id: 'replaced', active: true, replacedByMachineId: 'new' }] });
        expect(controller.getSnapshot().addressResolution).toMatchObject({ kind: 'no_reachable_machine' });
        await controller.save();
        expect(execute).not.toHaveBeenCalled();
        const old = controller.resolveAddress('forge.test/old/repo', { ...inventory, preferredMachineId: 'offline' });
        expect(controller.getSnapshot().addressResolution).toMatchObject({ machineId: 'online' });
        await vi.waitFor(() => expect(finishes).toHaveLength(1));
        const latest = controller.resolveAddress('forge.test/new/repo');
        await vi.waitFor(() => expect(finishes).toHaveLength(2));
        finishes[1]!({ success: true, kind: 'unknown' });
        await latest;
        finishes[0]!({ success: true, kind: 'resolved', selector });
        await old;
        expect(controller.getSnapshot().addressResolution).toMatchObject({ kind: 'unknown', address: 'forge.test/new/repo' });
        expect(controller.getSnapshot().creationDraft?.repository).toBeNull();
        const retired = controller.resolveAddress('forge.test/team/repo');
        await vi.waitFor(() => expect(finishes).toHaveLength(3));
        controller.dispose();
        finishes[2]!({ success: true, kind: 'resolved', selector });
        await retired;
        expect(controller.getSnapshot().addressResolution.kind).toBe('resolving');
    });
});
