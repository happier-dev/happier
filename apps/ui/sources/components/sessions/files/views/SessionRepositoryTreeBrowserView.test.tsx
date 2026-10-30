import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, pressTestInstanceAsync, standardCleanup } from '@/dev/testkit';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));
const { Item } = await import('@/components/ui/lists/Item');

describe('Session shared browser consumer', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    let fixtureIndex = 0;
    beforeAll(prepareSessionFilesViewTestkit);
    beforeEach(async () => {
        const rootPath = `/session-browser-${++fixtureIndex}`;
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST) return { ok: true, paths: ['src/nested/file.ts'], truncated: false };
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
                const path = (request.payload as { path: string }).path;
                return { ok: true, path, truncated: false, gitIgnoreAvailable: true, entries: path === rootPath
                    ? [{ name: 'src', path: `${path}/src`, type: 'directory' }] : [] };
            }
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        fixture.setSnapshot(fileViewSnapshot({ rootPath }));
    });
    afterEach(async () => { standardCleanup(); await fixture.dispose(); });

    async function render(overrides: Partial<React.ComponentProps<typeof import('./SessionRepositoryTreeBrowserView').SessionRepositoryTreeBrowserView>> = {}) {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const onOpenFile = vi.fn();
        return { screen: await fixture.render(<SessionRepositoryTreeBrowserView sessionId="s1" serverId={fixture.scope.serverId} onOpenFile={onOpenFile} {...overrides} />), onOpenFile };
    }
    function findSearchResult(screen: Awaited<ReturnType<typeof fixture.render>>, path: string) {
        return screen.findAllByType(Item).find(row => {
            const title: unknown = row.props.title;
            return React.isValidElement<{ fullPath?: string }>(title) && title.props.fullPath === path;
        });
    }

    it('lists the known Session machine and folder even when the Session is inactive, and can hide the search toolbar', async () => {
        fixture.storage.getState().applySessions([{ ...fixture.session, active: false }]);
        const { screen } = await render({ showSearchBar: false });
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-src')).toBeTruthy());
        expect(fixture.requests).toContainEqual({
            targetId: fixture.scope.machineId,
            method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
            payload: expect.objectContaining({ path: fixture.scope.rootPath, includeFiles: true }),
        });
        expect(screen.findByTestId('repository-tree-search')).toBeNull();
        expect(screen.findByTestId('repository-tree-session-files-root')).toBeNull();
    });

    it('does not offer an SCM-only Retry when the Session workspace target is unresolved', async () => {
        fixture.storage.getState().applySessions([{
            ...fixture.session,
            metadata: { ...fixture.session.metadata!, path: '' },
        }]);
        const { screen } = await render();
        expect(screen.findByTestId('repository-tree-root-error')).toBeTruthy();
        // This is a settled missing identity, not a failed directory read. The
        // SCM invalidator cannot produce a machine/folder or recover this state.
        expect(Boolean(screen.findByTestId('repository-tree-root-error-action'))).toBe(false);
    });

    it('explains a known offline Session machine without reporting a lost folder', async () => {
        const original = fixture.storage.getState().machines[fixture.scope.machineId]!;
        const { installTransferProjection } = await import('../sessionFileTransferTestkit');
        // Publish both real Machine projections, as the Home read does. A scoped
        // offline row beside an online active projection is not the live case.
        installTransferProjection({ serverId: fixture.scope.serverId, session: fixture.session,
            machine: { ...original, active: false } });
        const peers = ['other-daemon-a', 'other-daemon-b'].map(id => createMachineFixture({
            id, active: true, activeAt: Date.now(), metadata: original.metadata,
        }));
        await publishMachineInventoryForTest({ serverId: fixture.scope.serverId, accountId: 'alice' }, [
            { ...original, active: false }, ...peers,
        ]);
        const { screen } = await render();
        // Loaded incident: the original d2 daemon is stopped while several
        // other daemons on the same host are active. This is not a lost folder.
        expect(screen.findByTestId('repository-tree-unreachable')).toBeTruthy();
        expect(screen.findByTestId('repository-tree-root-error')).toBeNull();
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY
            || request.method === RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST)).toEqual([]);

        // The Home pushes the original Machine's recovery. No Retry or Session
        // metadata write is needed to re-resolve its known folder and list it.
        await act(async () => {
            installTransferProjection({ serverId: fixture.scope.serverId, session: fixture.session, machine: original });
            await publishMachineInventoryForTest({ serverId: fixture.scope.serverId, accountId: 'alice' }, [original, ...peers]);
        });
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-src')).toBeTruthy());
        expect(screen.findByTestId('repository-tree-unreachable')).toBeNull();
        expect(fixture.requests).toContainEqual({
            targetId: fixture.scope.machineId,
            method: RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
            payload: expect.objectContaining({ path: fixture.scope.rootPath, includeFiles: true }),
        });
    });
    it('labels managed Session files only from the addressed Home', async () => {
        const session = { ...fixture.session, metadata: { ...fixture.session.metadata!, sessionDirectoryV1: { v: 1 as const, kind: 'managed' as const } } };
        fixture.storage.getState().applySessions([session]);
        const { screen } = await render();
        expect(screen.findByTestId('repository-tree-session-files-root')).toBeTruthy();
        const { useSessionDirectoryKind } = await import('@/sync/domains/state/storage');
        let kind: ReturnType<typeof useSessionDirectoryKind>;
        function Reader() { kind = useSessionDirectoryKind('s1', 'unrelated-home'); return null; }
        await fixture.render(<Reader />);
        expect(kind!).toBeNull();
    });

    it('reveals a matching folder without opening file Details', async () => {
        const { screen, onOpenFile } = await render();
        await act(async () => screen.changeTextByTestId('repository-tree-search', 'nested'));
        await vi.waitFor(() => expect(findSearchResult(screen, 'src/nested/')).toBeTruthy());
        await pressTestInstanceAsync(findSearchResult(screen, 'src/nested/'), 'matching folder result');
        expect(screen.findByTestId('repository-tree-search')?.props.value).toBe('');
        expect(fixture.storage.getState().getSessionRepositoryTreeExpandedPaths('s1')).toEqual(['src', 'src/nested']);
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('opens an actual filename result through the host callback', async () => {
        const { screen, onOpenFile } = await render({ searchQuery: 'file' });
        await vi.waitFor(() => expect(findSearchResult(screen, 'src/nested/file.ts')).toBeTruthy());
        await pressTestInstanceAsync(findSearchResult(screen, 'src/nested/file.ts'), 'matching file result');
        expect(onOpenFile).toHaveBeenCalledWith('src/nested/file.ts');
    });

    it('keeps row action and expansion callbacks stable when only root loading changes', async () => {
        const { WorkspaceRepositoryTreeList } = await import('@/components/projects/files/WorkspaceRepositoryTreeList');
        const { screen } = await render();
        const first = screen.findByType(WorkspaceRepositoryTreeList).props;
        await act(async () => first.onRootLoadingChange(true));
        const next = screen.findByType(WorkspaceRepositoryTreeList).props;
        expect(next.onExpandedPathsChange).toBe(first.onExpandedPathsChange);
        expect(next.renderRowActions).toBe(first.renderRowActions);
    });
});
