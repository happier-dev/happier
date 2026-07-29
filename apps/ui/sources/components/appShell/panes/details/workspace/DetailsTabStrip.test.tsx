import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { DetailsTabState, DetailsWorkspaceGroupView } from './detailsWorkspaceTypes';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

function createPane(): AppPaneScopeApi {
    return {
        scopeId: 'scope:details',
        scopeState: {},
        openRight: vi.fn(),
        closeRight: vi.fn(),
        setRightTab: vi.fn(),
        setRightTabState: vi.fn(),
        openBottom: vi.fn(),
        closeBottom: vi.fn(),
        setBottomTab: vi.fn(),
        setBottomTabState: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        pinDetailsTab: vi.fn(),
        unpinDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        splitDetailsGroup: vi.fn(),
        moveDetailsTabToGroup: vi.fn(),
        focusDetailsGroup: vi.fn(),
        setMaximizedDetailsGroup: vi.fn(),
        setDetailsSplitRatio: vi.fn(),
        closeDetailsGroup: vi.fn(),
    } as unknown as AppPaneScopeApi;
}

function browserViewTab(): DetailsTabState {
    return {
        key: 'browser-view:bs:bv',
        kind: 'browser-view',
        title: 'Docs',
        isPinned: false,
        isPreview: false,
        resource: { kind: 'browser-view', browserSessionId: 'bs', viewId: 'bv', target: { kind: 'externalUrl', targetId: 't', url: 'https://docs.test/' } },
    };
}

function group(tab: DetailsTabState): DetailsWorkspaceGroupView {
    return {
        id: 'group:1',
        tabKeys: [tab.key],
        activeTabKey: tab.key,
        tabs: [tab],
        isFocused: true,
    };
}

const testIds = {
    tab: (k: string) => `tab-${k}`,
    tabClose: (k: string) => `tab-close-${k}`,
    tabFavicon: (k: string) => `tab-favicon-${k}`,
    tabSpinner: (k: string) => `tab-spinner-${k}`,
};

describe('DetailsTabStrip chrome absorption for browser-view tabs', () => {
    it('renders a favicon for a browser-view tab via the generic presentation hook', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const tab = browserViewTab();
        const screen = await renderScreen(
            <DetailsTabStrip
                pane={createPane()}
                group={group(tab)}
                resolveTabPresentation={() => ({ faviconUrl: 'https://docs.test/favicon.ico', isLoading: false })}
                testIds={testIds}
            />,
        );
        expect(screen.findByTestId('tab-favicon-browser-view_bs_bv')).not.toBeNull();
    });

    it('renders a loading spinner while the browser-view tab is loading', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const tab = browserViewTab();
        const screen = await renderScreen(
            <DetailsTabStrip
                pane={createPane()}
                group={group(tab)}
                resolveTabPresentation={() => ({ faviconUrl: 'https://docs.test/favicon.ico', isLoading: true })}
                testIds={testIds}
            />,
        );
        expect(screen.findByTestId('tab-spinner-browser-view_bs_bv')).not.toBeNull();
    });

    it('exposes a per-tab close affordance routed to the workspace pane', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const pane = createPane();
        const tab = browserViewTab();
        const screen = await renderScreen(
            <DetailsTabStrip
                pane={pane}
                group={group(tab)}
                resolveTabPresentation={() => ({ faviconUrl: null, isLoading: false })}
                testIds={testIds}
            />,
        );
        const close = screen.findByTestId('tab-close-browser-view_bs_bv');
        expect(close).not.toBeNull();
        close?.props.onPress({});
        expect(pane.closeDetailsTab).toHaveBeenCalledWith(tab.key);
    });
});
