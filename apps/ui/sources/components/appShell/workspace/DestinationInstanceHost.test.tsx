import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { usePluginSurfaceFocusEligibility, usePluginSurfaceCurrentUiContextEligibility, useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { createWorkspaceState } from './workspaceState';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import {
    DestinationInstanceHost,
    useDestinationFocus,
    useDestinationGlobalParams,
    useDestinationInstanceKey,
    useDestinationParams,
    useDestinationPathname,
    useDestinationRouter,
    useDestinationVisibility,
} from './DestinationInstanceHost';

const expoHooks = vi.hoisted(() => ({ reject: false }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const module = createExpoRouterMock({ pathname: '/settings', params: { pageId: 'global' } }).module;
    const guard = <T,>(hook: () => T) => () => {
        if (expoHooks.reject) throw new Error('Hosted bodies have no Expo navigator');
        return hook();
    };
    return { ...module, useGlobalSearchParams: guard(() => ({ pageId: 'global-route' })),
        useLocalSearchParams: guard(module.useLocalSearchParams),
        usePathname: guard(module.usePathname), useRouter: guard(module.useRouter) };
});

function IdentityProbe() {
    const params = useDestinationParams<{ id?: string; serverId?: string; pageId?: string }>();
    return React.createElement('IdentityProbe', {
        params,
        pathname: useDestinationPathname(),
        focused: useDestinationFocus(),
        visible: useDestinationVisibility(),
        instanceKey: useDestinationInstanceKey(),
    });
}

function NavigationProbe() {
    const router = useDestinationRouter();
    return React.createElement('NavigationProbe', { open: () => router.push('/settings/appearance') });
}

function GlobalParamsProbe() {
    return React.createElement('GlobalParamsProbe', { params: useDestinationGlobalParams() });
}

function FocusProbe() {
    return React.createElement('FocusProbe', {
        focused: useDestinationFocus(),
        pluginFocus: usePluginSurfaceFocusEligibility(),
        currentContext: usePluginSurfaceCurrentUiContextEligibility(),
        presented: useLayoutPresentationActive(),
    });
}

describe('DestinationInstanceHost', () => {
    it('gives unhosted shell consumers the focused workspace route before Expo mirrors it', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        const value = (id: string | null): WorkspaceNavigationContextValue => ({
            active: true, catalog,
            state: createWorkspaceState({ id: 'workflow-tab', target: id === null ? { kind: 'workflows', params: {} }
                : { kind: 'workflow', params: { id } }, pinned: false, preview: false }),
            canGoBack: false, canGoForward: false, openHref: () => true,
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        });
        const screen = await renderScreen(<WorkspaceNavigationContext.Provider value={value('qa-checklist')}><IdentityProbe /></WorkspaceNavigationContext.Provider>);
        expect(screen.root.findByType('IdentityProbe').props.pathname).toBe('/workflows/qa-checklist');
        await screen.update(<WorkspaceNavigationContext.Provider value={value(null)}><IdentityProbe /></WorkspaceNavigationContext.Provider>);
        expect(screen.root.findByType('IdentityProbe').props.pathname).toBe('/workflows');
    });
    it('gives only the visible focused destination plugin focus and semantic current-context eligibility', async () => {
        const screen = await renderScreen(<>
            {[{ id: 'focused', focused: true, visible: true }, { id: 'sibling', focused: false, visible: true },
                { id: 'hidden', focused: true, visible: false }].map((tab) => <DestinationInstanceHost key={tab.id}
                    tabId={tab.id} ref={{ kind: 'newTab', params: {} }} pathname="/" focused={tab.focused} visible={tab.visible}>
                    <FocusProbe />
                </DestinationInstanceHost>)}
        </>);
        expect(screen.root.findAllByType('FocusProbe').map((node) => node.props)).toEqual([
            { focused: true, pluginFocus: true, currentContext: true, presented: true },
            { focused: false, pluginFocus: false, currentContext: false, presented: true },
            { focused: false, pluginFocus: false, currentContext: false, presented: false },
        ]);
    });
    it('preserves native global search parameters outside the workspace', async () => {
        const screen = await renderScreen(<GlobalParamsProbe />);
        expect(screen.root.findByType('GlobalParamsProbe').props.params).toEqual({ pageId: 'global-route' });
    });
    it('does not require Expo hooks when a destination supplies identity and navigation', async () => {
        expoHooks.reject = true;
        try {
            const screen = await renderScreen(React.createElement(DestinationInstanceHost, {
                tabId: 'settings-tab', ref: { kind: 'settings', params: { pageId: 'appearance' } },
                pathname: '/settings/appearance', focused: true, visible: true,
                navigation: { push: () => {}, replace: () => {}, back: () => {} },
                children: React.createElement(React.Fragment, null,
                    React.createElement(IdentityProbe), React.createElement(NavigationProbe),
                    React.createElement(GlobalParamsProbe)),
            }));
            expect(screen.root.findByType('IdentityProbe').props.pathname).toBe('/settings/appearance');
            expect(screen.root.findByType('GlobalParamsProbe').props.params).toEqual({ pageId: 'appearance' });
        } finally { expoHooks.reject = false; }
    });
    it('gives concurrent destinations separate identity, focus, and visibility outside the Stack', async () => {
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(DestinationInstanceHost, {
                tabId: 'tab-a', ref: { kind: 'session', params: { id: 'A', serverId: 'home-a' } },
                pathname: '/session/A', focused: true, visible: true,
                children: React.createElement(IdentityProbe),
            }),
            React.createElement(DestinationInstanceHost, {
                tabId: 'tab-b', ref: { kind: 'settings', params: { pageId: 'appearance' } },
                pathname: '/settings/appearance', focused: false, visible: true,
                children: React.createElement(IdentityProbe),
            }),
        ));
        expect(screen.root.findAllByType('IdentityProbe').map((node) => node.props)).toEqual([
            { params: { id: 'A', serverId: 'home-a' }, pathname: '/session/A', focused: true, visible: true, instanceKey: 'tab-a' },
            { params: { pageId: 'appearance' }, pathname: '/settings/appearance', focused: false, visible: true, instanceKey: 'tab-b' },
        ]);
    });

    it('sends each hosted page action through its own tab navigation owner', async () => {
        const opened: string[] = [];
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(DestinationInstanceHost, {
                tabId: 'tab-a', ref: { kind: 'session', params: { id: 'A' } }, pathname: '/session/A',
                focused: true, visible: true,
                navigation: { push: () => { opened.push('tab-a'); }, replace: () => {}, back: () => {} },
                children: React.createElement(NavigationProbe),
            }),
            React.createElement(DestinationInstanceHost, {
                tabId: 'tab-b', ref: { kind: 'session', params: { id: 'B' } }, pathname: '/session/B',
                focused: false, visible: true,
                navigation: { push: () => { opened.push('tab-b'); }, replace: () => {}, back: () => {} },
                children: React.createElement(NavigationProbe),
            }),
        ));
        screen.root.findAllByType('NavigationProbe').forEach((node) => node.props.open());
        expect(opened).toEqual(['tab-a', 'tab-b']);
    });
});
