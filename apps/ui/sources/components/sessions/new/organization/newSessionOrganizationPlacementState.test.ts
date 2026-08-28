import { describe, expect, it } from 'vitest';

import {
    isNewSessionOrganizationPlacementAvailable,
    normalizeNewSessionOrganizationPlacement,
    reconcileNewSessionOrganizationPlacementForWorkspace,
} from './newSessionOrganizationPlacementState';

describe('newSessionOrganizationPlacementState', () => {
    it('deduplicates authored tag ids without changing their stable order', () => {
        expect(normalizeNewSessionOrganizationPlacement({
            folderId: ' folder-1 ',
            tagIds: ['tag-2', ' tag-1 ', 'tag-2', ''],
        })).toEqual({ folderId: 'folder-1', tagIds: ['tag-2', 'tag-1'] });
    });

    it('clears only a folder whose workspace no longer matches the exact target and path', () => {
        const placement = { folderId: 'folder-1', tagIds: ['tag-1'] } as const;
        const folders = [{
            folderId: 'folder-1',
            workspace: { t: 'workspaceScope', serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' },
        }] as const;

        expect(reconcileNewSessionOrganizationPlacementForWorkspace({
            placement,
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/repo',
            folders,
        })).toBe(placement);
        expect(reconcileNewSessionOrganizationPlacementForWorkspace({
            placement,
            executionTarget: { serverId: 'server-1', machineId: 'machine-2' },
            directory: '/repo',
            folders,
        })).toEqual({ folderId: null, tagIds: ['tag-1'] });
    });

    it('uses the canonical workspace path normalization instead of raw root-path equality', () => {
        const placement = { folderId: 'folder-1', tagIds: [] } as const;
        expect(reconcileNewSessionOrganizationPlacementForWorkspace({
            placement,
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: 'c:/users/lee/repo',
            folders: [{
                folderId: 'folder-1',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: 'C:\\Users\\Lee\\repo\\',
                },
            }],
        })).toBe(placement);
    });

    it('fails closed for stale non-empty placement when Session folders are unavailable', () => {
        expect(isNewSessionOrganizationPlacementAvailable({
            featureEnabled: false,
            placement: { folderId: 'folder-1', tagIds: ['tag-1'] },
        })).toBe(false);
        expect(isNewSessionOrganizationPlacementAvailable({
            featureEnabled: false,
            placement: { folderId: null, tagIds: [] },
        })).toBe(true);
    });
});
