import { describe, expect, it } from 'vitest';
import { registerRepositoryUploadTarget, invokeRepositoryUploadPick } from './repositoryUploadActionRuntime';

describe('mounted repository upload intent', () => {
    it('requests the exact mounted picker destination once and retires with its owner', async () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const workspaceScope = { serverId: 'home', machineId: 'machine', rootPath: '/repo' };
        const picked: Array<Readonly<{ kind: string; destinationDir: string }>> = [];
        let current = true;
        const release = registerRepositoryUploadTarget({ scope, workspaceScope, isCurrent: () => current,
            pick: async input => { picked.push(input); return { status: 'requested' }; } });
        const request = { scope, workspace: workspaceScope, destinationDir: 'deep/subfolder', kind: 'folder' as const };
        try {
            expect(await invokeRepositoryUploadPick({ ...request, scope: { ...scope, accountId: 'other' } })).toEqual({ status: 'unavailable' });
            expect(await invokeRepositoryUploadPick({ ...request, workspace: { ...workspaceScope, rootPath: '/repo-sibling' } })).toEqual({ status: 'unavailable' });
            expect(await invokeRepositoryUploadPick(request)).toEqual({ status: 'requested' });
            expect(picked).toEqual([{ kind: 'folder', destinationDir: 'deep/subfolder' }]);
            current = false;
            expect(await invokeRepositoryUploadPick(request)).toEqual({ status: 'unavailable' });
            current = true;
            const controller = new AbortController();
            controller.abort();
            expect(await invokeRepositoryUploadPick(request, controller.signal)).toEqual({ status: 'cancelled' });
            expect(picked).toHaveLength(1);
        } finally { release(); }
        expect(await invokeRepositoryUploadPick(request)).toEqual({ status: 'unavailable' });
    });
});
