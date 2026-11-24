import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { CurtainProbe, startTestLaunchCurtain } from '@/dev/testkit/harness/launchCurtainHarness';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { resolveCompactAppDestinations, resolveDestinationRefFromHref } from '../destinations/compactAppDestinationCatalog';
import { DestinationInstanceHost } from './DestinationInstanceHost';
import { WorkspaceDestinationBody } from './WorkspaceDestinationBody';
import { registerWorkspaceRouteContext } from './workspaceRouteContext';
import { workspaceRouteFiles } from './workspaceRoutes';

installPanelCommonModuleMocks();
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

it('shows the focused body while a visible secondary split is still loading its module', async () => {
    const pendingModule = createDeferred<{ WorkspaceRouteBody: React.ComponentType }>();
    function DrawnBody() { return React.createElement('DrawnBody'); }
    const modules: Record<string, unknown> = {
        [workspaceRouteFiles.boards!]: { WorkspaceRouteBody: DrawnBody },
        [workspaceRouteFiles['projects/[workspaceRefId]']!]: pendingModule.promise,
    };
    // Expo module loading is the external boundary. Both panes use the real route body host.
    registerWorkspaceRouteContext(Object.assign((key: string) => {
        if (!(key in modules)) throw new Error(`Unexpected route module: ${key}`);
        return modules[key];
    }, { keys: () => Object.keys(modules) }));
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: true, friends: false,
    } });
    function destination(pathname: string, focused: boolean) {
        const target = resolveDestinationRefFromHref(catalog, pathname);
        if (!target) throw new Error(`Unadmitted fixture route: ${pathname}`);
        return <DestinationInstanceHost tabId={pathname} ref={target} pathname={pathname} focused={focused} visible>
            <WorkspaceDestinationBody target={target} pathname={pathname} renderSession={() => null} renderSessionDetails={() => null} />
        </DestinationInstanceHost>;
    }
    const launch = startTestLaunchCurtain();
    const screen = await renderScreen(<>
        {destination('/boards', true)}
        {destination('/projects/project-secondary', false)}
        <CurtainProbe />
    </>);
    const curtain = () => screen.root.findByType('CurtainProbe').props.state;
    try {
        await vi.waitFor(() => expect(screen.root.findAllByType('DrawnBody')).toHaveLength(1));
        expect(screen.findHostByTestId('workspace-destination-body-loading')).not.toBeNull();
        launch.releaseShell();
        await launch.paint();
        expect(curtain()).toBe('leaving');
        await act(async () => { launch.finish(); });
        expect(curtain()).toBe('gone');
        expect(screen.findHostByTestId('workspace-destination-body-loading')).not.toBeNull();
    } finally {
        await screen.unmount();
        pendingModule.resolve({ WorkspaceRouteBody: DrawnBody });
        launch.dispose();
    }
});
