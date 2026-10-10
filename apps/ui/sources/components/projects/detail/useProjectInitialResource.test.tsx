import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { installAppPaneScopeHostCommonModuleMocks } from '@/components/appShell/panes/appPaneScopeHostTestHelpers';
import { DestinationInstanceHost, useDestinationPaneScopeId, useDestinationParams } from '@/components/appShell/workspace/DestinationInstanceHost';
import { buildProjectPaneScopeId } from './projectPaneScope';
import { useProjectInitialResource } from './useProjectInitialResource';
import { buildProjectRouteHref, readProjectFileRouteTarget } from './projectRouteState';
import { useFullscreenDetailsRouteController } from '@/components/workspaceCockpit/useFullscreenDetailsRouteController';
import { useProjectRouteActions } from './useProjectRouteActions';
import { createProjectFileDetailsTab } from './projectDetailsTabBuilders';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

installAppPaneScopeHostCommonModuleMocks();
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');

const acceptedRef: WorkspaceRefV1 = { id: 'project-a', serverId: 'home-a', machineId: 'machine-a',
    rootPath: '/repo', label: 'Project', createdAtMs: 1, lastOpenedAtMs: null };

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
    return React.createElement('ProjectResourceProbe', { scopeId: pane.scopeId, tabs: pane.scopeState?.details.tabs ?? [],
        initialFile: params.initialFile, close: () => pane.closeDetailsTab('file:src/index.ts'),
        selectFile: () => pane.openDetailsTab(createProjectFileDetailsTab('src/current.ts'), { intent: 'pinned' }),
        closeCurrent: () => pane.closeDetailsTab('file:src/current.ts'),
        selectPage: () => actions.navigateToSegment({ segment: 'changes' }) });
}

function ReopenHarness() {
    const [initialFile, setInitialFile] = React.useState<string | undefined>('src/index.ts');
    return <AppPaneProvider><DestinationInstanceHost tabId="a"
        ref={{ kind: 'project', params: { workspaceRefId: 'project-a', ...(initialFile ? { initialFile } : {}) } }}
        pathname="/projects/project-a" focused visible navigation={{ push: () => {}, back: () => {},
            replace: () => {}, setParams: (params) => setInitialFile('initialFile' in params && typeof params.initialFile === 'string' ? params.initialFile : undefined) }}>
        <Body />
        {React.createElement('ReopenResource', { open: () => setInitialFile('src/index.ts') })}
    </DestinationInstanceHost></AppPaneProvider>;
}

describe('project initial resource admission', () => {
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
        expect(screen.root.findByType('ProjectResourceProbe').props.tabs).toEqual([]);
        const qualified = resolveWorkspaceRefById(candidates, 'project-a', 'home-a');
        if (qualified.kind !== 'resolved') throw new Error('Expected the qualified checkout');
        await act(async () => { screen.update(renderDestination(qualified.ref)); });
        expect(screen.root.findByType('ProjectResourceProbe').props.tabs.map((tab: { key: string }) => tab.key)).toEqual(['file:src/index.ts']);
    });
    it('admits the literal file route without a second normalization in the mounted destination', async () => {
        const path = ' leading /line\nbreak /name ';
        const screen = await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="literal-file"
            ref={{ kind: 'project', params: { workspaceRefId: 'project-a', initialFile: path } }}
            pathname="/projects/project-a/code" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
            <Body />
        </DestinationInstanceHost></AppPaneProvider>);
        expect(screen.root.findByType('ProjectResourceProbe').props.tabs[0].resource).toEqual({ kind: 'file', path });
    });
    it('changes pages with the actual selected pane resource and captured Home, checkout, dashboard and comparison', async () => {
        const navigations: string[] = [];
        const screen = await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="selected"
            ref={{ kind: 'project', params: { workspaceRefId: 'project-a', serverId: 'home-a', layoutId: 'selected',
                comparisonId: 'comparison-a', initialFile: 'src/index.ts' } }}
            pathname="/projects/project-a/code" focused visible navigation={{ push: (href) => navigations.push(String(href)),
                replace: () => {}, back: () => {}, setParams: () => {} }}><Body /></DestinationInstanceHost></AppPaneProvider>);
        await act(async () => { screen.root.findByType('ProjectResourceProbe').props.selectFile(); });
        await act(async () => { screen.root.findByType('ProjectResourceProbe').props.selectPage(); });
        const url = new URL(navigations[0], 'https://happier.test');
        expect(url.pathname).toBe('/projects/project-a/changes');
        expect(Object.fromEntries(url.searchParams)).toEqual({ serverId: 'home-a', layoutId: 'selected',
            comparisonId: 'comparison-a', initialFile: 'src/current.ts', worktreeId: 'checkout-a' });
        await act(async () => { screen.root.findByType('ProjectResourceProbe').props.closeCurrent(); });
        // Closing the other retained file as well leaves no current resource to carry forward.
        await act(async () => { screen.root.findByType('ProjectResourceProbe').props.close(); });
        await act(async () => { screen.root.findByType('ProjectResourceProbe').props.selectPage(); });
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
        expect(screen.root.findByType('ProjectResourceProbe').props.tabs[0].resource).toMatchObject(initialResource);
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
    it('retains the resource route and does not reopen a closed tab on rerender', async () => {
        const screen = await renderScreen(<ReopenHarness />);
        expect(screen.root.findByType('ProjectResourceProbe').props.initialFile).toBe('src/index.ts');
        await act(async () => { screen.root.findByType('ProjectResourceProbe').props.close(); });
        expect(screen.root.findByType('ProjectResourceProbe').props.tabs).toEqual([]);
        await act(async () => { screen.root.findByType('ReopenResource').props.open(); });
        expect(screen.root.findByType('ProjectResourceProbe').props.tabs).toEqual([]);
    });
    it('opens the routed resource only inside its destination instance, not a duplicate project pane', async () => {
        const screen = await renderScreen(<AppPaneProvider>{['a', 'b'].map((id) => <DestinationInstanceHost
            key={id} tabId={id} ref={{ kind: 'project', params: { workspaceRefId: 'project-a', ...(id === 'a' ? { initialFile: 'src/index.ts' } : {}) } }}
            pathname="/projects/project-a" focused={id === 'a'} visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}><Body /></DestinationInstanceHost>)}</AppPaneProvider>);
        const [first, second] = screen.root.findAllByType('ProjectResourceProbe');
        expect(first.props.tabs.map((tab: { key: string }) => tab.key)).toEqual(['file:src/index.ts']);
        expect(second.props.tabs).toEqual([]);
        expect(first.props.scopeId).not.toBe(second.props.scopeId);
    });
});
