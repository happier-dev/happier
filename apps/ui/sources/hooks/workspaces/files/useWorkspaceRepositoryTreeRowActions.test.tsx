import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
beforeAll(prepareSessionFilesViewTestkit);
afterEach(standardCleanup);

describe('workspace tree mutation callbacks', () => {
    async function setup(success: boolean) {
        const fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: () => success
            ? { success: true } : { success: false, error: 'Filesystem access denied' } });
        const { Modal } = await import('@/modal');
        vi.spyOn(Modal, 'prompt').mockResolvedValue('renamed');
        vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        const { useWorkspaceRepositoryTreeRowActions } = await import('./useWorkspaceRepositoryTreeRowActions');
        let actions: ReturnType<typeof useWorkspaceRepositoryTreeRowActions> | undefined;
        const changed = vi.fn();
        const refresh = vi.fn();
        function Harness() {
            actions = useWorkspaceRepositoryTreeRowActions({ workspaceScope: fixture.scope, writeActionsEnabled: true,
                expandedPaths: ['src', 'src/nested', 'other'], onExpandedPathsChange: changed, onRequestRefresh: refresh });
            return null;
        }
        const screen = await fixture.render(React.createElement(Harness));
        if (!actions) throw new Error('Tree actions were not rendered');
        return { fixture, screen, actions, changed, refresh };
    }

    it('renames through the rooted Action before remapping expansion and refreshing', async () => {
        const state = await setup(true);
        try {
            await act(async () => state.actions.onSelectRowMenuItem({ path: 'src', type: 'directory' }, 'repository-tree-menuitem-rename'));
            expect(state.fixture.requests).toContainEqual({ targetId: 'm1', method: 'daemon.filesystem.rename',
                payload: { rootPath: '/repo', from: '/repo/src', to: '/repo/renamed', overwrite: false } });
            expect(state.changed).toHaveBeenCalledWith(['renamed', 'renamed/nested', 'other']);
            expect(state.refresh).toHaveBeenCalledOnce();
        } finally { await state.fixture.dispose(); }
    });

    it('preserves expansion and refresh state when the filesystem owner refuses the rename', async () => {
        const state = await setup(false);
        try {
            await act(async () => state.actions.onSelectRowMenuItem({ path: 'src', type: 'directory' }, 'repository-tree-menuitem-rename'));
            expect(state.changed).not.toHaveBeenCalled();
            expect(state.refresh).not.toHaveBeenCalled();
        } finally { await state.fixture.dispose(); }
    });

    it('performs the confirmed recursive delete through the same rooted Action', async () => {
        const state = await setup(true);
        try {
            await act(async () => state.actions.onSelectRowMenuItem({ path: 'src', type: 'directory' }, 'repository-tree-menuitem-delete'));
            expect(state.fixture.requests).toContainEqual({ targetId: 'm1', method: 'daemon.filesystem.delete',
                payload: { rootPath: '/repo', path: '/repo/src', recursive: true } });
            expect(state.changed).toHaveBeenCalledWith(['other']);
            expect(state.refresh).toHaveBeenCalledOnce();
        } finally { await state.fixture.dispose(); }
    });
});
