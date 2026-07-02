import { describe, expect, it, vi } from 'vitest';

import { useSessionListWorkspaceHeaderActions } from './useSessionListWorkspaceHeaderActions';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: vi.fn(async () => 'Repo'),
        },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
        getPreferredLanguage: () => 'en',
    });
});

describe('useSessionListWorkspaceHeaderActions', () => {
    it('skips rewriting workspace refs when resetting an already unlabelled workspace', async () => {
        const setWorkspaceRefs = vi.fn();
        const actions = useSessionListWorkspaceHeaderActions({
            workspaceRefs: [
                {
                    id: 'workspace-ref-id',
                    serverId: 'server_a',
                    machineId: 'machine_a',
                    rootPath: '/repo',
                    label: null,
                    createdAtMs: 1,
                    lastOpenedAtMs: null,
                },
            ],
            setWorkspaceRefs,
            collapsedGroupKeys: {},
            setCollapsedGroupKeys: vi.fn(),
        });

        actions.handleResetWorkspaceName({
            legacyWorkspaceKey: 'legacy-key',
            scopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
        });

        expect(setWorkspaceRefs).not.toHaveBeenCalled();
    });

    it('skips rewriting workspace refs when renaming to the current workspace label', async () => {
        const setWorkspaceRefs = vi.fn();
        const actions = useSessionListWorkspaceHeaderActions({
            workspaceRefs: [
                {
                    id: 'workspace-ref-id',
                    serverId: 'server_a',
                    machineId: 'machine_a',
                    rootPath: '/repo',
                    label: 'Repo',
                    createdAtMs: 1,
                    lastOpenedAtMs: null,
                },
            ],
            setWorkspaceRefs,
            collapsedGroupKeys: {},
            setCollapsedGroupKeys: vi.fn(),
        });

        await actions.handleRenameWorkspace({
            legacyWorkspaceKey: 'legacy-key',
            scopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
            currentLabel: 'Repo',
        });

        expect(setWorkspaceRefs).not.toHaveBeenCalled();
    });

    it('stores an explicit expanded tombstone when expanding a collapsed group', () => {
        const setCollapsedGroupKeys = vi.fn();

        const { handleToggleCollapse } = useSessionListWorkspaceHeaderActions({
            workspaceRefs: [],
            setWorkspaceRefs: vi.fn(),
            collapsedGroupKeys: {
                existing: true,
                alreadyExpanded: false,
            },
            setCollapsedGroupKeys,
        });

        handleToggleCollapse('existing');

        expect(setCollapsedGroupKeys).toHaveBeenCalledWith({
            existing: false,
            alreadyExpanded: false,
        });
    });
});
