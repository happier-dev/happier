import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

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

vi.mock('@/components/ui/scroll/useWebScrollLockBypass', () => ({
    useWebScrollLockBypass: () => {},
}));

const emptyPaneScope = {
    scopeId: 'scope:details',
    scopeState: {
        right: {
            isOpen: false,
            activeTabId: null,
            tabState: {},
        },
        details: {
            isOpen: true,
            tabs: [],
            activeTabKey: null,
            tabState: {},
        },
        bottom: {
            isOpen: false,
            activeTabId: null,
            tabState: {},
        },
    },
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
} satisfies AppPaneScopeApi;

describe('PaneDetailsTabsPanel empty state', () => {
    it('renders the shared no-tabs-empty state when no details tabs are open', async () => {
        const { PaneDetailsTabsPanel } = await import('./PaneDetailsTabsPanel');

        const screen = await renderScreen(
            <PaneDetailsTabsPanel
                pane={emptyPaneScope}
                renderTabContent={() => null}
            />,
        );

        expect(screen.getTextContent()).toContain('session.detailsPanel.emptyTitle');
        expect(screen.getTextContent()).toContain('session.detailsPanel.emptyHint');
    });
});
