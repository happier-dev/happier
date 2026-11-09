// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createWorkspaceState, reduceWorkspaceState } from './workspaceState';
import { WorkspaceNavigationProvider, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { WorkspaceDestinationRow } from './WorkspaceDestinationRow';

installPanelCommonModuleMocks();
vi.mock('@/utils/web/reactDomCjs', () => ({
    requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }),
}));

const ROWS = 12;

describe('workspace destination rows on a params-only target update', () => {
    afterEach(standardCleanup);
    it('does not re-render rows whose href and actions are unchanged, and keeps the new state reachable', async () => {
        const initial = createWorkspaceState({ id: 'usage', target: { kind: 'settings', params: { pageId: 'usage' } }, pinned: false, preview: false });
        const catalog: NonNullable<WorkspaceNavigationContextValue['catalog']> = [];
        const open = vi.fn(() => true);
        // The provider keeps these identities for a runtime; only `back` and the state are rebuilt per publication.
        const navigationForTab = () => ({ push: () => {}, replace: () => {}, back: () => {} });
        // `back`, `state` and `phone` objects are rebuilt per publication, like the provider's value.
        const valueFor = (state: typeof initial): WorkspaceNavigationContextValue => ({
            active: true, state, catalog, canGoBack: true, canGoForward: false,
            openHref: open, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {},
            dispatch: () => {}, navigationForTab,
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        });
        const renders = new Map<number, number>();
        const rows = Array.from({ length: ROWS }, (_, index) => <WorkspaceDestinationRow key={index} href={`/session/s${index}`}>
            {() => { renders.set(index, (renders.get(index) ?? 0) + 1); return null; }}
        </WorkspaceDestinationRow>);
        const screen = await renderScreen(<WorkspaceNavigationProvider value={valueFor(initial)}>{rows}</WorkspaceNavigationProvider>);
        const before = new Map(renders);
        const next = reduceWorkspaceState(initial, { type: 'setTarget', tabId: 'usage', target: { kind: 'settings', params: { pageId: 'usage', layoutId: 'cost' } } });
        expect(next).not.toBe(initial);
        await screen.update(<WorkspaceNavigationProvider value={valueFor(next)}>{rows}</WorkspaceNavigationProvider>);
        for (let index = 0; index < ROWS; index += 1) expect(renders.get(index)).toBe(before.get(index));
    });
});
