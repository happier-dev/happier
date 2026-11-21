import { expect, it } from 'vitest';
import { acknowledgeWorkspaceFileWrites, subscribeAcknowledgedWorkspaceFileWrites } from './workspaceFileAcknowledgements';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

it('isolates same-path managed file acknowledgements from other guests and the controller', () => {
    const controller = { serverId: 'home', accountId: 'account', machineId: 'controller', rootPath: '/repo' };
    const workspace = { v: 2 as const, kind: 'managed' as const, serverId: 'home', workspaceId: 'checkout-a',
        managedId: 'guest-a', controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/repo' };
    const first: WorkspaceScopeBase & { accountId: string } = { ...controller, workspace };
    const second = { ...first, workspace: { ...workspace, workspaceId: 'checkout-b', managedId: 'guest-b' } };
    const writes = { first: [] as Array<string | null>, second: [] as Array<string | null>, controller: [] as Array<string | null> };
    const disposes = [
        subscribeAcknowledgedWorkspaceFileWrites(first, 'file.txt', write => writes.first.push(write.hash)),
        subscribeAcknowledgedWorkspaceFileWrites(second, 'file.txt', write => writes.second.push(write.hash)),
        subscribeAcknowledgedWorkspaceFileWrites(controller, 'file.txt', write => writes.controller.push(write.hash)),
    ];
    try {
        acknowledgeWorkspaceFileWrites(first, [{ path: 'file.txt', hash: 'guest-write' }]);
        expect(writes).toEqual({ first: ['guest-write'], second: [], controller: [] });
    } finally { disposes.forEach(dispose => dispose()); }
});

it('matches canonical Windows file identity without crossing Account, Machine, or sibling roots', () => {
    const target = { serverId: 'home', accountId: 'account', machineId: 'machine', rootPath: 'C:\\repo' };
    const hashes: Array<string | null> = [];
    const dispose = subscribeAcknowledgedWorkspaceFileWrites(target, 'src\\file.txt', write => { hashes.push(write.hash); });
    try {
        acknowledgeWorkspaceFileWrites({ ...target, rootPath: 'C:/repo' }, [{ path: 'src/file.txt', hash: 'own' }]);
        acknowledgeWorkspaceFileWrites({ ...target, accountId: 'other' }, [{ path: 'src/file.txt', hash: 'other-account' }]);
        acknowledgeWorkspaceFileWrites({ ...target, machineId: 'other' }, [{ path: 'src/file.txt', hash: 'other-machine' }]);
        acknowledgeWorkspaceFileWrites({ ...target, rootPath: 'C:/repo-other' }, [{ path: 'src/file.txt', hash: 'sibling' }]);
        expect(hashes).toEqual(['own']);
    } finally { dispose(); }
    acknowledgeWorkspaceFileWrites(target, [{ path: 'src/file.txt', hash: 'after-unmount' }]);
    expect(hashes).toEqual(['own']);
});

it('does not turn committed bytes into a failed write when one mounted observer throws', () => {
    const target = { serverId: 'home', accountId: 'account', machineId: 'machine', rootPath: '/repo' };
    const disposeBroken = subscribeAcknowledgedWorkspaceFileWrites(target, 'file.txt', () => { throw new Error('retired reader'); });
    const hashes: Array<string | null> = [];
    const dispose = subscribeAcknowledgedWorkspaceFileWrites(target, 'file.txt', write => { hashes.push(write.hash); });
    try {
        expect(() => acknowledgeWorkspaceFileWrites(target, [{ path: 'file.txt', hash: 'committed' }])).not.toThrow();
        expect(hashes).toEqual(['committed']);
    } finally { disposeBroken(); dispose(); }
});
