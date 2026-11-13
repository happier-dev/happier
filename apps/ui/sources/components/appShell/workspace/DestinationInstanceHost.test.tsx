import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createRetainedPresentationSlotsStore, RetainedPresentationSlotBinder, RetainedPresentationSlotsProvider } from '@/components/ui/presentation/retainedPresentationSlots';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { usePluginSurfaceFocusEligibility, usePluginSurfaceCurrentUiContextEligibility, useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { createWorkspaceState } from './workspaceState';
import { Stack, useNavigation } from './destinationRoute';
import { useClaimedStackHeaderActions } from '@/components/navigation/stackHeaderActions';
import { NavigationHeaderActions, PageNavigationContextActionsProvider } from '@/components/ui/layout/NavigationHeaderActions';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { t } from '@/text';
import {
    DestinationInstanceHost,
    useDestinationFocus,
    useDestinationGlobalParams,
    useDestinationInstanceKey,
    useDestinationParams,
    useDestinationPathname,
    useDestinationRouter,
    useDestinationVisibility,
    useRetainedDestinationNode,
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

const pageHeaderOptions = { headerRight: () => React.createElement('MachineContextChip', { testID: 'machine-context' }) };
function PageHeaderActionsProbe() {
    const actions = useClaimedStackHeaderActions();
    return React.createElement('PageHeaderActionsProbe', {}, actions);
}

describe('DestinationInstanceHost', () => {
    it('keeps the title setters and moves the held title when a route-param write moves the tab target', async () => {
        const { useDestinationPageTitle } = await import('./DestinationInstanceHost');
        const { useNavigationTitleChromePublisher } = await import('@/components/ui/layout/navigationTitleChrome');
        const publishers = new Set<unknown>();
        function TitledPage() {
            publishers.add(useNavigationTitleChromePublisher());
            useDestinationPageTitle('Discover');
            return null;
        }
        const published: Array<Readonly<{ q: string | undefined; title: string | null }>> = [];
        const publishDestinationTitle = (_tabId: string, ref: { params: Readonly<Record<string, string>> }, title: string | null) => {
            published.push({ q: ref.params.q, title });
            return () => {};
        };
        const scene = (q: string) => {
            const target = { kind: 'plugins', params: { view: 'search', q } };
            const value: WorkspaceNavigationContextValue = {
                active: true, publishDestinationTitle,
                state: createWorkspaceState({ id: 'store', target, pinned: false, preview: false }),
                canGoBack: false, canGoForward: false, openHref: () => true,
                activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
                navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
                registerBackStep: () => () => {}, back: () => {}, forward: () => {},
            };
            return <WorkspaceNavigationProvider value={value}>
                <DestinationInstanceHost tabId="store" ref={target} pathname="/plugins" focused visible>
                    <TitledPage />
                </DestinationInstanceHost>
            </WorkspaceNavigationProvider>;
        };
        const screen = await renderScreen(scene('g'));
        publishers.clear();
        published.length = 0;
        for (const q of ['gi', 'git', 'gith']) await screen.update(scene(q));
        // Three keystrokes: the page's setters never change, and the owner hears the same title under each new target.
        expect({ publisherIdentities: publishers.size, last: published.at(-1) }).toEqual({ publisherIdentities: 1, last: { q: 'gith', title: 'Discover' } });
        await screen.unmount();
    });
    it('settles delayed navigation only for the current focused destination, including after its content disappears', async () => {
        let captured: ReturnType<typeof useNavigation> | undefined;
        let capturedRetained: ReturnType<typeof useNavigation> | undefined;
        function RetainedCapture() { capturedRetained = useNavigation(); return null; }
        function Capture() { captured = useNavigation(); return useRetainedDestinationNode(<RetainedCapture />); }
        const origin = { kind: 'settings', params: { pageId: 'appearance' } };
        const other = { kind: 'settings', params: { pageId: 'voice' } };
        const navigation = { push: () => {}, replace: () => {}, back: () => {} };
        const host = (ref = origin, focused = true, content = true, owner = navigation, visible = true) => <DestinationInstanceHost
            tabId="origin" ref={ref} pathname="/settings/appearance" focused={focused} visible={visible} navigation={owner}>
            {content ? <Capture /> : null}
        </DestinationInstanceHost>;
        const screen = await renderScreen(host());
        const original = captured!;
        const originalRetained = capturedRetained!;
        expect(original.isFocused()).toBe(true);
        expect(originalRetained.isFocused()).toBe(true);
        await screen.update(host({ kind: origin.kind, params: { ...origin.params } }));
        expect(original.isFocused()).toBe(true);
        expect(originalRetained.isFocused()).toBe(true);
        await screen.update(host(origin, false));
        expect(original.isFocused()).toBe(false);
        expect(originalRetained.isFocused()).toBe(false);
        await screen.update(host());
        expect(original.isFocused()).toBe(true);
        expect(originalRetained.isFocused()).toBe(true);
        await screen.update(host(origin, true, false));
        expect(original.isFocused()).toBe(true);
        expect(originalRetained.isFocused()).toBe(false);
        await screen.update(host(origin, false, false));
        expect(original.isFocused()).toBe(false);
        await screen.update(host(origin, true, false));
        expect(original.isFocused()).toBe(true);
        await screen.update(host(origin, true, false, navigation, false));
        expect(original.isFocused()).toBe(false);
        await screen.update(host(origin, true, false));
        expect(original.isFocused()).toBe(true);
        const replacementOwner = { push: () => {}, replace: () => {}, back: () => {} };
        await screen.update(host(origin, true, true, replacementOwner));
        expect(original.isFocused()).toBe(false);
        const afterOwnerChange = captured!;
        const retainedAfterOwnerChange = capturedRetained!;
        expect(afterOwnerChange.isFocused()).toBe(true);
        expect(retainedAfterOwnerChange.isFocused()).toBe(true);
        await screen.update(host(other, true, true, replacementOwner));
        expect(afterOwnerChange.isFocused()).toBe(false);
        expect(retainedAfterOwnerChange.isFocused()).toBe(false);
        const afterRefChange = captured!;
        const retainedAfterRefChange = capturedRetained!;
        expect(afterRefChange.isFocused()).toBe(true);
        expect(retainedAfterRefChange.isFocused()).toBe(true);
        await screen.unmount();
        expect(afterRefChange.isFocused()).toBe(false);
        expect(retainedAfterRefChange.isFocused()).toBe(false);
    });

    it('keeps a presented retained callback current across a same-identity binder handoff', async () => {
        let captured: ReturnType<typeof useNavigation> | undefined;
        function Capture() { captured = useNavigation(); return null; }
        const ref = { kind: 'settings', params: { pageId: 'appearance' } };
        const navigation = { push: () => {}, replace: () => {}, back: () => {} };
        const store = createRetainedPresentationSlotsStore();
        const scene = (hostKey: string, target = ref, owner = navigation, presented = true) => <RetainedPresentationSlotsProvider store={store}>
            <DestinationInstanceHost key={hostKey} tabId="retained-origin" ref={target}
                pathname="/settings/appearance" focused visible navigation={owner}>
                <RetainedPresentationSlotBinder slotId="delayed-navigation" enabled visible={presented}
                    windowGeometry={{ x: 0, y: 0, width: 100, height: 100 }}>
                    <Capture />
                </RetainedPresentationSlotBinder>
            </DestinationInstanceHost>
        </RetainedPresentationSlotsProvider>;
        const screen = await renderScreen(scene('first-host'));
        const original = captured!;
        expect(original.isFocused()).toBe(true);
        await screen.update(scene('replacement-host'));
        expect(original.isFocused()).toBe(true);
        await screen.update(scene('replacement-host', { kind: ref.kind, params: { ...ref.params } }));
        expect(original.isFocused()).toBe(true);
        const replacementOwner = { push: () => {}, replace: () => {}, back: () => {} };
        await screen.update(scene('replacement-host', ref, replacementOwner));
        expect(original.isFocused()).toBe(false);
        const afterOwnerChange = captured!;
        expect(afterOwnerChange.isFocused()).toBe(true);
        const replacementRef = { kind: 'settings', params: { pageId: 'voice' } };
        await screen.update(scene('replacement-host', replacementRef, replacementOwner));
        expect(afterOwnerChange.isFocused()).toBe(false);
        const current = captured!;
        expect(current.isFocused()).toBe(true);
        await screen.update(scene('replacement-host', replacementRef, replacementOwner, false));
        expect(current.isFocused()).toBe(false);
        await screen.update(scene('replacement-host', replacementRef, replacementOwner));
        expect(current.isFocused()).toBe(true);
        await screen.unmount();
        expect(current.isFocused()).toBe(false);
    });

    it('inherits the root declaration for a phone page before any leaf options arrive', async () => {
        const screen = await renderScreen(<DestinationInstanceHost tabId="history-phone" phone
            ref={{ kind: 'sessionRecent', params: {} }} pathname="/session/recent" focused visible>
            {React.createElement('HistoryBody')}
        </DestinationInstanceHost>);
        expect(screen.findByTestId('workspace-destination-header')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('sessionHistory.title'));
    });
    it('claims no Back on a phone page that draws no bar, so the page keeps its own way back', async () => {
        const { useNavigationChromeShowsBack } = await import('@/components/ui/layout/navigationTitleChrome');
        let showsBack: boolean | undefined;
        function Probe() { showsBack = useNavigationChromeShowsBack(); return null; }
        const screen = await renderScreen(<DestinationInstanceHost tabId="bare-phone" phone
            ref={{ kind: 'artifacts', params: {} }} pathname="/artifacts" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {}, canGoBack: () => true }}>
            <Stack.Screen options={{ headerShown: true, headerTitle: '' }} />
            <Probe />
        </DestinationInstanceHost>);
        expect(screen.findByTestId('workspace-destination-header')).toBeNull();
        expect(showsBack).toBe(false);
    });
    it('keeps an Artifacts PageHeader and its actions in the page without a second phone bar', async () => {
        const screen = await renderScreen(<DestinationInstanceHost tabId="artifacts-phone" phone
            ref={{ kind: 'artifacts', params: {} }} pathname="/artifacts" focused visible>
            <Stack.Screen options={{ headerRight: () => React.createElement('CreateArtifact') }} />
            <PageHeader title="Artifacts" alwaysShowTitle actions={React.createElement('ArtifactActions')} />
        </DestinationInstanceHost>);
        expect(screen.findByTestId('workspace-destination-header')).toBeNull();
        expect(screen.getTextContent()).toContain('Artifacts');
        expect(screen.root.findAllByType('ArtifactActions')).toHaveLength(1);
        expect(screen.root.findAllByType('CreateArtifact')).toHaveLength(1);
    });
    it('hands hosted desktop route actions to the page header once and retains them when content is loading', async () => {
        const page = (ready: boolean) => <DestinationInstanceHost tabId="header-tab"
            ref={{ kind: 'settings', params: {} }} pathname="/settings" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <Stack.Screen options={pageHeaderOptions} />
            {ready ? <PageHeaderActionsProbe /> : React.createElement('LoadingBody')}
        </DestinationInstanceHost>;
        const screen = await renderScreen(page(true));
        expect(screen.root.findByType('PageHeaderActionsProbe').findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
        await screen.update(page(false));
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
    });
    it('keeps phone route context beside page actions and after the renderer returns to loading', async () => {
        const page = (ready: boolean) => <DestinationInstanceHost tabId="phone-header-tab" phone
            ref={{ kind: 'settings', params: {} }} pathname="/settings" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <Stack.Screen options={pageHeaderOptions} />
            <PageNavigationContextActionsProvider actions={pageHeaderOptions.headerRight()}>
                {ready ? <NavigationHeaderActions primary={{ title: 'Save', onPress: () => {} }} /> : React.createElement('LoadingBody')}
            </PageNavigationContextActionsProvider>
        </DestinationInstanceHost>;
        const screen = await renderScreen(page(true));
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
        await screen.update(page(false));
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
    });
    it('withdraws old phone context when its provider and destination leave', async () => {
        const page = (first: boolean) => <DestinationInstanceHost tabId={first ? 'first-phone' : 'second-phone'} phone
            ref={{ kind: 'settings', params: {} }} pathname="/settings" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <Stack.Screen options={first ? pageHeaderOptions : { title: 'Other page' }} />
            {first ? <PageNavigationContextActionsProvider actions={pageHeaderOptions.headerRight()}>
                <NavigationHeaderActions primary={{ title: 'Save', onPress: () => {} }} />
            </PageNavigationContextActionsProvider> : React.createElement('OtherPage')}
        </DestinationInstanceHost>;
        const screen = await renderScreen(page(true));
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
        await screen.update(page(false));
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(0);
    });
    it('gives unhosted shell consumers the focused workspace route before Expo mirrors it', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        const value = (id: string | null): WorkspaceNavigationContextValue => ({
            active: true, catalog,
            state: createWorkspaceState({ id: 'workflow-tab', target: id === null ? { kind: 'workflows', params: {} }
                : { kind: 'workflow', params: { id, serverId: 'workspace-home' } }, pinned: false, preview: false }),
            canGoBack: false, canGoForward: false, openHref: () => true,
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        });
        const scene = (id: string | null) => <WorkspaceNavigationProvider value={value(id)}>
            <IdentityProbe /><GlobalParamsProbe />
        </WorkspaceNavigationProvider>;
        const screen = await renderScreen(scene('qa-checklist'));
        expect(screen.root.findByType('IdentityProbe').props.pathname).toBe('/workflows/qa-checklist');
        expect(screen.root.findByType('GlobalParamsProbe').props.params).toEqual({ id: 'qa-checklist', serverId: 'workspace-home' });
        await screen.update(scene(null));
        expect(screen.root.findByType('IdentityProbe').props.pathname).toBe('/workflows');
        expect(screen.root.findByType('GlobalParamsProbe').props.params).toEqual({});
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
    it('retains the unhosted router across workspace publications while navigation reads current history and focus', async () => {
        let routerRenders = 0;
        function RouterProbe() {
            routerRenders++;
            return React.createElement('RouterProbe', { router: useDestinationRouter() });
        }
        // One element, so only a context the router reads can render it again.
        const probe = <RouterProbe />;
        const opened: string[] = [];
        const workspace: WorkspaceNavigationContextValue = {
            active: true,
            state: createWorkspaceState({ id: 'first', target: { kind: 'newTab', params: {} }, pinned: false, preview: false }),
            canGoBack: false, canGoForward: false,
            openHref: href => { opened.push(`original:${href}`); return true; },
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: tabId => ({ push: () => {}, replace: () => {}, back: () => {},
                pushRetainingCurrent: () => { opened.push(`retained:${tabId}`); },
                retainCurrent: () => { opened.push(`promoted:${tabId}`); } }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        };
        const render = (value: WorkspaceNavigationContextValue) => <WorkspaceNavigationProvider value={value}>{probe}</WorkspaceNavigationProvider>;
        const screen = await renderScreen(render(workspace));
        const readRouter = () => screen.root.findByType('RouterProbe').props.router as ReturnType<typeof useDestinationRouter>;
        const initial = readRouter();
        const settledRenders = routerRenders;
        expect(initial.canGoBack()).toBe(false);
        await screen.update(render({ ...workspace, canGoBack: true,
            state: createWorkspaceState({ id: 'second', target: { kind: 'newTab', params: {} }, pinned: false, preview: false }) }));
        expect.soft(readRouter()).toBe(initial);
        // History, focus and title publications are invocation-time facts, not a render of every router caller.
        expect(routerRenders).toBe(settledRenders);
        expect(readRouter().canGoBack()).toBe(true);
        readRouter().pushRetainingCurrent('/settings/appearance');
        readRouter().retainCurrent();
        expect(opened).toEqual(['retained:second', 'promoted:second']);
        await screen.update(render({ ...workspace, openHref: href => { opened.push(`replacement:${href}`); return true; } }));
        expect(readRouter()).not.toBe(initial);
        initial.push('/settings/appearance');
        readRouter().push('/settings/appearance');
        expect(opened.slice(-2)).toEqual(['original:/settings/appearance', 'replacement:/settings/appearance']);
        await screen.unmount();
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
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <DestinationInstanceHost tabId="tab-a" ref={{ kind: 'session', params: { id: 'A', serverId: 'home-a' } }}
                pathname="/session/A" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <IdentityProbe />
            </DestinationInstanceHost>
            <DestinationInstanceHost tabId="tab-b" ref={{ kind: 'settings', params: { pageId: 'appearance' } }}
                pathname="/settings/appearance" focused={false} visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <IdentityProbe />
            </DestinationInstanceHost>
        </InjectedAuthProvider>);
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
