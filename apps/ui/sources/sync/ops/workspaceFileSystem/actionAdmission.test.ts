import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const filesystem = vi.hoisted(() => ({ paths: new Set<string>(), calls: [] as unknown[] }));
// The machine filesystem is a genuine cross-process boundary; policy, schemas,
// captured Account custody and approval Artifact replay remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: async (request: { method: string; payload: { path?: string; from?: string; to?: string } }) => {
        filesystem.calls.push(request);
        if (request.method === 'daemon.filesystem.createDirectory' && request.payload.path) filesystem.paths.add(request.payload.path);
        if (request.method === 'daemon.filesystem.rename' && request.payload.from && request.payload.to) {
            filesystem.paths.delete(request.payload.from); filesystem.paths.add(request.payload.to);
        }
        if (request.method === 'daemon.filesystem.delete' && request.payload.path) filesystem.paths.delete(request.payload.path);
        return { success: true };
    },
}));
const { storage } = await import('@/sync/domains/state/storage');
const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
const { workspaceCreateDirectory } = await import('./directoryBrowsing');
const { workspaceRenamePath, workspaceDeletePath } = await import('./pathMetadataMutations');
type Target = Parameters<typeof workspaceCreateDirectory>[0];
const operations = [
    { actionId: 'daemon.filesystem.createDirectory' as const, run: (target: Target) => workspaceCreateDirectory(target, 'folder'), after: ['/repo/a', '/repo/folder'] },
    { actionId: 'daemon.filesystem.rename' as const, run: (target: Target) => workspaceRenamePath(target, { from: 'a', to: 'b', overwrite: false }), after: ['/repo/b'] },
    { actionId: 'daemon.filesystem.delete' as const, run: (target: Target) => workspaceDeletePath(target, { path: 'a', recursive: false }), after: [] },
];
let serverId: string;
let target: Target;
beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Filesystem Home', serverUrl: 'https://filesystem-action.test', accountId: 'account-a' });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://filesystem-action.test')!.token! });
    target = { serverId, machineId: 'machine-a', rootPath: '/repo' };
    filesystem.paths.clear(); filesystem.paths.add('/repo/a'); filesystem.calls.length = 0;
});
afterEach(async () => {
    await standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection(); await homes.reset();
});

describe('shared workspace filesystem Action admission', () => {
    it.each(operations)('$actionId cannot reach the machine when UI-disabled', async operation => {
        const scope = { serverId, accountId: 'account-a' };
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { [operation.actionId]: { disabledSurfaces: ['ui'] } },
        }) };
        storage.getState().applySettingsForScope(scope, settings, 1);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        expect(await operation.run(target)).toMatchObject({ success: false, errorCode: 'action_disabled' });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        expect(filesystem.calls).toEqual([]);
    });

    it.each(operations)('$actionId defers its exact rooted effect until approval', async operation => {
        await homes.requireUiApproval(serverId, operation.actionId);
        const pending = await operation.run(target);
        expect(pending).toMatchObject({ success: false, errorCode: 'approval_required', approvalArtifactId: expect.any(String) });
        expect([...filesystem.paths]).toEqual(['/repo/a']);
        expect(filesystem.calls).toEqual([]);
        if (!('approvalArtifactId' in pending) || typeof pending.approvalArtifactId !== 'string') throw new Error('Expected canonical approval custody');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('approval.request.decide', {
            artifactId: pending.approvalArtifactId, decision: 'approve',
        }, { surface: 'ui', serverId })).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect([...filesystem.paths].sort()).toEqual(operation.after);
        expect(filesystem.calls).toEqual([expect.objectContaining({ serverId, accountId: 'account-a', machineId: 'machine-a',
            method: operation.actionId, payload: expect.objectContaining({ rootPath: '/repo' }) })]);
    });

    it.each(operations)('$actionId keeps the ordinary allowed operation usable', async operation => {
        expect(await operation.run(target)).toMatchObject({ success: true });
        expect([...filesystem.paths].sort()).toEqual(operation.after);
    });
});
