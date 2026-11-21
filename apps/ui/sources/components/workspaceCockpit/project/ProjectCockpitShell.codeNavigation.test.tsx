import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { resolveHref } from 'expo-router/build/link/href';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { registerMountedWorkspaceAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { createWorkspaceActionAdapter } from '@/components/appShell/workspace/workspaceActions';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';

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
const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');

describe('the mounted Project Code destination', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
    let unregisterWorkspace: (() => void) | undefined;
    beforeAll(prepareSessionFilesViewTestkit);
    afterEach(async () => { unregisterWorkspace?.(); unregisterWorkspace = undefined; standardCleanup(); await fixture?.dispose(); });

    it('pushes literal folder/file locations, restores route Back/up, and opens qualified History', async () => {
        const rootPath = '/project-code-route';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.LIST_DIRECTORY) {
                const path = (request.payload as { path: string }).path;
                return { success: true, truncated: false, entries: path === rootPath
                    ? [{ name: 'dir.with.dot', type: 'directory' }]
                    : [{ name: 'LICENSE', type: 'file' }] };
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
        applyProjectAccountRowsFixture(fixture.storage, { workspaceRefs: [ref] });
        let state = createWorkspaceState({ id: 'code-route', target: { kind: 'project', params: {
            workspaceRefId: ref.id, serverId: ref.serverId,
        } }, pinned: false, preview: false });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false,
            inbox: true, workflows: false, friends: false } });
        let nextId = 0;
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: action => { state = reduceWorkspaceState(state, action); }, createId: () => `code:${++nextId}`,
            onChange: () => {},
            // Browser history is the boundary; real Action policy, navigation and reducers remain mounted.
            transport: { commit: (href) => { navigations.push(href); } },
        });
        navigation.initialize(`/projects/${ref.id}/code?serverId=${ref.serverId}`);
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null,
            createId: () => `code:${++nextId}` });
        unregisterWorkspace = registerMountedWorkspaceAction(request => execute(request.actionId, request.input));
        const browserNavigation: DestinationNavigation = { push: href => {
            navigation.openHref(resolveHref(href));
        }, replace: href => {
            navigation.openHref(resolveHref(href), { replace: true });
        }, back: () => { navigation.step(-1); }, setParams: params => {
            navigation.setParams('code-route', params);
        } };
        const workspaceNavigation: WorkspaceNavigationContextValue = { active: true, get state() { return state; },
            canGoBack: false, canGoForward: false, openHref: (href, options) => navigation.openHref(href, options),
            activateTab: (groupId, tabId) => navigation.activateTab(groupId, tabId),
            closeTab: (groupId, tabId) => navigation.closeTab(groupId, tabId),
            closeTabs: (groupId, tabIds) => navigation.closeTabs(groupId, tabIds), dispatch: action => navigation.dispatch(action),
            navigationForTab: () => browserNavigation, registerBackStep: () => () => {},
            back: browserNavigation.back, forward: () => { navigation.step(1); } };
        function PaneProbe() {
            const pane = useAppPaneScope('project-code-route');
            return React.createElement('CodePaneProbe', { details: pane.scopeState?.details });
        }
        const renderLocation = (params: Record<string, string> = {}) => <WorkspaceNavigationProvider value={workspaceNavigation}><DestinationInstanceHost tabId="code-route"
            ref={{ kind: 'project', params: { workspaceRefId: ref.id, serverId: ref.serverId, ...params } }}
            pathname={`/projects/${ref.id}/code`} focused visible navigation={{ push: href => navigations.push(String(href)),
                replace: () => {}, back: () => {}, setParams: () => {} }}>
            <ProjectCockpitShell workspaceRef={ref} scopeId="project-code-route" activeRootPath={rootPath}
                surface="code" isFocused onSelectRootPath={() => {}} />
            <PaneProbe />
        </DestinationInstanceHost></WorkspaceNavigationProvider>;
        const screen = await fixture.render(renderLocation());
        const folderRow = `repository-tree-row-${toTestIdSafeValue('dir.with.dot')}`;
        await vi.waitFor(() => expect(screen.findByTestId(folderRow), JSON.stringify({ requests: fixture!.requests, text: screen.getTextContent() })).toBeTruthy());
        await screen.pressByTestIdAsync(folderRow);
        await vi.waitFor(() => expect(navigations).toHaveLength(1));
        const folderUrl = new URL(navigations[0]!, 'https://happier.test');
        expect(folderUrl.pathname).toBe('/projects/code-project/code');
        expect(Object.fromEntries(folderUrl.searchParams)).toMatchObject({ serverId: ref.serverId, codePath: 'dir.with.dot', codeKind: 'folder' });
        await screen.update(fixture.wrap(renderLocation(Object.fromEntries(folderUrl.searchParams))));
        const fileRow = `repository-tree-row-${toTestIdSafeValue('dir.with.dot/LICENSE')}`;
        await vi.waitFor(() => expect(screen.findByTestId(fileRow)).toBeTruthy());
        await screen.pressByTestIdAsync(fileRow);
        await vi.waitFor(() => expect(navigations).toHaveLength(2));
        const openedFileUrl = new URL(navigations.at(-1)!, 'https://happier.test');
        expect(openedFileUrl.searchParams.get('initialFile')).toBe('dir.with.dot/LICENSE');
        // A direct Code file URL remains a separate entry into the full-page file reader.
        const fileUrl = new URL(folderUrl);
        fileUrl.searchParams.set('codePath', 'dir.with.dot/LICENSE');
        fileUrl.searchParams.set('codeKind', 'file');
        await screen.update(fixture.wrap(renderLocation(Object.fromEntries(fileUrl.searchParams))));
        expect(screen.findByTestId('workspace-code-file')).toBeTruthy();
        expect(screen.root.findByType('CodePaneProbe').props.details?.isOpen).not.toBe(true);
        await vi.waitFor(() => expect(screen.findByTestId('workspace-code-strip-history')).toBeTruthy());
        await screen.pressByTestIdAsync('workspace-code-strip-history');
        await vi.waitFor(() => expect(new URL(navigations.at(-1)!, 'https://happier.test').pathname).toBe('/projects/code-project/changes'));
        // The browser Back owner returns the preceding retained route; Code must consume it.
        await screen.update(fixture.wrap(renderLocation(Object.fromEntries(folderUrl.searchParams))));
        expect(screen.findByTestId('workspace-code-file')).toBeNull();
        await vi.waitFor(() => expect(screen.findByTestId(fileRow)).toBeTruthy());
        await screen.pressByTestIdAsync('workspace-code-bar-crumb-0');
        await vi.waitFor(() => expect(new URL(navigations.at(-1)!, 'https://happier.test').searchParams.get('codePath')).toBe(''));
    });

    it('keeps the built Code tree when the Project returns to Code from another page', async () => {
        const rootPath = '/project-code-retained';
        fixture = await createSessionFilesViewFixture({ rootPath, rpc: request => {
            if (request.method === RPC_METHODS.LIST_DIRECTORY) {
                return { success: true, truncated: false, entries: [{ name: 'src', type: 'directory' }] };
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
        await vi.waitFor(() => expect(rowNode(), JSON.stringify({ requests: fixture!.requests, text: screen.getTextContent() })).toBeTruthy());
        const builtRows = new Set([rowNode()]);
        for (let visit = 0; visit < 2; visit += 1) {
            await screen.update(fixture.wrap(renderPage('scripts')));
            await screen.update(fixture.wrap(renderPage('code')));
            await vi.waitFor(() => expect(rowNode()).toBeTruthy());
            builtRows.add(rowNode());
        }
        expect(builtRows.size).toBe(1);
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
        // The Review measures its viewport before it reads a page of rows (CHANGES-FIRST).
        await vi.waitFor(() => expect(() => screen.findByType(WorkspaceScmReviewBody)).not.toThrow());
        const viewport = screen.findByType(WorkspaceScmReviewBody)
            .find(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
        await act(async () => viewport.props.onLayout({ nativeEvent: { layout: { width: 1200, height: 480 } } }));
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
