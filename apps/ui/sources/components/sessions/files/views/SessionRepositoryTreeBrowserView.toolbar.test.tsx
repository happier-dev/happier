import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));

describe('Session shared browser View menu refresh', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
    beforeAll(prepareSessionFilesViewTestkit);
    afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

    it('shows loading in the View trigger, then refreshes real directory rows in place', async () => {
        let release: ((response: unknown) => void) | undefined;
        let version = 0;
        const rootPath = '/session-toolbar-browser';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
                if (version === 0) return new Promise(resolve => { release = resolve; });
                return { ok: true, path: rootPath, truncated: false, entries: [{ name: 'new.txt', path: `${rootPath}/new.txt`, type: 'file' }] };
            }
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        fixture.setSnapshot(fileViewSnapshot({ rootPath }));
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const { WorkspaceRepositoryTreeList } = await import('@/components/projects/files/WorkspaceRepositoryTreeList');
        const screen = await fixture.render(<SessionRepositoryTreeBrowserView sessionId="s1" serverId={fixture.scope.serverId} onOpenFile={() => {}} />);
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        expect(screen.findByTestId('repository-tree-refresh-loading')).toBeTruthy();
        await act(async () => release?.({ ok: true, path: rootPath, truncated: false, entries: [{ name: 'old.txt', path: `${rootPath}/old.txt`, type: 'file' }] }));
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-old.txt')).toBeTruthy());
        expect(screen.findByTestId('repository-tree-refresh-loading')).toBeNull();
        const tree = screen.findByType(WorkspaceRepositoryTreeList);
        await screen.pressByTestIdAsync('repository-tree-view');
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-refresh')).toBeTruthy());
        expect(screen.findByTestId('repository-tree-collapse-all')).toBeNull();
        version = 1;
        await screen.pressByTestIdAsync('repository-tree-refresh');
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-new.txt')).toBeTruthy());
        expect(screen.findByTestId('repository-tree-row-old.txt')).toBeNull();
        expect(screen.findByType(WorkspaceRepositoryTreeList)).toBe(tree);
    });
});
