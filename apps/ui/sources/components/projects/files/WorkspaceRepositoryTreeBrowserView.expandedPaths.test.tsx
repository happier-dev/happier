// @vitest-environment jsdom
import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScmWorkingEntrySchema } from '@happier-dev/protocol/scm/workingSnapshot';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { standardCleanup } from '@/dev/testkit';
import {
    createSessionFilesViewFixture,
    fileViewSnapshot,
    installSessionFilesViewBoundaries,
    prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

installSessionFilesViewBoundaries({ platformOS: 'web' });
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

// Prepare cold modules before each test's Account lifecycle starts its budget.
const { installWebLockManagerMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
const restoreLocks = installWebLockManagerMock().restore;
await prepareSessionFilesViewTestkit();
const { WorkspaceRepositoryTreeBrowserView } = await import('./WorkspaceRepositoryTreeBrowserView');
afterAll(() => restoreLocks());

describe('WorkspaceRepositoryTreeBrowserView (expanded paths)', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    beforeEach(async () => {
        // Browser worker availability is a platform boundary, not a transfer-policy substitute.
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', serverIdentityId: 'srv_expanded_paths', rpc: request => {
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({
                rootPath: '/repo', entries: [ScmWorkingEntrySchema.parse({
                    path: 'src/index.ts', kind: 'modified', includeStatus: '.', pendingStatus: 'M', hasPendingDelta: true,
                    stats: { pendingAdded: 1 },
                })],
            }) };
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
                const path = (request.payload as { path: string }).path;
                return { ok: true, path, entries: path === '/repo'
                    ? [{ name: 'src', path: '/repo/src', type: 'directory' }]
                    : [{ name: 'index.ts', path: '/repo/src/index.ts', type: 'file', sizeBytes: 42 }], truncated: false };
            }
            // Exercise the real admitted download request without opening an OS save destination.
            if (request.method === 'daemon.filesystem.download') return { success: false, status: 'failed', error: 'Download refused by the Machine fixture' };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        fixture.storage.getState().setWorkspaceRepositoryTreeExpandedPaths(fixture.scope, ['src']);
    });
    afterEach(async () => {
        standardCleanup();
        await fixture?.dispose();
        vi.unstubAllGlobals();
    });

    const rowId = (path: string) => `repository-tree-row-${toTestIdSafeValue(path)}`;
    async function renderBrowser() {
        const screen = await fixture.render(<WorkspaceRepositoryTreeBrowserView
            scope={fixture.scope} onOpenFile={() => {}} showSearchBar={false} selectedPath="src/index.ts"
        />);
        await vi.waitFor(() => expect(screen.findHostByTestId(rowId('src/index.ts'))).not.toBeNull());
        return screen;
    }

    it('loads a complete workspace SCM snapshot through the addressed controller when no prop is provided', async () => {
        await renderBrowser();
        await vi.waitFor(() => expect(fixture.storage.getState().getWorkspaceScmSnapshot(fixture.scope)?.branch.head).toBe('main'));
        expect(fixture.storage.getState().getWorkspaceScmSnapshot(fixture.scope)?.entries.map(entry => entry.path)).toEqual(['src/index.ts']);
        expect(fixture.requests).toContainEqual(expect.objectContaining({
            targetId: fixture.scope.machineId, method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
            payload: expect.objectContaining({ cwd: fixture.scope.rootPath }),
        }));
    });

    it('reads uncontrolled expansion from workspace storage and persists row toggles', async () => {
        const screen = await renderBrowser();
        await screen.pressByTestIdAsync(rowId('src'));
        expect(fixture.storage.getState().getWorkspaceRepositoryTreeExpandedPaths(fixture.scope)).toEqual([]);
        expect(screen.findHostByTestId(rowId('src/index.ts'))).toBeNull();
        await screen.pressByTestIdAsync(rowId('src'));
        await vi.waitFor(() => expect(screen.findHostByTestId(rowId('src/index.ts'))).not.toBeNull());
        expect(fixture.storage.getState().getWorkspaceRepositoryTreeExpandedPaths(fixture.scope)).toEqual(['src']);
    });

    it('routes the default row download to the addressed Machine through the real transfer owner', async () => {
        const screen = await renderBrowser();
        await screen.pressByTestIdAsync(`repository-tree-row-menu-${toTestIdSafeValue('src/index.ts')}`);
        const download = screen.findByTestId('repository-tree-menuitem-download');
        expect(download).not.toBeNull();
        expect(download?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('repository-tree-menuitem-download');
        await vi.waitFor(() => expect(fixture.requests).toContainEqual(expect.objectContaining({
            targetId: fixture.scope.machineId, method: 'daemon.filesystem.download',
            payload: expect.objectContaining({ rootPath: '/repo', path: '/repo/src/index.ts', asZip: false }),
        })));
    });
});
