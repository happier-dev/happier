import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { installAppPaneScopeHostCommonModuleMocks } from '@/components/appShell/panes/appPaneScopeHostTestHelpers';
import { DestinationInstanceHost, useDestinationPaneScopeId, useDestinationParams } from '@/components/appShell/workspace/DestinationInstanceHost';
import { buildProjectPaneScopeId } from './projectPaneScope';
import { useProjectInitialResource } from './useProjectInitialResource';
import { buildProjectRouteHref, readProjectFileRouteTarget } from './projectRouteState';
import { useFullscreenDetailsRouteController } from '@/components/workspaceCockpit/useFullscreenDetailsRouteController';

installAppPaneScopeHostCommonModuleMocks();
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');

function Body(props: Readonly<{ onDismiss?: () => void }> = {}) {
    const pane = useAppPaneScope(useDestinationPaneScopeId(buildProjectPaneScopeId('project-a')));
    const resourcePending = Boolean(useProjectInitialResource(pane));
    useFullscreenDetailsRouteController({ resetKey: pane.scopeId, enabled: Boolean(props.onDismiss), isFocused: true,
        hydrated: true, detailsIsOpen: pane.scopeState?.details.isOpen ?? false,
        hasDetails: Boolean(pane.scopeState?.details.tabs.length), keepRouteWhenEmpty: resourcePending,
        onDismissRoute: props.onDismiss ?? (() => {}), onCloseDetails: pane.closeDetails });
    const params = useDestinationParams<{ initialFile?: string }>();
    return React.createElement('ProjectResourceProbe', { scopeId: pane.scopeId, tabs: pane.scopeState?.details.tabs ?? [],
        initialFile: params.initialFile, close: () => pane.closeDetailsTab('file:src/index.ts') });
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
    it('admits the typed anchor into the real destination pane', async () => {
        const initialResource = { kind: 'file' as const, path: 'src/index.ts', anchorSource: 'diff' as const,
            anchor: { kind: 'range' as const, filePath: 'src/index.ts', startLine: 12, endLine: 14 } };
        const href = buildProjectRouteHref({ workspaceRefId: 'project-a', segment: 'details', activeRootPath: '/repo', defaultRootPath: '/repo', initialResource });
        const params = Object.fromEntries(new URL(href, 'https://happier.test').searchParams);
        expect(readProjectFileRouteTarget(params)).toEqual(initialResource);
        const screen = await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="anchored"
            ref={{ kind: 'project', params: { workspaceRefId: 'project-a', ...params } }}
            pathname="/projects/project-a/details" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
            <Body />
        </DestinationInstanceHost></AppPaneProvider>);
        expect(screen.root.findByType('ProjectResourceProbe').props.tabs[0].resource).toMatchObject(initialResource);
    });
    it('keeps the classic details route alive while its initial resource is being admitted', async () => {
        let dismissals = 0;
        await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="a"
            ref={{ kind: 'project', params: { workspaceRefId: 'project-a', initialFile: 'src/index.ts' } }}
            pathname="/projects/project-a/details" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
            <Body onDismiss={() => { dismissals += 1; }} />
        </DestinationInstanceHost></AppPaneProvider>);
        expect(dismissals).toBe(0);
    });
    it('consumes the route intent so the same resource can be opened again after closing it', async () => {
        const screen = await renderScreen(<ReopenHarness />);
        expect(screen.root.findByType('ProjectResourceProbe').props.initialFile).toBeUndefined();
        await act(async () => { screen.root.findByType('ProjectResourceProbe').props.close(); });
        expect(screen.root.findByType('ProjectResourceProbe').props.tabs).toEqual([]);
        await act(async () => { screen.root.findByType('ReopenResource').props.open(); });
        expect(screen.root.findByType('ProjectResourceProbe').props.tabs.map((tab: { key: string }) => tab.key)).toEqual(['file:src/index.ts']);
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
