import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ProjectSourcesCreateInputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createProjectSourceActionDeps } from '@/sync/api/projects/projectSourceActions';
import { createUiScmAction } from '@/sync/ops/actions/scmActionDeps';
import { storage } from '@/sync/domains/state/storage';
import { createProjectSourcesController } from './projectSourcesController';
import type { ServerFetch } from '@/sync/http/client';

const rpc = vi.hoisted(() => vi.fn());
// Only network transports are mocked; Action admission, SCM routing and Source serialization are real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
const scope = { serverId: 'home-a', accountId: 'account-a' };
const selector = { provider: { id: 'example.forge/forge', kind: 'custom' as const, displayName: 'Forge', baseUrl: 'https://forge.test' },
    repository: { nameWithOwner: 'team/repo', cloneUrl: 'https://forge.test/team/repo' }, protocol: 'https' as const };
const machines = [{ id: 'online', active: true }, { id: 'preferred', active: true }, { id: 'offline', active: false }];
function harness() {
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
    return { controller: createProjectSourcesController(scope, execute, () => ({ machines })), execute, request };
}
beforeEach(() => {
    storage.setState(storage.getInitialState(), true);
    rpc.mockReset();
    rpc.mockResolvedValue({ success: true, kind: 'resolved', selector });
});

describe('Source editor address producer', () => {
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
    it('prefers the selected reachable Machine and exposes resolution before saving its selector', async () => {
        let finish!: (value: unknown) => void;
        rpc.mockImplementation(async () => await new Promise(done => { finish = done; }));
        const { controller, execute } = harness();
        const pending = controller.resolveAddress('forge.test/team/repo', { machines, preferredMachineId: 'preferred' });
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
        await controller.resolveAddress('forge.test/team/repo', { machines: [{ id: 'offline', active: false },
            { id: 'replaced', active: true, replacedByMachineId: 'new' }] });
        expect(controller.getSnapshot().addressResolution).toMatchObject({ kind: 'no_reachable_machine' });
        await controller.save();
        expect(execute).not.toHaveBeenCalled();
        const old = controller.resolveAddress('forge.test/old/repo', { machines, preferredMachineId: 'offline' });
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
