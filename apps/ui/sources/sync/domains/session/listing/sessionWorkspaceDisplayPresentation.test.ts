import { describe, expect, it } from 'vitest';

import { resolveSessionWorkspaceDisplayPresentation } from './sessionWorkspaceDisplayPresentation';

describe('resolveSessionWorkspaceDisplayPresentation', () => {
    it('matches workspace refs using the canonical expanded root path while displaying a home-relative fallback', () => {
        const presentation = resolveSessionWorkspaceDisplayPresentation({
            serverId: 'server-1',
            metadata: {
                machineId: 'machine-1',
                path: '~/repo',
                homeDir: '/home/u',
            },
            workspaceRefs: [{
                id: 'workspace-ref-1',
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/home/u/repo',
                label: 'Main Repo',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            }],
        });

        expect(presentation.workspaceScope).toEqual({
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/home/u/repo',
        });
        expect(presentation.workspaceRefId).toBe('workspace-ref-1');
        expect(presentation.displayTitle).toBe('Main Repo');
        expect(presentation.hasCustomLabel).toBe(true);
    });
});
