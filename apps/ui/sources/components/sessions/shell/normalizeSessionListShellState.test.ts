import { describe, expect, it } from 'vitest';

import { normalizeSessionListShellState } from './normalizeSessionListShellState';

describe('normalizeSessionListShellState', () => {
    it('reuses shared empty canonical inputs when shell state is missing', () => {
        const first = normalizeSessionListShellState({
            collapsedGroupKeys: null,
            sessionTags: null,
            workspaceLabels: null,
            workspaceRefs: null,
        });
        const second = normalizeSessionListShellState({
            collapsedGroupKeys: undefined,
            sessionTags: undefined,
            workspaceLabels: undefined,
            workspaceRefs: undefined,
        });

        expect(first.collapsedGroupKeys).toBe(second.collapsedGroupKeys);
        expect(first.sessionTags).toBe(second.sessionTags);
        expect(first.workspaceLabels).toBe(second.workspaceLabels);
        expect(first.workspaceRefs).toBe(second.workspaceRefs);
        expect(first.collapsedGroupKeys).toEqual({});
        expect(first.sessionTags).toEqual({});
        expect(first.workspaceLabels).toEqual({});
        expect(first.workspaceRefs).toEqual([]);
    });

    it('preserves non-empty shell inputs by reference', () => {
        const collapsedGroupKeys = { 'group:server-a': true };
        const sessionTags = { 'server-a:sess-1': ['important'] };
        const workspaceLabels = { workspace_1: 'Workspace One' };
        const workspaceRefs = [
            {
                id: 'workspace-ref-1',
                serverId: 'server-a',
                machineId: 'machine-a',
                rootPath: '/repo',
                label: 'Workspace One',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ];

        const result = normalizeSessionListShellState({
            collapsedGroupKeys,
            sessionTags,
            workspaceLabels,
            workspaceRefs,
        });

        expect(result.collapsedGroupKeys).toBe(collapsedGroupKeys);
        expect(result.sessionTags).toBe(sessionTags);
        expect(result.workspaceLabels).toBe(workspaceLabels);
        expect(result.workspaceRefs).toBe(workspaceRefs);
    });
});
