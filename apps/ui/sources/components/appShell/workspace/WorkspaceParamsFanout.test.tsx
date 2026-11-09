// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { resolveCompactAppDestinations, type DestinationRef } from '../destinations/compactAppDestinationCatalog';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { DestinationInstanceHost, useDestinationParams, useDestinationPathname, useDestinationRouter } from './DestinationInstanceHost';
import { useDestinationFocus, useDestinationInstanceKey, useDestinationVisibility } from './destinationInstanceContext';
import { WorkspaceDestinationBody } from './WorkspaceDestinationBody';

installPanelCommonModuleMocks();

const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: true, friends: false } });
const navigation = { push: () => {}, replace: () => {}, back: () => {} };
const usage = (params: Record<string, string>): DestinationRef => ({ kind: 'settings', params: { pageId: 'usage', ...params } });

function counted(read: () => unknown) {
    let renders = 0;
    const Probe = React.memo(function Probe() { read(); renders += 1; return null; });
    return { Probe, renders: () => renders };
}

describe('params-only update of one destination', () => {
    afterEach(standardCleanup);

    it('re-renders only the consumers of the destination route, not those of its focus, key, visibility or router', async () => {
        const facts = counted(() => { useDestinationFocus(); useDestinationVisibility(); useDestinationInstanceKey(); useDestinationRouter(); });
        const route = counted(() => { useDestinationParams(); });
        const children = <><facts.Probe /><route.Probe /></>;
        const host = (ref: DestinationRef) => <DestinationInstanceHost tabId="usage" ref={ref} pathname="/settings/usage"
            focused visible navigation={navigation}>{children}</DestinationInstanceHost>;
        const screen = await renderScreen(host(usage({ layoutId: 'costs' })));
        const before = { facts: facts.renders(), route: route.renders() };
        await screen.update(host(usage({ layoutId: 'plans' })));
        expect(facts.renders()).toBe(before.facts);
        expect(route.renders()).toBe(before.route + 1);
    });

    it('keeps pathname readers out of a params-only focused target update and still follows a real path change', async () => {
        const path = counted(() => { useDestinationPathname(); });
        const children = <path.Probe />;
        const valueFor = (state: ReturnType<typeof createWorkspaceState>): WorkspaceNavigationContextValue => ({
            active: true, state, catalog, canGoBack: false, canGoForward: false,
            openHref: () => true, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {},
            dispatch: () => {}, navigationForTab: () => navigation, registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        });
        const initial = createWorkspaceState({ id: 'usage', target: usage({ layoutId: 'costs' }), pinned: false, preview: false });
        const retarget = (state: typeof initial, target: DestinationRef) => reduceWorkspaceState(state, { type: 'setTarget', tabId: 'usage', target });
        const screen = await renderScreen(<WorkspaceNavigationProvider value={valueFor(initial)}>{children}</WorkspaceNavigationProvider>);
        const before = path.renders();
        const plans = retarget(initial, usage({ layoutId: 'plans' }));
        await screen.update(<WorkspaceNavigationProvider value={valueFor(plans)}>{children}</WorkspaceNavigationProvider>);
        expect(path.renders()).toBe(before);
        const elsewhere = retarget(plans, { kind: 'settings', params: { pageId: 'appearance' } });
        await screen.update(<WorkspaceNavigationProvider value={valueFor(elsewhere)}>{children}</WorkspaceNavigationProvider>);
        expect(path.renders()).toBe(before + 1);
    });

    it('does not re-render an unchanged destination body when its sibling publication re-renders the shell', async () => {
        const target: DestinationRef = { kind: 'session', params: { id: 's1' } };
        const renderSession = vi.fn(() => null);
        const renderSessionDetails = () => null;
        const body = () => <WorkspaceDestinationBody target={target} pathname="/session/s1"
            renderSession={renderSession} renderSessionDetails={renderSessionDetails} />;
        const screen = await renderScreen(<>{body()}</>);
        const before = renderSession.mock.calls.length;
        await screen.update(<>{body()}</>);
        expect(renderSession.mock.calls.length).toBe(before);
    });

    it('serves path readers from the provider while no tab is focused, without subscribing to the router', async () => {
        const path = counted(() => { useDestinationPathname(); });
        const children = <path.Probe />;
        const idle = (state: ReturnType<typeof createWorkspaceState>): WorkspaceNavigationContextValue => ({
            active: false, state, catalog, canGoBack: false, canGoForward: false,
            openHref: () => true, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {},
            dispatch: () => {}, navigationForTab: () => navigation, registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        });
        const state = createWorkspaceState({ id: 'usage', target: usage({}), pinned: false, preview: false });
        const screen = await renderScreen(<WorkspaceNavigationProvider value={idle(state)} routePathname="/settings/usage">{children}</WorkspaceNavigationProvider>);
        const before = path.renders();
        await screen.update(<WorkspaceNavigationProvider value={idle({ ...state })} routePathname="/settings/usage">{children}</WorkspaceNavigationProvider>);
        expect(path.renders()).toBe(before);
        await screen.update(<WorkspaceNavigationProvider value={idle(state)} routePathname="/settings/appearance">{children}</WorkspaceNavigationProvider>);
        expect(path.renders()).toBe(before + 1);
    });
});
