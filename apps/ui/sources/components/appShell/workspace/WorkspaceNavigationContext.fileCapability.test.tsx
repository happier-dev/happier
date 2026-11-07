import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { WorkspaceNavigationProvider, useWorkspaceFileNavigationCapabilities, useWorkspaceFocusedRoute, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';

describe('file opener capability subscription', () => {
    it('publishes the remaining visible route while the selected tab belongs to another window', async () => {
        const Probe = () => React.createElement('route-probe', { route: useWorkspaceFocusedRoute() });
        let state = createWorkspaceState({ id: 'remaining', target: { kind: 'session', params: { id: 'remaining' } }, pinned: false, preview: false });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: {
            id: 'placed', target: { kind: 'session', params: { id: 'placed' } }, pinned: false, preview: false,
        } });
        state = reduceWorkspaceState(state, { type: 'setPresentation', tabId: 'placed', presentation: { windowId: 'destination' } });
        const value = {
            active: true, state, canGoBack: false, canGoForward: false,
            openHref: () => false, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {},
            dispatch: () => {}, navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        } satisfies WorkspaceNavigationContextValue;
        const screen = await renderScreen(<WorkspaceNavigationProvider value={value}><Probe /></WorkspaceNavigationProvider>);
        expect(screen.root.findByType('route-probe').props.route.target).toEqual(state.tabs.remaining.target);
        await screen.unmount();
    });
    it('does not render a file opener on unrelated workspace-state changes', async () => {
        let renders = 0;
        const Probe = React.memo(function Probe() {
            const { canOpen } = useWorkspaceFileNavigationCapabilities();
            renders++;
            return React.createElement('probe', { canOpen });
        });
        const state = createWorkspaceState({ id: 'session', target: { kind: 'session', params: { id: 's1' } }, pinned: true, preview: false });
        const value = {
            active: true, state, canGoBack: false, canGoForward: false,
            openHref: () => false, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {},
            dispatch: () => {}, navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        } satisfies WorkspaceNavigationContextValue;
        const child = <Probe />;
        const screen = await renderScreen(<WorkspaceNavigationProvider value={value}>{child}</WorkspaceNavigationProvider>);
        const before = renders;
        await screen.update(<WorkspaceNavigationProvider value={{ ...value, canGoBack: true }}>{child}</WorkspaceNavigationProvider>);
        expect(renders).toBe(before);
        await screen.update(<WorkspaceNavigationProvider value={{ ...value, active: false }}>{child}</WorkspaceNavigationProvider>);
        expect(renders).toBe(before + 1);
        await screen.unmount();
    });
});
