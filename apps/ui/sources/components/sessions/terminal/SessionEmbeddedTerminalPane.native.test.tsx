import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { installSessionEmbeddedTerminalCommonModuleMocks } from './sessionEmbeddedTerminalTestHelpers';

let lastXtermProps: Readonly<{ onInput: (data: string) => void }> | null = null;

installSessionEmbeddedTerminalCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
        });
    },
    storage: async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
        return {
            ...actual,
            useLocalSetting: () => 1,
            useLocalSettingMutable: () => [null, vi.fn()],
        };
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: 'PrimaryCircleIconButton',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: 'DropdownMenu',
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { right: { isOpen: false, activeTabId: null }, details: { isOpen: false, activeTabKey: null, tabs: [] }, bottom: { isOpen: false, activeTabId: null } },
        closeRight: vi.fn(),
        closeBottom: vi.fn(),
        closeDetailsTab: vi.fn(),
        openBottom: vi.fn(),
        setBottomTab: vi.fn(),
        openRight: vi.fn(),
        setRightTab: vi.fn(),
        openDetailsTab: vi.fn(),
    }),
}));

const onInputSpy = vi.fn();

vi.mock('./useSessionEmbeddedTerminalPty', () => ({
    useSessionEmbeddedTerminalPty: () => ({
        status: 'connected',
        error: null,
        detectedUrl: null,
        onInput: onInputSpy,
        onResize: vi.fn(),
        onReady: vi.fn(),
        clearTerminal: vi.fn(),
        requestRestart: vi.fn(),
        retryConnect: vi.fn(),
        dismissDetectedUrl: vi.fn(),
    }),
}));

vi.mock('@/components/terminal/xterm/webview/XtermWebViewSurface.native', () => ({
    XtermWebViewSurface: React.forwardRef<unknown, Readonly<{ onInput: (data: string) => void; children?: React.ReactNode }>>((props, _ref) => {
        lastXtermProps = props;
        return React.createElement('XtermWebViewSurface', props, props.children);
    }),
}));

describe('SessionEmbeddedTerminalPane (native)', () => {
    it('renders an Xterm WebView surface wired to the PTY hook', async () => {
        lastXtermProps = null;
        onInputSpy.mockClear();

        const { SessionEmbeddedTerminalPane } = await import('./SessionEmbeddedTerminalPane.native');
        const { renderScreen } = await import('@/dev/testkit');
        await renderScreen(
            React.createElement(SessionEmbeddedTerminalPane, {
                sessionId: 's1',
                scopeId: 'scope1',
                currentDockLocation: 'sidebar',
                testIdPrefix: 't',
            } as const),
        );

        expect(lastXtermProps).not.toBeNull();
        const xtermProps = lastXtermProps as unknown as Readonly<{ onInput: (data: string) => void }>;
        expect(xtermProps.onInput).toBe(onInputSpy);
    });
});
