import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { installUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ openTarget: vi.fn() }));

installReactNativeWebMock();
installUnistylesMock();
vi.mock('@/text', () => createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

// Genuine boundaries: pane host state, the terminal RPC availability, store-backed badges.
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { right: { isOpen: false, activeTabId: null }, details: { isOpen: false } },
        openRight: vi.fn(), closeRight: vi.fn(), closeDetails: vi.fn(), openDetailsTab: vi.fn(),
    }),
}));
vi.mock('@/components/appShell/panes/PaneActionRailContext', () => ({
    PANE_ACTION_RAIL_WIDTH: 48,
    usePaneActionRailRightPaneHiddenByDetails: () => false,
}));
vi.mock('@/components/sessions/terminal/useSessionTerminalAction', () => ({
    useSessionTerminalAction: () => ({ available: false, active: false, onPress: vi.fn() }),
}));
vi.mock('./useSessionRunningAgentCount', () => ({ useSessionRunningAgentCount: () => 0 }));
vi.mock('./SessionGitActionRailBadge', () => ({
    useSessionGitActionRailBadge: () => null,
    SessionGitActionRailBadge: () => null,
    SessionGitActionRailTooltip: () => null,
}));
vi.mock('./open/useOpenSessionTarget', () => ({ useOpenSessionTarget: () => state.openTarget }));

describe('SessionActionRail', () => {
    beforeEach(() => state.openTarget.mockClear());

    it('puts a Session media button right after Files that opens the file browser on the Session view', async () => {
        const { SessionActionRail } = await import('./SessionActionRail');
        const screen = await renderScreen(<SessionActionRail sessionId="s1" scopeId="session:s1" />);

        const ids = [...new Set(screen.root
            .findAll((node) => /^session-action-rail:[a-z-]+$/.test(String(node.props?.testID ?? '')) && typeof node.props.onPress === 'function')
            .map((node) => String(node.props.testID).replace('session-action-rail:', '')))];
        expect(ids.indexOf('media')).toBe(ids.indexOf('files') + 1);

        invokeTestInstanceHandler(screen.findByTestId('session-action-rail:media'), 'onPress');

        expect(state.openTarget).toHaveBeenCalledWith({ kind: 'fileBrowser', view: 'session' });
    });
});
