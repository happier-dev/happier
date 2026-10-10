import { describe, expect, it, vi } from 'vitest';

import { migrateLegacyWorkspaceLabelsToWorkspaceRefs } from './workspaceLabelsMigration';

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'workspace-ref-id',
}));

describe('workspaceLabelsMigration', () => {
    it('retains the legacy label and every candidate when its exact scope is ambiguous', () => {
        const first = { id: 'first', serverId: 'server', machineId: 'm1', rootPath: '/tmp/repo',
            label: null, createdAtMs: 1, lastOpenedAtMs: null };
        const refs = [first, { ...first, id: 'second' }];
        const result = migrateLegacyWorkspaceLabelsToWorkspaceRefs({
            legacyWorkspaceLabels: { wl_aaaa: 'Legacy' }, workspaceRefs: refs, nowMs: 10,
            resolveScopeForLegacyKey: () => ({ serverId: 'server', machineId: 'm1', rootPath: '/tmp/repo' }),
        });
        expect(result.migratedCount).toBe(0);
        expect(result.nextLegacyWorkspaceLabels).toEqual({ wl_aaaa: 'Legacy' });
        expect(result.nextWorkspaceRefs).toEqual(refs);
    });
    it('migrates a legacy label when a scope is resolvable', () => {
        const result = migrateLegacyWorkspaceLabelsToWorkspaceRefs({
            legacyWorkspaceLabels: { wl_aaaa: 'My Repo' },
            workspaceRefs: [],
            nowMs: 10,
            resolveScopeForLegacyKey: (key) =>
                key === 'wl_aaaa' ? { serverId: 'server', machineId: 'm1', rootPath: '/tmp/repo' } : null,
        });

        expect(result.migratedCount).toBe(1);
        expect(result.nextLegacyWorkspaceLabels).toEqual({});
        expect(result.nextWorkspaceRefs).toHaveLength(1);
        expect(result.nextWorkspaceRefs[0]!.label).toBe('My Repo');
    });

    it('does not migrate when scope is unknown', () => {
        const result = migrateLegacyWorkspaceLabelsToWorkspaceRefs({
            legacyWorkspaceLabels: { wl_aaaa: 'My Repo' },
            workspaceRefs: [],
            nowMs: 10,
            resolveScopeForLegacyKey: () => null,
        });

        expect(result.migratedCount).toBe(0);
        expect(result.nextLegacyWorkspaceLabels).toEqual({ wl_aaaa: 'My Repo' });
        expect(result.nextWorkspaceRefs).toHaveLength(0);
    });

    it('does not overwrite an existing workspaceRef label', () => {
        const result = migrateLegacyWorkspaceLabelsToWorkspaceRefs({
            legacyWorkspaceLabels: { wl_aaaa: 'Legacy' },
            workspaceRefs: [
                {
                    id: 'id-1',
                    serverId: 'server',
                    machineId: 'm1',
                    rootPath: '/tmp/repo',
                    label: 'Canonical',
                    createdAtMs: 1,
                    lastOpenedAtMs: null,
                },
            ],
            nowMs: 10,
            resolveScopeForLegacyKey: (key) =>
                key === 'wl_aaaa' ? { serverId: 'server', machineId: 'm1', rootPath: '/tmp/repo' } : null,
        });

        expect(result.migratedCount).toBe(0);
        expect(result.nextLegacyWorkspaceLabels).toEqual({ wl_aaaa: 'Legacy' });
        expect(result.nextWorkspaceRefs).toHaveLength(1);
        expect(result.nextWorkspaceRefs[0]!.label).toBe('Canonical');
    });
});
