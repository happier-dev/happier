import { describe, expect, it, vi } from 'vitest';

import { findWorkspaceRefByScope, upsertWorkspaceRefByScope } from './workspaceRefs';

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'workspace-ref-id',
}));

describe('workspaceRefs', () => {
    it('upserts by normalized scope and preserves id', () => {
        const refs = [
            {
                id: 'id-1',
                serverId: 'server',
                machineId: 'm1',
                rootPath: '/tmp/repo/',
                label: null,
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ];

        const next = upsertWorkspaceRefByScope(refs, {
            scope: { serverId: 'server', machineId: 'm1', rootPath: '/tmp/repo' },
            nowMs: 10,
            patch: { label: 'My Repo' },
        });

        expect(next).toHaveLength(1);
        expect(next[0]!.id).toBe('id-1');
        expect(next[0]!.label).toBe('My Repo');
    });

    it('creates a new ref when missing', () => {
        const next = upsertWorkspaceRefByScope([], {
            scope: { serverId: 'server', machineId: 'm1', rootPath: '/tmp/repo' },
            nowMs: 10,
            patch: { label: 'Repo' },
        });

        expect(next).toHaveLength(1);
        expect(next[0]!.id).toBe('workspace-ref-id');
        expect(next[0]!.rootPath).toBe('/tmp/repo');
    });

    it('finds ref by normalized scope', () => {
        const refs = [
            {
                id: 'id-1',
                serverId: 'server',
                machineId: 'm1',
                rootPath: 'C:\\\\Repo\\\\',
                label: 'X',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ];

        const found = findWorkspaceRefByScope(refs, { serverId: 'server', machineId: 'm1', rootPath: 'c:/repo' });
        expect(found?.id).toBe('id-1');
    });
});
