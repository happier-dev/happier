import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import type { WorkspaceCodeLocation } from './WorkspaceCodeBrowserView';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

installSessionFilesViewBoundaries();
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));

const { WorkspaceCodeBrowserView } = await import('./WorkspaceCodeBrowserView');
const { WorkspaceFileDetailsView } = await import('@/components/workspaces/files/details/WorkspaceFileDetailsView');

describe('Code consumes the qualified browser and real entry-history batch', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
    beforeAll(prepareSessionFilesViewTestkit);
    afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

    it('shows the Code aside with folder entries without inserting it above the bounded file reader', async () => {
        const rootPath = '/code-aside-consumer';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: rootPath, truncated: false,
                entries: [{ name: 'LICENSE', path: `${rootPath}/LICENSE`, type: 'file' }] };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const { Text } = await import('react-native');
        const renderPage = (location: WorkspaceCodeLocation) => <WorkspaceCodeBrowserView paneScopeId="code-aside-test"
            scope={fixture!.scope} rootLabel="Code" location={location} onNavigate={() => {}} history={null}
            aside={<Text testID="accepted-code-aside">Checkout widgets</Text>} />;
        const screen = await fixture.render(renderPage({ path: '', kind: 'folder' }));
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-LICENSE')).toBeTruthy());
        expect(screen.findByTestId('accepted-code-aside')).not.toBeNull();
        await screen.update(fixture.wrap(renderPage({ path: 'LICENSE', kind: 'file' })));
        expect(screen.findByTestId('accepted-code-aside')).toBeNull();
        expect(screen.findByTestId('workspace-code-columns')).toBeNull();
        const reader = screen.root.findByType(WorkspaceFileDetailsView);
        expect(reader.props).toMatchObject({ scope: fixture.scope, filePath: 'LICENSE', presentation: 'screen' });
        expect(screen.findByTestId('workspace-code')?.props.scrollEnabled).toBe(false);
    });

    it('discloses inline without navigating, navigates by real entry kind, and demands the actual folder', async () => {
        const rootPath = '/code-consumer-browser';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
                const path = (request.payload as { path: string }).path;
                const folderPath = `${rootPath}/nested`;
                return { ok: true, path, truncated: false, entries: path === folderPath ? [
                    { name: 'folder.ts', path: `${path}/folder.ts`, type: 'directory' },
                    { name: 'LICENSE', path: `${path}/LICENSE`, type: 'file' },
                    { name: 'name ', path: `${path}/name `, type: 'file' },
                    { name: ' leading', path: `${path}/ leading`, type: 'file' },
                    { name: 'line\nbreak ', path: `${path}/line\nbreak `, type: 'directory' },
                ] : path === `${folderPath}/folder.ts` ? [{ name: 'child', path: `${path}/child`, type: 'file' }] : [] };
            }
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) {
                const input = request.payload as { paths: string[] };
                return { success: true, headOid: 'a'.repeat(40), entries: input.paths.map(path => ({ path, kind: 'commit', commit: {
                    oid: 'b'.repeat(40), subject: `touch ${path}`, authorName: 'Verified transport author', committedAt: 1000,
                } })) };
            }
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const onNavigate = vi.fn<(location: WorkspaceCodeLocation) => void>();
        const rowId = (path: string) => `repository-tree-row-${toTestIdSafeValue(path)}`;
        const screen = await fixture.render(<WorkspaceCodeBrowserView paneScopeId="code-test" scope={fixture.scope} rootLabel="Code"
            location={{ path: 'nested', kind: 'folder' }} onNavigate={onNavigate} presentation="widget" />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('touch nested/LICENSE'));
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_HISTORY_ENTRIES).every(request => {
            const payload = request.payload as { folder: string; paths: string[] };
            return payload.folder === 'nested' && !payload.paths.includes('');
        })).toBe(true);
        await screen.pressByTestIdAsync(`${rowId('nested/folder.ts')}-disclosure`);
        await vi.waitFor(() => expect(screen.findByTestId(rowId('nested/folder.ts/child'))).toBeTruthy());
        expect(onNavigate).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync(rowId('nested/folder.ts'));
        expect(onNavigate).toHaveBeenLastCalledWith({ path: 'nested/folder.ts', kind: 'folder' });
        await screen.pressByTestIdAsync(rowId('nested/LICENSE'));
        expect(onNavigate).toHaveBeenLastCalledWith({ path: 'nested/LICENSE', kind: 'file' });
        for (const name of ['name ', ' leading', 'line\nbreak ']) {
            await screen.pressByTestIdAsync(rowId(`nested/${name}`));
            expect(onNavigate).toHaveBeenLastCalledWith({ path: `nested/${name}`, kind: name === 'line\nbreak ' ? 'folder' : 'file' });
        }
        await vi.waitFor(() => expect(fixture!.requests.some(request => request.method === RPC_METHODS.SCM_HISTORY_ENTRIES
            && (request.payload as { paths: string[] }).paths.includes('nested/name '))).toBe(true));
    });

    it('keeps an inaccessible directory unavailable even when history reports no commits', async () => {
        const rootPath = '/unavailable-code-consumer';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: false, error: 'EACCES' };
            if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: null, entries: [{ path: '', kind: 'none' }] };
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const screen = await fixture.render(<WorkspaceCodeBrowserView paneScopeId="code-test" scope={fixture.scope} rootLabel="Code"
            location={{ path: '', kind: 'folder' }} onNavigate={() => {}} presentation="widget" />);
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-root-error')).toBeTruthy());
        expect(fixture.requests.some(request => request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY)).toBe(true);
        expect(screen.findByTestId('workspace-code-empty-repository')).toBeNull();
    });
});
