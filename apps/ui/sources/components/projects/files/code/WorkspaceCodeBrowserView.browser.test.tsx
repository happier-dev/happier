import * as React from 'react';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import type { WorkspaceCodeLocation } from './WorkspaceCodeBrowserView';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import type { CapturingLegendListMockState } from '@/dev/testkit/mocks/legendList';

let recycler: CapturingLegendListMockState;
installSessionFilesViewBoundaries({ renderItemLimit: 8, onRecycler: state => { recycler = state; } });
// Leaf mock modules, not the testkit index: a factory awaiting the index (which reaches '@/text') deadlocks collection.
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const { WorkspaceCodeBrowserView } = await import('./WorkspaceCodeBrowserView');
const { WorkspaceFileDetailsView } = await import('@/components/workspaces/files/details/WorkspaceFileDetailsView');

describe('Code consumes the qualified browser and real entry-history batch', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
    beforeAll(prepareSessionFilesViewTestkit);
    afterEach(async () => { standardCleanup(); vi.useRealTimers(); await fixture?.dispose(); });

    it.each([500, 501])('keeps all admitted entries and the completeness fact for a %i-file directory', async (count) => {
        const rootPath = `/code-listing-${count}`;
        const files = Array.from({ length: count }, (_, index) => ({ name: `f${String(index + 1).padStart(4, '0')}.txt`,
            path: `${rootPath}/f${String(index + 1).padStart(4, '0')}.txt`, type: 'file', size: 1 }));
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: rootPath,
                truncated: count > 500, entries: files.slice(0, 500) };
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: 'a'.repeat(40), entries: [] };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        await fixture.render(<WorkspaceCodeBrowserView paneScopeId={`code-listing-test-${count}`} scope={fixture.scope}
            rootLabel="Code" location={{ path: '', kind: 'folder' }} onNavigate={() => {}} onOpenFile={() => {}} />);
        await vi.waitFor(() => {
            const nodes: readonly { type: string; name: string; infoKind?: string; entryCount?: number }[] = recycler.props.data;
            expect(nodes.filter(node => node.type === 'file')).toHaveLength(500);
            expect(nodes.filter(node => node.type === 'file').at(-1)?.name).toBe('f0500.txt');
            expect(nodes.filter(node => node.type === 'info')).toEqual(count > 500
                ? [expect.objectContaining({ infoKind: 'truncated', entryCount: 500 })] : []);
        });
    });

    it('presents the existing directory incompleteness notice through the real Code tree', async () => {
        const rootPath = '/code-truncated-folder';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: rootPath,
                truncated: true, entries: [{ name: 'first.txt', path: `${rootPath}/first.txt`, type: 'file' }] };
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: 'a'.repeat(40), entries: [] };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const screen = await fixture.render(<WorkspaceCodeBrowserView paneScopeId="code-truncated-test" scope={fixture.scope}
            rootLabel="Code" location={{ path: '', kind: 'folder' }} onNavigate={() => {}} onOpenFile={() => {}} />);
        await vi.waitFor(() => expect(screen.root.findAllByProps({ title: 'newSession.pathPicker.truncatedDirectoryInfo' }).length).toBeGreaterThan(0));
    });

    it('mounts and demands only the large folder viewport, then reveals an off-screen row through the shared keyboard owner', async () => {
        const rootPath = '/code-large-folder';
        const entries = [...Array.from({ length: 1000 }, (_, index) => ({ name: `file-${String(index).padStart(4, '0')}.ts`,
            path: `${rootPath}/file-${String(index).padStart(4, '0')}.ts`, type: 'file' })),
            { name: 'README.md', path: `${rootPath}/README.md`, type: 'file' }];
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: rootPath, truncated: false, entries };
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: 'a'.repeat(40),
                entries: (request.payload as { paths: string[] }).paths.map(path => ({ path, kind: 'none' })) };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const onVisibleEntriesChange = vi.fn();
        const page = (revealRequest?: Readonly<{ path: string }>) => <WorkspaceCodeBrowserView paneScopeId="code-large-test" scope={fixture!.scope}
            rootLabel="Code" location={{ path: '', kind: 'folder' }} onNavigate={() => {}} onOpenFile={() => {}} revealRequest={revealRequest}
            onVisibleEntriesChange={onVisibleEntriesChange} />;
        const screen = await fixture.render(page());
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-file-0000.ts')).toBeTruthy());
        const mountedRows = screen.root.findAll(node => typeof node.type === 'string' && /^repository-tree-row-file-\d{4}\.ts$/.test(String(node.props.testID ?? '')));
        expect(mountedRows).toHaveLength(8);
        const list = screen.root.findByType('LegendList');
        expect(list.findAll(node => node.props.testID === 'workspace-code-readme').length).toBeGreaterThan(0);
        const visiblePaths = entries.slice(0, 8).map(entry => entry.name);
        await vi.waitFor(() => expect(onVisibleEntriesChange).toHaveBeenLastCalledWith(visiblePaths));
        await vi.waitFor(() => expect(fixture!.requests.some(request => request.method === RPC_METHODS.SCM_HISTORY_ENTRIES
            && (request.payload as { paths: string[] }).paths.length === 9)).toBe(true));
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_HISTORY_ENTRIES)
            .every(request => (request.payload as { paths: string[] }).paths.every(path => path === '' || visiblePaths.includes(path)))).toBe(true);

        recycler.refHandle.scrollToIndex.mockClear();
        await screen.update(fixture.wrap(page({ path: entries[900].name })));
        await vi.waitFor(() => expect(recycler.refHandle.scrollToIndex).toHaveBeenCalledWith({ index: 900, animated: false }));
        const revealed = recycler.props.data[900];
        await act(async () => recycler.props.onViewableItemsChanged({ viewableItems: [{ item: revealed, index: 900,
            key: `file:${revealed.path}`, isViewable: true }], changed: [] }));
        await vi.waitFor(() => expect(onVisibleEntriesChange).toHaveBeenLastCalledWith([entries[900].name]));
        await vi.waitFor(() => expect(fixture!.requests.some(request => request.method === RPC_METHODS.SCM_HISTORY_ENTRIES
            && (request.payload as { paths: string[] }).paths.includes(entries[900].name))).toBe(true));
    });

    // Owner 11-15 (MOBILE-FIX-1115 H4): an offline Machine's Code card kept an empty body under its header (58 px web,
    // ~72 pt iOS). With nothing ever listed, the widget keeps only its header; the page's line says why.
    it('draws no tree in the Overview widget while its Machine is offline and nothing was listed', async () => {
        const rootPath = '/code-widget-offline';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: () => ({ success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' }) });
        const screen = await fixture.render(<WorkspaceCodeBrowserView paneScopeId="code-widget-offline" scope={fixture.scope}
            rootLabel="Code" location={{ path: '', kind: 'folder' }} onNavigate={() => {}} onOpenFile={() => {}} presentation="widget" />);
        await act(async () => {
            fixture!.storage.getState().applyMachineActivityUpdates([
                { id: fixture!.scope.machineId, active: false, activeAt: Date.now() },
            ], { sourceServerId: fixture!.scope.serverId });
        });
        await vi.waitFor(() => expect(screen.findHostByTestId('workspace-code-offline')).toBeTruthy());
        expect(screen.findHostByTestId('repository-tree-drop-zone')).toBeNull();
        expect(screen.findHostByTestId('workspace-code-table')).toBeNull();
    });

    it('retires history and filesystem effects on pushed presence withdrawal without replacing the Machine row', async () => {
        const rootPath = '/code-presence-expiry';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: rootPath, truncated: false,
                entries: [{ name: 'LICENSE', path: `${rootPath}/LICENSE`, type: 'file' }] };
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: 'a'.repeat(40),
                entries: (request.payload as { paths: string[] }).paths.map(path => ({ path, kind: 'none' })) };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const screen = await fixture.render(<WorkspaceCodeBrowserView paneScopeId="code-presence-test" scope={fixture.scope}
            rootLabel="Code" location={{ path: '', kind: 'folder' }} onNavigate={() => {}} onOpenFile={() => {}} />);
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-LICENSE')).toBeTruthy());
        expect(screen.findByTestId('workspace-code-offline')).toBeNull();
        const readsBeforeExpiry = fixture.requests.filter(request => request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY
            || request.method === RPC_METHODS.SCM_HISTORY_ENTRIES).length;
        await act(async () => { vi.advanceTimersByTime(60_001); });
        // The server owns presence expiry; elapsed client time cannot withdraw it.
        expect(screen.findHostByTestId('workspace-code-offline')).toBeNull();
        await act(async () => {
            fixture!.storage.getState().applyMachineActivityUpdates([
                { id: fixture!.scope.machineId, active: false, activeAt: Date.now() },
            ], { sourceServerId: fixture!.scope.serverId });
        });
        // Said once, by the Code page: the folder and its history don't repeat the cause.
        expect(screen.findHostByTestId('workspace-code-offline')).toBeTruthy();
        expect(screen.findHostByTestId('repository-tree-offline')).toBeNull();
        expect(screen.findHostByTestId('workspace-code-history-stale')).toBeNull();
        expect(screen.findByTestId('repository-tree-row-LICENSE')).toBeTruthy();
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY
            || request.method === RPC_METHODS.SCM_HISTORY_ENTRIES)).toHaveLength(readsBeforeExpiry);
    });

    it('is one column: folder entries, then the bounded file reader in their place', async () => {
        const rootPath = '/code-aside-consumer';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: rootPath, truncated: false,
                entries: [{ name: 'LICENSE', path: `${rootPath}/LICENSE`, type: 'file' }] };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        // Go to file is quick open (P3 §3.6): the page hands Search its own workspace, Files scope.
        const searchRuntime = { open: vi.fn(), buildCommands: () => [] };
        const renderPage = (location: WorkspaceCodeLocation) => <UniversalSearchRuntimeProvider value={searchRuntime}>
            <WorkspaceCodeBrowserView paneScopeId="code-aside-test"
                scope={fixture!.scope} rootLabel="Code" location={location} onNavigate={() => {}} onOpenFile={() => {}} history={null} />
        </UniversalSearchRuntimeProvider>;
        const screen = await fixture.render(renderPage({ path: '', kind: 'folder' }));
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-LICENSE')).toBeTruthy());
        await screen.pressByTestIdAsync('workspace-code-bar-goto');
        expect(searchRuntime.open).toHaveBeenCalledWith(undefined, expect.objectContaining({ ...fixture.scope, sessionId: null }), { source: 'files' });
        await screen.update(fixture.wrap(renderPage({ path: 'LICENSE', kind: 'file' })));
        const reader = screen.root.findByType(WorkspaceFileDetailsView);
        expect(reader.props).toMatchObject({ scope: fixture.scope, filePath: 'LICENSE', presentation: 'screen' });
        expect(screen.findByTestId('workspace-code-bar-goto')).toBeTruthy();
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
        const onOpenFile = vi.fn<(path: string) => void>();
        const rowId = (path: string) => `repository-tree-row-${toTestIdSafeValue(path)}`;
        const screen = await fixture.render(<WorkspaceCodeBrowserView paneScopeId="code-test" scope={fixture.scope} rootLabel="Code"
            location={{ path: 'nested', kind: 'folder' }} onNavigate={onNavigate} onOpenFile={onOpenFile} presentation="widget" />);
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
        expect(onOpenFile).toHaveBeenLastCalledWith('nested/LICENSE');
        for (const name of ['name ', ' leading', 'line\nbreak ']) {
            await screen.pressByTestIdAsync(rowId(`nested/${name}`));
            if (name === 'line\nbreak ') expect(onNavigate).toHaveBeenLastCalledWith({ path: `nested/${name}`, kind: 'folder' });
            else expect(onOpenFile).toHaveBeenLastCalledWith(`nested/${name}`);
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
            location={{ path: '', kind: 'folder' }} onNavigate={() => {}} onOpenFile={() => {}} presentation="widget" />);
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-root-error')).toBeTruthy());
        expect(fixture.requests.some(request => request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY)).toBe(true);
        expect(screen.findByTestId('workspace-code-empty-repository')).toBeNull();
    });
    it('waits for the repository read instead of calling history unavailable, and holds the rows of a listing in flight', async () => {
        const rootPath = '/code-pending-consumer';
        let answerSnapshot: (value: unknown) => void = () => {};
        let answerListing: (value: unknown) => void = () => {};
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return new Promise(resolve => { answerListing = resolve; });
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return new Promise(resolve => { answerSnapshot = resolve; });
            if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: 'a'.repeat(40),
                entries: (request.payload as { paths: string[] }).paths.map(path => ({ path, kind: 'none' })) };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const screen = await fixture.render(<WorkspaceCodeBrowserView paneScopeId="code-pending-test" scope={fixture.scope}
            rootLabel="Code" location={{ path: '', kind: 'folder' }} onNavigate={() => {}} onOpenFile={() => {}} />);
        await vi.waitFor(() => expect(screen.findHostByTestId('workspace-code-listing-pending')).toBeTruthy());
        expect(screen.findHostByTestId('workspace-code-strip-pending')).toBeTruthy();
        expect(screen.findHostByTestId('workspace-code-strip-unavailable')).toBeNull();
        await act(async () => {
            answerListing({ ok: true, path: rootPath, truncated: false, entries: [{ name: 'LICENSE', path: `${rootPath}/LICENSE`, type: 'file' }] });
            answerSnapshot({ success: true, snapshot: fileViewSnapshot({ rootPath }) });
        });
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-LICENSE')).toBeTruthy());
        expect(screen.findHostByTestId('workspace-code-listing-pending')).toBeNull();
        await vi.waitFor(() => expect(screen.findHostByTestId('workspace-code-strip-none')).toBeTruthy());
        // The strip says "No commits yet" once; no row repeats it.
        expect(screen.findHostByTestId('workspace-code-history-LICENSE')).toBeNull();
        expect(screen.root.findAll(node => node.props.children === 'projects.code.noEntryCommit')).toHaveLength(0);
    });
    it('previews a large folder in the Overview widget: the first rows, every entry counted, the way into Code', async () => {
        const rootPath = '/code-widget-preview';
        const entries = Array.from({ length: 64 }, (_, index) => ({ name: `entry-${String(index).padStart(2, '0')}`,
            path: `${rootPath}/entry-${String(index).padStart(2, '0')}`, type: 'file' }));
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: rootPath, truncated: false, entries };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const screen = await fixture.render(<WorkspaceCodeBrowserView paneScopeId="code-widget-test" scope={fixture.scope}
            rootLabel="Code" location={{ path: '', kind: 'folder' }} onNavigate={() => {}} onOpenFile={() => {}} history={null}
            presentation="widget" onOpenInCode={() => {}} />);
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-entry-00')).toBeTruthy());
        // The list holds the preview only, not 64 rows behind a short viewport.
        await vi.waitFor(() => expect(recycler.props.data.map((node: { path: string }) => node.path)).toEqual(entries.slice(0, 8).map(entry => entry.name)));
        expect(screen.findByTestId('workspace-code-footer')).toBeTruthy();
        expect(screen.findByTestId('workspace-code-footer-open')).toBeTruthy();
    });
    it('stacks rows on a narrow table so names keep their width, and keeps columns on a wide one', async () => {
        const rootPath = '/code-narrow-rows';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: rootPath, truncated: false,
                entries: [{ name: 'apps', path: `${rootPath}/apps`, type: 'directory' }] };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const commit = { kind: 'commit' as const, commit: { oid: 'a'.repeat(40), subject: 'Add apps', authorName: 'Ada', committedAt: 0 } };
        const history = { current: commit, entry: () => commit, revision: 1 };
        const screen = await fixture.render(<WorkspaceCodeBrowserView paneScopeId="code-narrow-test" scope={fixture.scope}
            rootLabel="Code" location={{ path: '', kind: 'folder' }} onNavigate={() => {}} onOpenFile={() => {}} history={history}
            presentation="widget" onOpenInCode={() => {}} />);
        await vi.waitFor(() => expect(screen.findByTestId('repository-tree-row-apps')).toBeTruthy());
        const layoutOf = () => screen.root.findAll(node => node.props.testID === 'workspace-code-history-apps' && typeof node.props.layout === 'string')[0]?.props.layout;
        const measure = async (width: number) => {
            const table = screen.root.findAll(node => node.props.testID === 'workspace-code-table' && typeof node.props.onLayout === 'function')[0]!;
            await act(async () => { table.props.onLayout({ nativeEvent: { layout: { width, height: 300, x: 0, y: 0 } } }); });
        };
        await measure(360);
        // A narrow widget column: time beside the name, subject beneath it.
        await vi.waitFor(() => expect(layoutOf()).toBe('time'));
        await measure(900);
        await vi.waitFor(() => expect(layoutOf()).toBe('columns'));
    });
    it('Refresh re-reads the README after a same-path edit, and a failed README read recovers through Retry', async () => {
        const rootPath = '/code-readme-refresh';
        let readme: { success: true; content: string } | { success: false; error: string } = { success: false, error: 'EIO' };
        fixture = await createSessionFilesViewFixture({ rootPath, serverIdentityId: 'srv_code_readme_refresh', rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) return { ok: true, path: rootPath, truncated: false,
                entries: [{ name: 'README.md', path: `${rootPath}/README.md`, type: 'file' }] };
            if (request.method === 'daemon.filesystem.readFile') return readme;
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const screen = await fixture.render(<WorkspaceCodeBrowserView paneScopeId="code-readme-test" scope={fixture.scope}
            rootLabel="Code" location={{ path: '', kind: 'folder' }} onNavigate={() => {}} onOpenFile={() => {}} history={null} />);
        const readmeText = () => screen.root.findAll(node => node.props.testID === 'workspace-code-readme-markdown'
            && typeof node.props.markdown === 'string')[0]?.props.markdown;
        // A failed first read offers the shared Retry, and Retry recovers.
        await vi.waitFor(() => expect(screen.findByTestId('workspace-code-readme-error-action')).toBeTruthy());
        // The error must come from this Machine's real read, not failed Action admission.
        expect(fixture.requests).toContainEqual(expect.objectContaining({
            targetId: fixture.scope.machineId, method: 'daemon.filesystem.readFile',
            payload: expect.objectContaining({ rootPath, path: `${rootPath}/README.md` }),
        }));
        readme = { success: true, content: btoa('First version') };
        await screen.pressByTestIdAsync('workspace-code-readme-error-action');
        await vi.waitFor(() => expect(readmeText()).toBe('First version'));
        // Same path, new text outside the app: the page's Refresh reads it again.
        readme = { success: true, content: btoa('Second version') };
        // The page's Refresh (View menu → Refresh) is the one refresh for the folder, its history and its README.
        const viewMenu = screen.root.findAll(node => node.props.testID === 'workspace-repository-tree-view-menu' && typeof node.props.onSelect === 'function')[0]!;
        await act(async () => { viewMenu.props.onSelect('workspace-repository-tree-refresh'); });
        await vi.waitFor(() => expect(readmeText()).toBe('Second version'));
    });
});
