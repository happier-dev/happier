import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

// The retained host imports the recycler before runtime boundary installation.
// Its native viewport is absent here, so install the canonical SDK boundary before static imports.
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(), emitViewability: true }).module;
});
installSessionFilesViewBoundaries();
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const { ProjectCockpitShell } = await import('./ProjectCockpitShell');

describe('the mounted Project Code destination', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
    beforeAll(prepareSessionFilesViewTestkit);
    afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

    it('pushes literal folder/file locations, restores route Back/up, and opens qualified History', async () => {
        const rootPath = '/project-code-route';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
                const path = (request.payload as { path: string }).path;
                return { ok: true, path, truncated: false, entries: path === rootPath
                    ? [{ name: 'dir.with.dot', path: `${path}/dir.with.dot`, type: 'directory' }]
                    : [{ name: 'LICENSE', path: `${path}/LICENSE`, type: 'file' }] };
            }
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            if (request.method === RPC_METHODS.SCM_HISTORY_ENTRIES) return { success: true, headOid: 'a'.repeat(40),
                entries: (request.payload as { paths: string[] }).paths.map(path => ({ path, kind: 'commit', commit: {
                    oid: 'b'.repeat(40), subject: `touch ${path}`, authorName: 'Author', committedAt: 1000,
                } })) };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const navigations: string[] = [];
        const ref = { id: 'code-project', ...fixture.scope, label: 'Code', createdAtMs: 1 };
        function PaneProbe() {
            const pane = useAppPaneScope('project-code-route');
            return React.createElement('CodePaneProbe', { details: pane.scopeState?.details });
        }
        const renderLocation = (params: Record<string, string> = {}) => <DestinationInstanceHost tabId="code-route"
            ref={{ kind: 'project', params: { workspaceRefId: ref.id, serverId: ref.serverId, ...params } }}
            pathname={`/projects/${ref.id}/code`} focused visible navigation={{ push: href => navigations.push(String(href)),
                replace: () => {}, back: () => {}, setParams: () => {} }}>
            <ProjectCockpitShell workspaceRef={ref} scopeId="project-code-route" activeRootPath={rootPath}
                surface="code" isFocused onSelectRootPath={() => {}} />
            <PaneProbe />
        </DestinationInstanceHost>;
        const screen = await fixture.render(renderLocation());
        const folderRow = `repository-tree-row-${toTestIdSafeValue('dir.with.dot')}`;
        await vi.waitFor(() => expect(screen.findByTestId(folderRow)).toBeTruthy());
        await screen.pressByTestIdAsync(folderRow);
        expect(navigations).toHaveLength(1);
        const folderUrl = new URL(navigations[0]!, 'https://happier.test');
        expect(folderUrl.pathname).toBe('/projects/code-project/code');
        expect(Object.fromEntries(folderUrl.searchParams)).toMatchObject({ serverId: ref.serverId, codePath: 'dir.with.dot', codeKind: 'folder' });
        await screen.update(fixture.wrap(renderLocation(Object.fromEntries(folderUrl.searchParams))));
        const fileRow = `repository-tree-row-${toTestIdSafeValue('dir.with.dot/LICENSE')}`;
        await vi.waitFor(() => expect(screen.findByTestId(fileRow)).toBeTruthy());
        await screen.pressByTestIdAsync(fileRow);
        const fileUrl = new URL(navigations.at(-1)!, 'https://happier.test');
        expect(Object.fromEntries(fileUrl.searchParams)).toMatchObject({ codePath: 'dir.with.dot/LICENSE', codeKind: 'file' });
        expect(fileUrl.searchParams.has('initialFile')).toBe(false);
        await screen.update(fixture.wrap(renderLocation(Object.fromEntries(fileUrl.searchParams))));
        expect(screen.findByTestId('workspace-code-file')).toBeTruthy();
        expect(screen.root.findByType('CodePaneProbe').props.details?.isOpen).not.toBe(true);
        await vi.waitFor(() => expect(screen.findByTestId('workspace-code-strip-history')).toBeTruthy());
        await screen.pressByTestIdAsync('workspace-code-strip-history');
        expect(new URL(navigations.at(-1)!, 'https://happier.test').pathname).toBe('/projects/code-project/changes');
        // The browser Back owner returns the preceding retained route; Code must consume it.
        await screen.update(fixture.wrap(renderLocation(Object.fromEntries(folderUrl.searchParams))));
        expect(screen.findByTestId('workspace-code-file')).toBeNull();
        await vi.waitFor(() => expect(screen.findByTestId(fileRow)).toBeTruthy());
        await screen.pressByTestIdAsync('workspace-code-bar-crumb-0');
        expect(new URL(navigations.at(-1)!, 'https://happier.test').searchParams.get('codePath')).toBe('');
    });

    it('keeps the built Code tree when the Project returns to Code from another page', async () => {
        const rootPath = '/project-code-retained';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY) {
                const path = (request.payload as { path: string }).path;
                return { ok: true, path, truncated: false, entries: [{ name: 'src', path: `${path}/src`, type: 'directory' }] };
            }
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath }) };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const ref = { id: 'code-retained', ...fixture.scope, label: 'Code', createdAtMs: 1 };
        const renderPage = (surface: 'code' | 'scripts') => <DestinationInstanceHost tabId="code-retained"
            ref={{ kind: 'project', params: { workspaceRefId: ref.id, serverId: ref.serverId } }}
            pathname={`/projects/${ref.id}/${surface}`} focused visible navigation={{ push: () => {},
                replace: () => {}, back: () => {}, setParams: () => {} }}>
            <ProjectCockpitShell workspaceRef={ref} scopeId="project-code-retained" activeRootPath={rootPath}
                surface={surface} isFocused onSelectRootPath={() => {}} />
        </DestinationInstanceHost>;
        const row = `repository-tree-row-${toTestIdSafeValue('src')}`;
        // A remounted tree creates new host nodes for its rows; a kept tree shows the ones it built.
        const rowNode = () => (screen.findHostByTestId(row) as unknown as { _fiber: { stateNode: object } } | null)?._fiber.stateNode;
        const screen = await fixture.render(renderPage('code'));
        await vi.waitFor(() => expect(rowNode()).toBeTruthy());
        const builtRows = new Set([rowNode()]);
        // Secure credential storage is the boundary: a kept tree keeps its Home resolution too, instead of
        // reading the credential again (and drawing its Machine as unknown meanwhile) on every return.
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentialReads = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        for (let visit = 0; visit < 2; visit += 1) {
            await screen.update(fixture.wrap(renderPage('scripts')));
            await screen.update(fixture.wrap(renderPage('code')));
            await vi.waitFor(() => expect(rowNode()).toBeTruthy());
            builtRows.add(rowNode());
        }
        const revisitCredentialReads = credentialReads.mock.calls.length;
        credentialReads.mockRestore();
        expect({ builtRows: builtRows.size, revisitCredentialReads }).toEqual({ builtRows: 1, revisitCredentialReads: 0 });
    });
    it('keeps the built Changes review when the Project returns to Changes from another page', async () => {
        const rootPath = '/project-changes-retained';
        const entries = Array.from({ length: 3 }, (_, index) => ({ path: `src/change-${index}.ts`,
            previousPath: null, kind: 'modified' as const, includeStatus: '', pendingStatus: 'M',
            hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 1, isBinary: false } }));
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) return { success: true, snapshot: fileViewSnapshot({ rootPath, entries }) };
            return { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable boundary operation' };
        } });
        const ref = { id: 'changes-retained', ...fixture.scope, label: 'Changes', createdAtMs: 1 };
        const renderPage = (surface: 'changes' | 'scripts') => <DestinationInstanceHost tabId="changes-retained"
            ref={{ kind: 'project', params: { workspaceRefId: ref.id, serverId: ref.serverId } }}
            pathname={`/projects/${ref.id}/${surface}`} focused visible navigation={{ push: () => {},
                replace: () => {}, back: () => {}, setParams: () => {} }}>
            <ProjectCockpitShell workspaceRef={ref} scopeId="project-changes-retained" activeRootPath={rootPath}
                surface={surface} isFocused onSelectRootPath={() => {}} />
        </DestinationInstanceHost>;
        // A rebuilt Review creates a new list host; a kept one shows the list (and its 59k-row model) it built.
        const listNode = () => (screen.findHostByTestId('scm-review-list') as unknown as { _fiber: { stateNode: object } } | null)?._fiber.stateNode;
        const screen = await fixture.render(renderPage('changes'));
        await vi.waitFor(() => expect(listNode()).toBeTruthy());
        const builtLists = new Set([listNode()]);
        for (let visit = 0; visit < 2; visit += 1) {
            await screen.update(fixture.wrap(renderPage('scripts')));
            await screen.update(fixture.wrap(renderPage('changes')));
            await vi.waitFor(() => expect(listNode()).toBeTruthy());
            builtLists.add(listNode());
        }
        expect(builtLists.size).toBe(1);
    });
});
