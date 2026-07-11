import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { installSessionEmbeddedTerminalCommonModuleMocks } from './sessionEmbeddedTerminalTestHelpers';

let lastXtermProps: Readonly<{
    onInput: (data: string) => void;
    onWriteComplete?: (event: unknown) => void;
}> | null = null;
const sessionEmbeddedTerminalPtySpy = vi.hoisted(() => vi.fn());
const getClipboardStringTrimmedSafeMock = vi.hoisted(() => vi.fn());

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
const onPasteSpy = vi.fn();
const onWriteCompleteSpy = vi.fn();

vi.mock('@/utils/ui/clipboard', () => ({
    getClipboardStringTrimmedSafe: getClipboardStringTrimmedSafeMock,
}));

vi.mock('./useSessionEmbeddedTerminalPty', () => ({
    useSessionEmbeddedTerminalPty: (input: unknown) => {
        sessionEmbeddedTerminalPtySpy(input);
        return {
            status: 'connected',
            error: null,
            detectedUrl: null,
            onInput: onInputSpy,
            onPaste: onPasteSpy,
            onResize: vi.fn(),
            onReady: vi.fn(),
            onWriteComplete: onWriteCompleteSpy,
            clearTerminal: vi.fn(),
            requestRestart: vi.fn(),
            retryConnect: vi.fn(),
            dismissDetectedUrl: vi.fn(),
        };
    },
}));

vi.mock('@/components/terminal/xterm/webview/XtermWebViewSurface.native', () => ({
    XtermWebViewSurface: React.forwardRef<unknown, Readonly<{
        onInput: (data: string) => void;
        onWriteComplete?: (event: unknown) => void;
        children?: React.ReactNode;
    }>>((props, _ref) => {
        lastXtermProps = props;
        return React.createElement('XtermWebViewSurface', props, props.children);
    }),
}));

describe('SessionEmbeddedTerminalPane (native)', () => {
    it('renders an Xterm WebView surface wired to the PTY hook', async () => {
        lastXtermProps = null;
        onInputSpy.mockClear();
        onPasteSpy.mockClear();
        onWriteCompleteSpy.mockClear();
        getClipboardStringTrimmedSafeMock.mockReset();
        sessionEmbeddedTerminalPtySpy.mockClear();

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
        const xtermProps = lastXtermProps as unknown as Readonly<{
            onInput: (data: string) => void;
            onWriteComplete?: (event: unknown) => void;
        }>;
        expect(xtermProps.onInput).toBe(onInputSpy);
        expect(xtermProps.onWriteComplete).toBe(onWriteCompleteSpy);
        expect(sessionEmbeddedTerminalPtySpy.mock.calls.at(-1)?.[0]).toEqual(
            expect.objectContaining({
                sessionId: 's1',
                terminalKey: 'session:s1:terminal',
            }),
        );
    });

    it('routes toolbar paste through the terminal paste policy callback', async () => {
        lastXtermProps = null;
        onPasteSpy.mockClear();
        getClipboardStringTrimmedSafeMock.mockResolvedValueOnce('pasted text');

        const { SessionEmbeddedTerminalPane } = await import('./SessionEmbeddedTerminalPane.native');
        const { renderScreen } = await import('@/dev/testkit');
        const screen = await renderScreen(
            React.createElement(SessionEmbeddedTerminalPane, {
                sessionId: 's1',
                scopeId: 'scope1',
                currentDockLocation: 'sidebar',
                testIdPrefix: 't',
            } as const),
        );

        const paste = screen.findByTestId('t-paste');
        await act(async () => {
            await paste?.props.onPress();
        });

        expect(onPasteSpy).toHaveBeenCalledWith('pasted text');
        expect(onInputSpy).not.toHaveBeenCalledWith('pasted text');
    });

    it('uses an instance-aware terminalKey when a terminal tab instance is provided', async () => {
        lastXtermProps = null;
        onInputSpy.mockClear();
        onPasteSpy.mockClear();
        onWriteCompleteSpy.mockClear();
        getClipboardStringTrimmedSafeMock.mockReset();
        sessionEmbeddedTerminalPtySpy.mockClear();

        const { SessionEmbeddedTerminalPane } = await import('./SessionEmbeddedTerminalPane.native');
        const { renderScreen } = await import('@/dev/testkit');
        await renderScreen(
            React.createElement(SessionEmbeddedTerminalPane, {
                sessionId: 's1',
                scopeId: 'scope1',
                currentDockLocation: 'details',
                terminalInstanceId: 'term-2',
                testIdPrefix: 't',
            } as const),
        );

        expect(sessionEmbeddedTerminalPtySpy.mock.calls.at(-1)?.[0]).toEqual(
            expect.objectContaining({
                terminalKey: 'session:s1:terminal:term-2',
            }),
        );
    });
});
