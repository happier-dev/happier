import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installEmbeddedTerminalPaneCommonModuleMocks } from './embeddedTerminalPaneTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'ios',
}));

const surfaceState = vi.hoisted(() => ({
    xtermProps: null as unknown,
    ghosttyProps: null as unknown,
    termuxProps: null as unknown,
    ghosttySurfaceIds: [] as string[],
    termuxSurfaceIds: [] as string[],
}));

const featureState = vi.hoisted(() => ({
    enabled: {} as Record<string, boolean>,
}));

const nativeAvailabilityState = vi.hoisted(() => ({
    availability: {
        available: false,
        reason: 'native-module-missing',
    } as unknown,
}));

const localSettingState = vi.hoisted(() => ({
    terminalRendererPreference: 'auto',
}));

installEmbeddedTerminalPaneCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (value: Record<string, unknown>) => value[platformState.os] ?? value.default ?? null,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'terminalRendererPreference') return localSettingState.terminalRendererPreference;
        return 1;
    },
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/utils/ui/clipboard', () => ({
    getClipboardStringTrimmedSafe: vi.fn(async () => ''),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureState.enabled[featureId] === true,
}));

vi.mock('@happier-dev/terminal-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/terminal-native')>();
    return {
        ...actual,
        getTerminalNativeAvailability: () => nativeAvailabilityState.availability,
    };
});

vi.mock('@/components/terminal/xterm/webview/XtermWebViewSurface.native', () => ({
    XtermWebViewSurface: React.forwardRef<unknown, Readonly<{ children?: React.ReactNode }>>((props, _ref) => {
        surfaceState.xtermProps = props;
        React.useEffect(() => () => {
            if (surfaceState.xtermProps === props) surfaceState.xtermProps = null;
        }, [props]);
        return React.createElement('XtermWebViewSurface', props, props.children);
    }),
}));

vi.mock('@/components/terminal/ghostty/surface.native', () => ({
    GhosttyTerminalSurface: React.forwardRef<unknown, Readonly<{ children?: React.ReactNode; surfaceId?: string }>>((props, _ref) => {
        surfaceState.ghosttyProps = props;
        if (props.surfaceId) surfaceState.ghosttySurfaceIds.push(props.surfaceId);
        React.useEffect(() => () => {
            if (surfaceState.ghosttyProps === props) surfaceState.ghosttyProps = null;
        }, [props]);
        return React.createElement('GhosttyTerminalSurface', props, props.children);
    }),
}));

vi.mock('@/components/terminal/termux/surface.native', () => ({
    TermuxTerminalSurface: React.forwardRef<unknown, Readonly<{ children?: React.ReactNode; surfaceId?: string }>>((props, _ref) => {
        surfaceState.termuxProps = props;
        if (props.surfaceId) surfaceState.termuxSurfaceIds.push(props.surfaceId);
        React.useEffect(() => () => {
            if (surfaceState.termuxProps === props) surfaceState.termuxProps = null;
        }, [props]);
        return React.createElement('TermuxTerminalSurface', props, props.children);
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Readonly<{ children?: React.ReactNode }>) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/code/editor/codeEditorFontMetrics', () => ({
    resolveCodeEditorFontMetrics: () => ({ fontSize: 14, lineHeight: 18 }),
}));

import { EmbeddedTerminalPane } from './EmbeddedTerminalPane.native';
import type { EmbeddedTerminalPaneController } from './types';

function makeController(): EmbeddedTerminalPaneController {
    return {
        status: 'connected',
        error: null,
        detectedUrl: null,
        onInput: vi.fn(),
        onPaste: vi.fn(),
        onResize: vi.fn(),
        onReady: vi.fn(),
        onWriteComplete: vi.fn(),
        clearTerminal: vi.fn(),
        requestRestart: vi.fn(),
        retryConnect: vi.fn(),
        dismissDetectedUrl: vi.fn(),
    };
}

function resetSurfaceState() {
    surfaceState.xtermProps = null;
    surfaceState.ghosttyProps = null;
    surfaceState.termuxProps = null;
    surfaceState.ghosttySurfaceIds = [];
    surfaceState.termuxSurfaceIds = [];
    featureState.enabled = {};
    localSettingState.terminalRendererPreference = 'auto';
    nativeAvailabilityState.availability = {
        available: false,
        reason: 'native-module-missing',
    };
}

describe('EmbeddedTerminalPane native renderer selection', () => {
    it('selects iOS Ghostty only when all native gates pass', async () => {
        platformState.os = 'ios';
        resetSurfaceState();

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
                nativeRenderer={{
                    featureEnabled: true,
                    platform: 'ios',
                    packageProofAccepted: true,
                    accessibilityAccepted: true,
                    crashFallbackAvailable: true,
                    availability: {
                        available: true,
                        platform: 'ios',
                        renderer: 'ios-ghosttykit',
                        moduleVersion: '0.0.0',
                        accessibility: 'fallback-required',
                    },
                }}
            />,
        );

        expect(surfaceState.ghosttyProps).not.toBeNull();
        expect((surfaceState.ghosttyProps as { accessibilityAccepted?: boolean }).accessibilityAccepted).toBe(true);
        expect(surfaceState.xtermProps).toBeNull();
        expect(surfaceState.termuxProps).toBeNull();
    });

    it('falls back to xterm WebView when Android Termux legal approval is absent', async () => {
        platformState.os = 'android';
        resetSurfaceState();

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
                nativeRenderer={{
                    featureEnabled: true,
                    platform: 'android',
                    legalAccepted: false,
                    packageProofAccepted: true,
                    accessibilityAccepted: true,
                    crashFallbackAvailable: true,
                    availability: {
                        available: true,
                        platform: 'android',
                        renderer: 'android-termux',
                        moduleVersion: '0.0.0',
                        accessibility: 'native',
                    },
                }}
            />,
        );

        expect(surfaceState.xtermProps).not.toBeNull();
        expect(surfaceState.ghosttyProps).toBeNull();
        expect(surfaceState.termuxProps).toBeNull();
    });

    it('selects iOS Ghostty from canonical feature and native availability gates without an override prop', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        featureState.enabled = {
            'terminal.transport.byteStream': true,
            'terminal.renderer.native': true,
            'terminal.renderer.iosGhostty': true,
        };
        nativeAvailabilityState.availability = {
            available: true,
            platform: 'ios',
            renderer: 'ios-ghosttykit',
            moduleVersion: '0.0.0',
            accessibility: 'native',
        };

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
            />,
        );

        expect(surfaceState.ghosttyProps).not.toBeNull();
        expect(surfaceState.xtermProps).toBeNull();
        expect(surfaceState.termuxProps).toBeNull();
    });

    it('keeps xterm WebView selected in auto mode when native accessibility needs an explicit experimental opt-in', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        featureState.enabled = {
            'terminal.transport.byteStream': true,
            'terminal.renderer.native': true,
            'terminal.renderer.iosGhostty': true,
        };
        nativeAvailabilityState.availability = {
            available: true,
            platform: 'ios',
            renderer: 'ios-ghosttykit',
            moduleVersion: '0.0.0',
            accessibility: 'fallback-required',
        };

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
            />,
        );

        expect(surfaceState.xtermProps).not.toBeNull();
        expect(surfaceState.ghosttyProps).toBeNull();
        expect(surfaceState.termuxProps).toBeNull();
    });

    it('selects native iOS when the user explicitly prefers the experimental native renderer', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native-experimental';
        featureState.enabled = {
            'terminal.transport.byteStream': true,
            'terminal.renderer.native': true,
            'terminal.renderer.iosGhostty': true,
        };
        nativeAvailabilityState.availability = {
            available: true,
            platform: 'ios',
            renderer: 'ios-ghosttykit',
            moduleVersion: '0.0.0',
            accessibility: 'fallback-required',
        };

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
            />,
        );

        expect(surfaceState.ghosttyProps).not.toBeNull();
        expect(surfaceState.xtermProps).toBeNull();
        expect(surfaceState.termuxProps).toBeNull();
    });

    it('uses terminal instance identity instead of UI test ids for native surface ids', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native-experimental';
        featureState.enabled = {
            'terminal.transport.byteStream': true,
            'terminal.renderer.native': true,
            'terminal.renderer.iosGhostty': true,
        };
        nativeAvailabilityState.availability = {
            available: true,
            platform: 'ios',
            renderer: 'ios-ghosttykit',
            moduleVersion: '0.0.0',
            accessibility: 'fallback-required',
        };

        await renderScreen(
            <>
                <EmbeddedTerminalPane
                    title="Terminal A"
                    controller={makeController()}
                    terminalRef={{ current: null }}
                    testIdPrefix="session-embedded-terminal"
                    nativeSurfaceKey="session:s1:terminal:primary"
                />
                <EmbeddedTerminalPane
                    title="Terminal B"
                    controller={makeController()}
                    terminalRef={{ current: null }}
                    testIdPrefix="session-embedded-terminal"
                    nativeSurfaceKey="session:s1:terminal:secondary"
                />
            </>,
        );

        expect(surfaceState.ghosttySurfaceIds).toEqual([
            'embedded-terminal:ios-ghosttykit:session:s1:terminal:primary',
            'embedded-terminal:ios-ghosttykit:session:s1:terminal:secondary',
        ]);
    });

    it('forces xterm WebView when the user selects the compatibility renderer', async () => {
        platformState.os = 'android';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'xterm-webview';
        featureState.enabled = {
            'terminal.transport.byteStream': true,
            'terminal.renderer.native': true,
            'terminal.renderer.androidTermux': true,
        };
        nativeAvailabilityState.availability = {
            available: true,
            platform: 'android',
            renderer: 'android-termux',
            moduleVersion: '0.0.0',
            accessibility: 'native',
        };

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
            />,
        );

        expect(surfaceState.xtermProps).not.toBeNull();
        expect(surfaceState.ghosttyProps).toBeNull();
        expect(surfaceState.termuxProps).toBeNull();
    });

    it('falls back to xterm WebView after a selected native renderer reports unavailable', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native-experimental';
        featureState.enabled = {
            'terminal.transport.byteStream': true,
            'terminal.renderer.native': true,
            'terminal.renderer.iosGhostty': true,
        };
        nativeAvailabilityState.availability = {
            available: true,
            platform: 'ios',
            renderer: 'ios-ghosttykit',
            moduleVersion: '0.0.0',
            accessibility: 'fallback-required',
        };

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
                nativeRenderer={{
                    featureEnabled: true,
                    platform: 'ios',
                    packageProofAccepted: true,
                    accessibilityAccepted: true,
                    crashFallbackAvailable: true,
                    availability: {
                        available: true,
                        platform: 'ios',
                        renderer: 'ios-ghosttykit',
                        moduleVersion: '0.0.0',
                        accessibility: 'fallback-required',
                    },
                }}
            />,
        );

        expect(surfaceState.ghosttyProps).not.toBeNull();
        expect(surfaceState.xtermProps).toBeNull();
        expect(surfaceState.termuxProps).toBeNull();

        await act(async () => {
            (surfaceState.ghosttyProps as { onUnavailable?: (reason: string) => void }).onUnavailable?.('renderer-unavailable');
        });

        expect(surfaceState.xtermProps).not.toBeNull();
        expect(surfaceState.termuxProps).toBeNull();
        expect(surfaceState.ghosttyProps).toBeNull();
    });

    it('keeps xterm WebView selected when byte-stream transport is disabled', async () => {
        platformState.os = 'android';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native-experimental';
        featureState.enabled = {
            'terminal.renderer.native': true,
            'terminal.renderer.androidTermux': true,
        };
        nativeAvailabilityState.availability = {
            available: true,
            platform: 'android',
            renderer: 'android-termux',
            moduleVersion: '0.0.0',
            accessibility: 'native',
        };

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
            />,
        );

        expect(surfaceState.xtermProps).not.toBeNull();
        expect(surfaceState.termuxProps).toBeNull();
        expect(surfaceState.ghosttyProps).toBeNull();
    });

    it('keeps xterm WebView selected on iOS when byte-stream transport is disabled', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native-experimental';
        featureState.enabled = {
            'terminal.renderer.native': true,
            'terminal.renderer.iosGhostty': true,
        };
        nativeAvailabilityState.availability = {
            available: true,
            platform: 'ios',
            renderer: 'ios-ghosttykit',
            moduleVersion: '0.0.0',
            accessibility: 'native',
        };

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
            />,
        );

        expect(surfaceState.xtermProps).not.toBeNull();
        expect(surfaceState.ghosttyProps).toBeNull();
        expect(surfaceState.termuxProps).toBeNull();
    });
});
