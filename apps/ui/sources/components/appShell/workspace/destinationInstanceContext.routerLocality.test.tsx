import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { DestinationInstanceContext, type DestinationInstanceContextValue } from './destinationInstanceContext';
import { useDestinationGlobalParamsSelector, useDestinationInstanceKey, useDestinationRouter } from './DestinationInstanceHost';
import { WorkspaceNavigationProvider } from './WorkspaceNavigationContext';
import { createWorkspaceState } from './workspaceState';

describe('destination router locality', () => {
    it('keeps router and identity readers still when the destination only gains or loses focus', async () => {
        const navigation = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
        const base = { tabId: 'tab-a', ref: { kind: 'store', params: {} }, pathname: '/store', isFocused: () => true, navigation };
        let routerRenders = 0;
        let keyRenders = 0;
        // An approvals/registry read binds the router only to open a destination later.
        function RouterReader() { useDestinationRouter(); routerRenders += 1; return null; }
        function KeyReader() { useDestinationInstanceKey(); keyRenders += 1; return null; }
        const children = <><RouterReader /><KeyReader /></>;
        const tree = (value: DestinationInstanceContextValue) => <DestinationInstanceContext.Provider value={value}>{children}</DestinationInstanceContext.Provider>;
        const screen = await renderScreen(tree({ ...base, focused: true, visible: true }));
        const before = { routerRenders, keyRenders };

        await screen.update(tree({ ...base, focused: false, visible: true }));
        await screen.update(tree({ ...base, focused: false, visible: false }));

        expect({ routerRenders, keyRenders }).toEqual(before);
    });

    it('renders a shell reader of one focused-route param only when that param changes', async () => {
        let renders = 0;
        let seen: unknown = null;
        const selectView = (params: Readonly<Record<string, string | string[] | undefined>>) => params.view;
        // A shell column (PluginsNavigationColumn) beside a Store tab whose search rewrites `q` per keystroke.
        function ColumnReader() { seen = useDestinationGlobalParamsSelector(selectView); renders += 1; return null; }
        const reader = <ColumnReader />;
        const shell = (params: Record<string, string>) => <WorkspaceNavigationProvider value={{
            active: true, state: createWorkspaceState({ id: 'store', target: { kind: 'plugins', params }, pinned: false, preview: true }),
            canGoBack: false, canGoForward: false, openHref: () => true,
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        }}>{reader}</WorkspaceNavigationProvider>;
        const screen = await renderScreen(shell({ view: 'kind', kind: 'mcpServer' }));
        const before = renders;

        for (const q of ['g', 'gi', 'git']) await screen.update(shell({ view: 'kind', kind: 'mcpServer', q }));
        expect(renders).toBe(before);
        await screen.update(shell({ view: 'installed', q: 'git' }));
        expect(seen).toBe('installed');
        expect(renders).toBe(before + 1);
    });
});
