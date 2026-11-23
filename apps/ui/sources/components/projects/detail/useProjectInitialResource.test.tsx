import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { installAppPaneScopeHostCommonModuleMocks } from '@/components/appShell/panes/appPaneScopeHostTestHelpers';
import { DestinationInstanceHost, useDestinationPaneScopeId, useDestinationParams, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { buildProjectPaneScopeId } from './projectPaneScope';
import { useProjectInitialResource } from './useProjectInitialResource';
import { buildProjectRouteHref, readProjectFileRouteTarget } from './projectRouteState';
import { useFullscreenDetailsRouteController } from '@/components/workspaceCockpit/useFullscreenDetailsRouteController';
import { useProjectRouteActions } from './useProjectRouteActions';
import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { workspaceScopeFromProject } from '@/sync/domains/workspaces/workspaceScope';
import { createWorkspaceActionAdapter } from '@/components/appShell/workspace/workspaceActions';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { resolveWorkspaceEntityDrop } from '@/components/appShell/workspace/workspaceEntityDrop';
import { buildRepositoryFileDragItem, resolveWorkspaceDestinationEntityItem } from '@/components/appShell/workspace/workspaceEntitySource';
import { resolveHref } from 'expo-router/build/link/href';
import { buildWorkspaceFileLink, readFileTargetAnchorResource, type FileTargetAnchor } from '@/utils/url/sessionFileDeepLink';

installAppPaneScopeHostCommonModuleMocks();
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');

const acceptedRef: WorkspaceRefV1 = { id: 'project-a', serverId: 'home-a', machineId: 'machine-a',
    rootPath: '/repo', label: 'Project', createdAtMs: 1, lastOpenedAtMs: null };

function ProjectResourceProbe(_props: Readonly<{
    scopeId: string;
    tabs: NonNullable<AppPaneScopeApi['scopeState']>['details']['tabs'];
    detailsIsOpen: boolean;
    hide: () => void;
    right: NonNullable<AppPaneScopeApi['scopeState']>['right'] | undefined;
    initialFile: string | undefined;
    close: (path?: string) => void;
    selectFile: () => void;
    selectAnchoredFile: () => void;
    pinPdf: () => void;
    selectPreviewFile: () => void;
    closeCurrent: () => void;
    selectPage: () => void;
}>) { return null; }

function Body(props: Readonly<{ onDismiss?: () => void; workspaceRef?: WorkspaceRefV1 | null }> = {}) {
    const pane = useAppPaneScope(useDestinationPaneScopeId(buildProjectPaneScopeId('project-a')));
    const actions = useProjectRouteActions({ workspaceRef: { id: 'project-a', serverId: 'home-a', machineId: 'machine-a',
        rootPath: '/repo', label: 'Project', createdAtMs: 1, lastOpenedAtMs: null },
        activeRootPath: '/repo/feature', activeWorktreeId: 'checkout-a', pane });
    const resourcePending = Boolean(useProjectInitialResource(pane, props.workspaceRef === undefined ? acceptedRef : props.workspaceRef));
    useFullscreenDetailsRouteController({ resetKey: pane.scopeId, enabled: Boolean(props.onDismiss), isFocused: true,
        hydrated: true, detailsIsOpen: pane.scopeState?.details.isOpen ?? false,
        hasDetails: Boolean(pane.scopeState?.details.tabs.length), keepRouteWhenEmpty: resourcePending,
        onDismissRoute: props.onDismiss ?? (() => {}), onCloseDetails: pane.closeDetails });
    const params = useDestinationParams<{ initialFile?: string }>();
    return React.createElement(ProjectResourceProbe, { scopeId: pane.scopeId, tabs: pane.scopeState?.details.tabs ?? [],
        detailsIsOpen: pane.scopeState?.details.isOpen ?? false, hide: pane.closeDetails,
        right: pane.scopeState?.right,
        initialFile: params.initialFile, close: (path = 'src/index.ts') => pane.closeDetailsTab(`file:${path}`),
        selectFile: () => pane.openDetailsTab(createWorkspaceFileDetailsTab('src/current.ts'), { intent: 'pinned' }),
        selectAnchoredFile: () => pane.openDetailsTab(createWorkspaceFileDetailsTab('src/current.ts',
            { kind: 'range', filePath: 'src/current.ts', startLine: 3, endLine: 5 }, 'file', { view: 'view', blame: false }), { intent: 'pinned' }),
        pinPdf: () => pane.pinDetailsTab('file:docs/retry-guide.pdf'),
        selectPreviewFile: () => pane.openDetailsTab(createWorkspaceFileDetailsTab('src/current.ts'), { intent: 'preview' }),
        closeCurrent: () => pane.closeDetailsTab('file:src/current.ts'),
        selectPage: () => actions.navigateToSegment({ segment: 'changes' }) });
}

function ReopenHarness() {
    const [state, setState] = React.useState(() => createWorkspaceState({ id: 'a', pinned: false, preview: false,
        target: { kind: 'project', params: { workspaceRefId: 'project-a', serverId: 'home-a', pageId: 'code',
            initialFile: 'docs/retry-guide.pdf', activeRootPath: '/repo', fileOpenAs: 'preview',
            layoutId: 'layout-a', comparisonId: 'comparison-a', right: 'files', codeKind: 'folder', codePath: 'docs' } } }));
    const current = React.useRef(state);
    current.current = state;
    const navigation = React.useMemo(() => createWorkspaceNavigationAdapter({
        getState: () => current.current,
        getCatalog: () => resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] }),
        dispatch: action => { current.current = reduceWorkspaceState(current.current, action); setState(current.current); },
        // Expo/browser URL projection is a platform boundary; destination admission stays real.
        transport: { commit: () => {} }, createId: () => 'another-tab', onChange: () => {},
    }), []);
    const execute = React.useMemo(() => createWorkspaceActionAdapter({ getState: () => current.current,
        navigation, readCanvas: () => null, createId: () => 'another-tab' }), [navigation]);
    const destinationNavigation = React.useMemo<DestinationNavigation>(() => ({ push: () => {}, back: () => {},
        replace: href => { navigation.openHref(resolveHref(href), { tabId: 'a', replace: true }); },
        setParams: params => { navigation.setParams('a', params); },
    }), [navigation]);
    return <AppPaneProvider><DestinationInstanceHost tabId="a"
        ref={state.tabs.a.target} pathname="/projects/project-a/code" focused visible navigation={destinationNavigation}>
        <Body />
        {React.createElement('ReopenResource', { params: state.tabs.a.target.params,
            open: (anchor?: FileTargetAnchor) => execute('workspace.tabs.open', { file: { target: { kind: 'project', workspaceRefId: 'project-a',
                serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, path: 'docs/retry-guide.pdf', ...(anchor ? { anchor } : {}) }, mode: 'preview' }) })}
    </DestinationInstanceHost></AppPaneProvider>;
}

describe('project initial resource admission', () => {
    it('opens the dropped guest file in the moved Project pane beside a Session', async () => {
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const guest = { v: 2, kind: 'managed', id: 'guest-checkout', serverId: scope.serverId, managedId: 'guest',
            controller: { machineId: 'machine-a', installationId: 'controller' }, rootPath: '/repo', createdAtMs: 1 } as const;
        const workspaceRefs = [acceptedRef, guest];
        const file = 'GUEST-ONLY-RWS-QA-9f3a7c.txt';
        const href = buildWorkspaceFileLink({ path: file,
            target: { kind: 'project', workspaceRefId: guest.id, serverId: guest.serverId, rootPath: guest.rootPath } });
        const catalog = resolveCompactAppDestinations({ pages: [],
            builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        let state = createWorkspaceState({ id: 'session', pinned: false, preview: false,
            target: { kind: 'session', params: { id: 'readiness-probe', ...scope } } });
        let sequence = 0;
        const createId = () => `drop:${++sequence}`;
        const dispatch: Parameters<typeof createWorkspaceNavigationAdapter>[0]['dispatch'] = action => { state = reduceWorkspaceState(state, action); };
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog, dispatch,
            createId, transport: { commit: () => {} }, onChange: () => {} });
        const measurement = { availableSizePx: 1200, minimumExistingSizePx: 300 };
        expect(navigation.openHref('/projects/guest-checkout/code?serverId=home-a', {
            mode: 'splitRight', availableSizePx: measurement.availableSizePx, minimumFirstSizePx: measurement.minimumExistingSizePx,
        })).toBe(true);
        const source = navigation.findOpenHref(href)!;
        // The source group keeps another tab, like the retained workspace in QA.
        expect(navigation.openHref('/inbox', { mode: 'newTab', groupId: source.groupId })).toBe(true);
        const item = resolveWorkspaceDestinationEntityItem({ scope, catalog, href, entityItem: buildRepositoryFileDragItem({
            scope, workspace: workspaceScopeFromProject(guest, guest.rootPath), path: file, entryKind: 'file',
        }) });
        if (!item) throw new Error('Expected the guest tree drag item');
        const decision = resolveWorkspaceEntityDrop({ scope, catalog, workspaceRefs, item, ...measurement,
            target: { leafId: 'group:1', placement: 'up' },
            workspace: { ...navigation, active: true, state, catalog,
                back: () => navigation.step(-1), forward: () => navigation.step(1),
                navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }), registerBackStep: () => () => {} },
        });
        if (decision.status !== 'allowed'
            || (decision.effect.actionId !== 'workspace.tabs.open' && decision.effect.actionId !== 'workspace.split')) {
            throw new Error('Expected a split effect');
        }
        const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, createId,
            readCanvas: () => ({ readSplitMeasurement: () => measurement, resizeSplit: () => false }) });
        expect(await execute(decision.effect.actionId, decision.effect.input)).toEqual({ ok: true });
        expect(state.tabs.session.target.kind).toBe('session');
        expect(state.groups[source.groupId].tabIds).not.toContain(source.tabId);
        const tab = state.tabs[state.groups[state.focusedGroupId].activeTabId];
        expect(tab.id).toBe(source.tabId);
        const resolution = resolveWorkspaceRefById(workspaceRefs, tab.target.params.workspaceRefId, tab.target.params.serverId);
        expect(resolution).toMatchObject({ kind: 'resolved', ref: guest });
        const screen = await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId={tab.id}
            ref={tab.target} pathname="/projects/guest-checkout/code" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
            <Body workspaceRef={resolution.kind === 'resolved' ? resolution.ref : null} />
        </DestinationInstanceHost></AppPaneProvider>);
        expect(screen.root.findByType(ProjectResourceProbe).props.tabs.map((entry: { resource: unknown }) => entry.resource))
            .toMatchObject([{ kind: 'file', path: file }]);
    });

    it('restores the qualified plugin selection without replaying private launch input, and rejects malformed route targets', async () => {
        const companion = { kind: 'plugin', destination: { pluginId: 'acme.preview', localId: 'project-review' }, instanceKey: 'review-a' };
        const renderDestination = (workspaceRef: WorkspaceRefV1 | null, target: unknown = companion) => <AppPaneProvider><DestinationInstanceHost
            tabId="plugin-return" ref={{ kind: 'project', params: { workspaceRefId: 'project-a', serverId: 'home-a',
                rightDestination: JSON.stringify(target) } }}
            pathname="/projects/project-a/overview" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
            <Body workspaceRef={workspaceRef} />
        </DestinationInstanceHost></AppPaneProvider>;
        const screen = await renderScreen(renderDestination(null));
        expect(screen.root.findByType(ProjectResourceProbe).props.right?.isOpen).not.toBe(true);
        await screen.update(renderDestination(acceptedRef));
        expect(screen.root.findByType(ProjectResourceProbe).props.right).toMatchObject({ isOpen: true, selectedDestination: companion });
        await screen.update(renderDestination(acceptedRef, { ...companion, destination: { pluginId: 'acme.other', localId: 'other' }, launchInput: { grant: true } }));
        expect(screen.root.findByType(ProjectResourceProbe).props.right?.selectedDestination).toEqual(companion);
    });
    it('restores a closed companion destination only after exact checkout admission on a cold return', async () => {
        const renderDestination = (workspaceRef: WorkspaceRefV1 | null, right = 'browser') => <AppPaneProvider><DestinationInstanceHost
            tabId="origin-return" ref={{ kind: 'project', params: { workspaceRefId: 'project-a', serverId: 'home-a', right } }}
            pathname="/projects/project-a/services" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
            <Body workspaceRef={workspaceRef} />
        </DestinationInstanceHost></AppPaneProvider>;
        const screen = await renderScreen(renderDestination(null));
        expect(screen.root.findByType(ProjectResourceProbe).props.right?.isOpen).not.toBe(true);
        await screen.update(renderDestination(acceptedRef));
        expect(screen.root.findByType(ProjectResourceProbe).props.right).toMatchObject({ isOpen: true, activeTabId: 'browser' });
        await screen.update(renderDestination(acceptedRef, 'files'));
        expect(screen.root.findByType(ProjectResourceProbe).props.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
        await screen.update(renderDestination(acceptedRef, 'agents'));
        expect(screen.root.findByType(ProjectResourceProbe).props.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
    });
    it('does not write a resource pane for an ambiguous deep link, then admits the exact qualified checkout', async () => {
        const candidates = [acceptedRef, { ...acceptedRef, serverId: 'home-b' }];
        const resolution = resolveWorkspaceRefById(candidates, 'project-a');
        expect(resolution.kind).toBe('ambiguous');
        const renderDestination = (workspaceRef: WorkspaceRefV1 | null) => <AppPaneProvider><DestinationInstanceHost
            tabId="ambiguous" ref={{ kind: 'project', params: { workspaceRefId: 'project-a', initialFile: 'src/index.ts' } }}
            pathname="/projects/project-a/code" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
            <Body workspaceRef={workspaceRef} />
        </DestinationInstanceHost></AppPaneProvider>;
        const screen = await renderScreen(renderDestination(resolution.kind === 'resolved' ? resolution.ref : null));
        expect(screen.root.findByType(ProjectResourceProbe).props.tabs).toEqual([]);
        const qualified = resolveWorkspaceRefById(candidates, 'project-a', 'home-a');
        if (qualified.kind !== 'resolved') throw new Error('Expected the qualified checkout');
        await act(async () => { screen.update(renderDestination(qualified.ref)); });
        expect(screen.root.findByType(ProjectResourceProbe).props.tabs.map((tab: { key: string }) => tab.key)).toEqual(['file:src/index.ts']);
    });
    it('admits the literal file route without a second normalization in the mounted destination', async () => {
        const path = ' leading /line\nbreak /name ';
        const screen = await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="literal-file"
            ref={{ kind: 'project', params: { workspaceRefId: 'project-a', initialFile: path } }}
            pathname="/projects/project-a/code" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
            <Body />
        </DestinationInstanceHost></AppPaneProvider>);
        expect(screen.root.findByType(ProjectResourceProbe).props.tabs[0].resource).toEqual({ kind: 'file', path });
    });
    it('changes pages with the actual selected pane resource and captured Home, checkout, dashboard and comparison', async () => {
        const navigations: string[] = [];
        const screen = await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="selected"
            ref={{ kind: 'project', params: { workspaceRefId: 'project-a', serverId: 'home-a', layoutId: 'selected',
                comparisonId: 'comparison-a', initialFile: 'src/index.ts' } }}
            pathname="/projects/project-a/code" focused visible navigation={{ push: (href) => navigations.push(String(href)),
                replace: () => {}, back: () => {}, setParams: () => {} }}><Body /></DestinationInstanceHost></AppPaneProvider>);
        await act(async () => { screen.root.findByType(ProjectResourceProbe).props.selectFile(); });
        await act(async () => { screen.root.findByType(ProjectResourceProbe).props.selectPage(); });
        const url = new URL(navigations[0], 'https://happier.test');
        expect(url.pathname).toBe('/projects/project-a/changes');
        expect(Object.fromEntries(url.searchParams)).toEqual({ serverId: 'home-a', layoutId: 'selected',
            comparisonId: 'comparison-a', initialFile: 'src/current.ts', worktreeId: 'checkout-a' });
        await act(async () => { screen.root.findByType(ProjectResourceProbe).props.closeCurrent(); });
        // Closing the other retained file as well leaves no current resource to carry forward.
        await act(async () => { screen.root.findByType(ProjectResourceProbe).props.close(); });
        await act(async () => { screen.root.findByType(ProjectResourceProbe).props.selectPage(); });
        expect(new URL(navigations[1], 'https://happier.test').searchParams.has('initialFile')).toBe(false);
    });
    it('admits the typed anchor into the real destination pane', async () => {
        const initialResource = { kind: 'file' as const, path: 'src/index.ts', anchorSource: 'diff' as const,
            anchor: { kind: 'range' as const, filePath: 'src/index.ts', startLine: 12, endLine: 14 } };
        const href = buildProjectRouteHref({ workspaceRefId: 'project-a', segment: 'code', activeRootPath: '/repo', defaultRootPath: '/repo', initialResource });
        const params = Object.fromEntries(new URL(href, 'https://happier.test').searchParams);
        expect(readProjectFileRouteTarget(params)).toEqual(initialResource);
        const screen = await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="anchored"
            ref={{ kind: 'project', params: { workspaceRefId: 'project-a', ...params } }}
            pathname="/projects/project-a/code" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
            <Body />
        </DestinationInstanceHost></AppPaneProvider>);
        expect(screen.root.findByType(ProjectResourceProbe).props.tabs[0].resource).toMatchObject(initialResource);
    });
    it('keeps the destination alive while its initial resource is being admitted', async () => {
        let dismissals = 0;
        await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="a"
            ref={{ kind: 'project', params: { workspaceRefId: 'project-a', initialFile: 'src/index.ts' } }}
            pathname="/projects/project-a/code" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
            <Body onDismiss={() => { dismissals += 1; }} />
        </DestinationInstanceHost></AppPaneProvider>);
        expect(dismissals).toBe(0);
    });
    it.each(['remove tab', 'hide pane'] as const)('retires a closed resource address (%s) and reopens the same PDF through the real file Action and navigation owner', async close => {
        const screen = await renderScreen(<ReopenHarness />);
        expect(screen.root.findByType(ProjectResourceProbe).props.initialFile).toBe('docs/retry-guide.pdf');
        await act(async () => {
            const probe = screen.root.findByType(ProjectResourceProbe);
            if (close === 'hide pane') probe.props.hide();
            else probe.props.close('docs/retry-guide.pdf');
        });
        expect(screen.root.findByType(ProjectResourceProbe).props.detailsIsOpen).toBe(false);
        if (close === 'remove tab') expect(screen.root.findByType(ProjectResourceProbe).props.tabs).toEqual([]);
        const closedParams = screen.root.findByType('ReopenResource').props.params;
        await screen.update(<ReopenHarness />);
        expect(screen.root.findByType(ProjectResourceProbe).props.detailsIsOpen).toBe(false);
        await act(async () => { expect(await screen.root.findByType('ReopenResource').props.open()).toEqual({ ok: true }); });
        expect(screen.root.findByType(ProjectResourceProbe).props.tabs.map((tab: { key: string }) => tab.key)).toEqual(['file:docs/retry-guide.pdf']);
        expect(screen.root.findByType(ProjectResourceProbe).props.detailsIsOpen).toBe(true);
        expect(closedParams.initialFile).toBeUndefined();
        expect(closedParams).toMatchObject({ serverId: 'home-a', activeRootPath: '/repo', layoutId: 'layout-a',
            comparisonId: 'comparison-a', right: 'files', codeKind: 'folder', codePath: 'docs' });
        expect(screen.root.findByType('ReopenResource').props.params).toMatchObject({ workspaceRefId: 'project-a', serverId: 'home-a',
            initialFile: 'docs/retry-guide.pdf', activeRootPath: '/repo' });
        await act(async () => { expect(await screen.root.findByType('ReopenResource').props.open({ kind: 'fileLine', startLine: 8 })).toEqual({ ok: true }); });
        expect(readFileTargetAnchorResource(screen.root.findByType(ProjectResourceProbe).props.tabs[0].resource)?.anchor).toEqual({ kind: 'fileLine', startLine: 8 });
    });
    it('projects the remaining selected file when the addressed PDF closes, without reopening it during rerenders', async () => {
        const screen = await renderScreen(<ReopenHarness />);
        await act(async () => { screen.root.findByType(ProjectResourceProbe).props.selectAnchoredFile(); });
        await act(async () => { screen.root.findByType(ProjectResourceProbe).props.close('docs/retry-guide.pdf'); });
        expect(screen.root.findByType(ProjectResourceProbe).props.tabs.map((tab: { key: string }) => tab.key)).toEqual(['file:src/current.ts']);
        expect(screen.root.findByType('ReopenResource').props.params.initialFile).toBe('src/current.ts');
        expect(readProjectFileRouteTarget(screen.root.findByType('ReopenResource').props.params)).toMatchObject({ kind: 'file', path: 'src/current.ts',
            view: 'view', blame: false, anchor: { kind: 'range', filePath: 'src/current.ts', startLine: 3, endLine: 5 } });
        await screen.update(<ReopenHarness />);
        expect(screen.root.findByType(ProjectResourceProbe).props.tabs.map((tab: { key: string }) => tab.key)).toEqual(['file:src/current.ts']);
        await act(async () => { expect(await screen.root.findByType('ReopenResource').props.open()).toEqual({ ok: true }); });
        expect(screen.root.findByType(ProjectResourceProbe).props.tabs.map((tab: { key: string }) => tab.key)).toContain('file:docs/retry-guide.pdf');
    });
    it('does not replay resource admission and promote the remaining preview when projecting a closed PDF', async () => {
        const screen = await renderScreen(<ReopenHarness />);
        await act(async () => { screen.root.findByType(ProjectResourceProbe).props.pinPdf(); });
        await act(async () => { screen.root.findByType(ProjectResourceProbe).props.selectPreviewFile(); });
        const readPreview = () => screen.root.findByType(ProjectResourceProbe).props.tabs.find((tab: { key: string }) => tab.key === 'file:src/current.ts');
        expect(readPreview()).toMatchObject({ isPreview: true, isPinned: false });
        await act(async () => { screen.root.findByType(ProjectResourceProbe).props.close('docs/retry-guide.pdf'); });
        expect(screen.root.findByType('ReopenResource').props.params.initialFile).toBe('src/current.ts');
        expect(readPreview()).toMatchObject({ isPreview: true, isPinned: false });
    });
    it('opens the routed resource only inside its destination instance, not a duplicate project pane', async () => {
        const screen = await renderScreen(<AppPaneProvider>{['a', 'b'].map((id) => <DestinationInstanceHost
            key={id} tabId={id} ref={{ kind: 'project', params: { workspaceRefId: 'project-a', ...(id === 'a' ? { initialFile: 'src/index.ts' } : {}) } }}
            pathname="/projects/project-a" focused={id === 'a'} visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}><Body /></DestinationInstanceHost>)}</AppPaneProvider>);
        const [first, second] = screen.root.findAllByType(ProjectResourceProbe);
        expect(first.props.tabs.map((tab: { key: string }) => tab.key)).toEqual(['file:src/index.ts']);
        expect(second.props.tabs).toEqual([]);
        expect(first.props.scopeId).not.toBe(second.props.scopeId);
    });
});
