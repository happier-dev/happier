import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastXtermProps: any = null;

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Platform: { OS: 'ios' },
    PixelRatio: { getFontScale: () => 1 },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
        create: (fn: any) =>
            fn({
                colors: {
                    surface: '#000',
                    surfaceHigh: '#111',
                    divider: '#222',
                    text: '#fff',
                    textSecondary: '#888',
                    surfaceSelected: '#333',
                },
            }),
    },
    useUnistyles: () => ({
        theme: {
            dark: true,
            colors: {
                surface: '#000',
                surfaceHigh: '#111',
                divider: '#222',
                text: '#fff',
                textSecondary: '#888',
                surfaceSelected: '#333',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: 'PrimaryCircleIconButton',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: 'DropdownMenu',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
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

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: () => 1,
    useLocalSettingMutable: () => [null, vi.fn()],
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
    XtermWebViewSurface: React.forwardRef((props: any, _ref: any) => {
        lastXtermProps = props;
        return React.createElement('XtermWebViewSurface', props, props.children);
    }),
}));

import { SessionEmbeddedTerminalPane } from './SessionEmbeddedTerminalPane.native';

describe('SessionEmbeddedTerminalPane (native)', () => {
    it('renders an Xterm WebView surface wired to the PTY hook', async () => {
        lastXtermProps = null;
        onInputSpy.mockClear();

        await act(async () => {
            renderer.create(
                React.createElement(SessionEmbeddedTerminalPane, {
                    sessionId: 's1',
                    scopeId: 'scope1',
                    currentDockLocation: 'sidebar',
                    testIdPrefix: 't',
                } as any),
            );
        });

        expect(lastXtermProps).toBeTruthy();
        expect(lastXtermProps.onInput).toBe(onInputSpy);
    });
});
