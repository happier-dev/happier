import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useSessionListWorkspaceHeaderActions } from './useSessionListWorkspaceHeaderActions';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: vi.fn(async () => 'Repo'),
        },
    }).module;
});

describe('useSessionListWorkspaceHeaderActions', () => {
    it('skips rewriting workspace refs when resetting an already unlabelled workspace', async () => {
        const setWorkspaceRefs = vi.fn();
        const hook = await renderHook(() => useSessionListWorkspaceHeaderActions({
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
        }));

        hook.getCurrent().handleResetWorkspaceName({
            legacyWorkspaceKey: 'legacy-key',
            scopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
        });

        expect(setWorkspaceRefs).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('skips rewriting workspace refs when renaming to the current workspace label', async () => {
        const setWorkspaceRefs = vi.fn();
        const hook = await renderHook(() => useSessionListWorkspaceHeaderActions({
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
        }));

        await hook.getCurrent().handleRenameWorkspace({
            legacyWorkspaceKey: 'legacy-key',
            scopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
            currentLabel: 'Repo',
        });

        expect(setWorkspaceRefs).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
