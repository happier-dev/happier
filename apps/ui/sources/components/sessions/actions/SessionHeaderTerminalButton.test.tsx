import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const openBottomSpy = vi.fn();
const closeBottomSpy = vi.fn();
const setBottomTabSpy = vi.fn();
const openRightSpy = vi.fn();
const closeRightSpy = vi.fn();
const setRightTabSpy = vi.fn();

const pane = {
    scopeId: 'session:s1',
    scopeState: {
        right: { isOpen: false, activeTabId: null as string | null, tabState: {} },
        details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        bottom: { isOpen: false, activeTabId: null as string | null, tabState: {} },
    },
    openRight: openRightSpy,
    closeRight: closeRightSpy,
    setRightTab: setRightTabSpy,
    setRightTabState: vi.fn(),
    openBottom: openBottomSpy,
    closeBottom: closeBottomSpy,
    setBottomTab: setBottomTabSpy,
    setBottomTabState: vi.fn(),
    openDetailsTab: vi.fn(),
    setDetailsTabState: vi.fn(),
    pinDetailsTab: vi.fn(),
    closeDetails: vi.fn(),
    closeDetailsTab: vi.fn(),
    setActiveDetailsTab: vi.fn(),
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => pane,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useLocalSetting: (key: string) => {
        if (key === 'embeddedTerminalDockLocation') return 'bottom';
        return null;
    },
});
});

describe('SessionHeaderTerminalButton', () => {
    it('opens terminal in the bottom pane when docked to bottom', async () => {
        openBottomSpy.mockClear();
        closeBottomSpy.mockClear();
        setBottomTabSpy.mockClear();

        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');

        const screen = await renderScreen(<SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" />);
        expect(screen.findByTestId('session-header-terminal-button')).toBeTruthy();

        await screen.pressByTestIdAsync('session-header-terminal-button');

        expect(openBottomSpy).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(setBottomTabSpy).toHaveBeenCalledWith('terminal');
        expect(closeBottomSpy).not.toHaveBeenCalled();
    });

    it('closes the bottom pane when terminal is already open there', async () => {
        openBottomSpy.mockClear();
        closeBottomSpy.mockClear();

        pane.scopeState.bottom.isOpen = true;
        pane.scopeState.bottom.activeTabId = 'terminal';

        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');

        const screen = await renderScreen(<SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" />);
        expect(screen.findByTestId('session-header-terminal-button')).toBeTruthy();

        await screen.pressByTestIdAsync('session-header-terminal-button');

        expect(closeBottomSpy).toHaveBeenCalledTimes(1);
        expect(openBottomSpy).not.toHaveBeenCalled();
    });

    it('suppresses the header terminal button testID when the session screen is hidden', async () => {
        const { SessionScreenTestIdsProvider } = await import('../shell/sessionScreenTestIds');
        const { SessionHeaderTerminalButton } = await import('./SessionHeaderTerminalButton');

        const screen = await renderScreen(
            <SessionScreenTestIdsProvider enabled={false}>
                <SessionHeaderTerminalButton sessionId="s1" scopeId="session:s1" />
            </SessionScreenTestIdsProvider>,
        );

        expect(screen.findByTestId('session-header-terminal-button')).toBeNull();
    });
});
