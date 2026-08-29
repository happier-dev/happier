import * as React from 'react';
import { Platform } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'ios',
}));

const surfaceState = vi.hoisted(() => ({
    xtermProps: null as unknown,
    xtermMountCount: 0,
    ghosttyProps: null as unknown,
    termuxProps: null as unknown,
    ghosttySurfaceIds: [] as string[],
    termuxSurfaceIds: [] as string[],
    ghosttyCopySelection: vi.fn(),
    termuxCopySelection: vi.fn(),
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

const nativeQaState = vi.hoisted(() => ({
    enabled: false,
    injectRendererCrash: vi.fn(async (_surfaceId: string) => ({ injected: false, reason: 'qa-disabled' })),
}));

const localSettingState = vi.hoisted(() => ({
    terminalRendererPreference: 'auto',
    terminalNativeRendererQuarantine: null as unknown,
}));

const screenReaderState = vi.hoisted(() => ({
    enabled: false,
    notify: null as ((enabled: boolean) => void) | null,
}));

const localSettingMutations = vi.hoisted(() => ({
    setTerminalNativeRendererQuarantine: vi.fn((value: unknown) => {
        localSettingState.terminalNativeRendererQuarantine = value;
    }),
}));

const clipboardState = vi.hoisted(() => ({
    setClipboardStringSafe: vi.fn(async () => true),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (value: Record<string, unknown>) => value[platformState.os] ?? value.default ?? null,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'terminalRendererPreference') return localSettingState.terminalRendererPreference;
        if (key === 'terminalNativeRendererQuarantine') return localSettingState.terminalNativeRendererQuarantine;
        return 1;
    },
    useLocalSettingMutable: (key: string) => {
        if (key === 'terminalNativeRendererQuarantine') {
            return [localSettingState.terminalNativeRendererQuarantine, localSettingMutations.setTerminalNativeRendererQuarantine];
        }
        return [1, vi.fn()];
    },
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/hooks/ui/useScreenReaderEnabled', () => ({
    useScreenReaderEnabled: () => {
        const [enabled, setEnabled] = React.useState(screenReaderState.enabled);
        React.useEffect(() => {
            screenReaderState.notify = setEnabled;
            return () => {
                if (screenReaderState.notify === setEnabled) screenReaderState.notify = null;
            };
        }, []);
        return enabled;
    },
}));

vi.mock('@/utils/ui/clipboard', () => ({
    getClipboardStringTrimmedSafe: vi.fn(async () => ''),
    setClipboardStringSafe: clipboardState.setClipboardStringSafe,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureState.enabled[featureId] === true,
}));

vi.mock('@happier-dev/terminal-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/terminal-native')>();
    return {
        ...actual,
        getTerminalNativeAvailability: () => nativeAvailabilityState.availability,
        getTerminalNativeQaCapabilities: () => ({ rendererCrashInjection: nativeQaState.enabled }),
        injectTerminalNativeRendererCrashForQa: nativeQaState.injectRendererCrash,
    };
});

vi.mock('@/components/terminal/xterm/webview/XtermWebViewSurface.native', () => ({
    XtermWebViewSurface: React.forwardRef<unknown, Readonly<{ children?: React.ReactNode }>>((props, _ref) => {
        surfaceState.xtermProps = props;
        React.useEffect(() => {
            surfaceState.xtermMountCount += 1;
        }, []);
        React.useEffect(() => () => {
            if (surfaceState.xtermProps === props) surfaceState.xtermProps = null;
        }, [props]);
        return React.createElement('XtermWebViewSurface', props, props.children);
    }),
}));

vi.mock('@/components/terminal/ghostty/surface.native', () => ({
    GhosttyTerminalSurface: React.forwardRef<unknown, Readonly<{ children?: React.ReactNode; surfaceId?: string }>>((props, ref) => {
        React.useImperativeHandle(ref, () => ({ copySelection: surfaceState.ghosttyCopySelection }));
        surfaceState.ghosttyProps = props;
        if (props.surfaceId) surfaceState.ghosttySurfaceIds.push(props.surfaceId);
        React.useEffect(() => () => {
            if (surfaceState.ghosttyProps === props) surfaceState.ghosttyProps = null;
        }, [props]);
        return React.createElement('GhosttyTerminalSurface', props, props.children);
    }),
}));

vi.mock('@/components/terminal/termux/surface.native', () => ({
    TermuxTerminalSurface: React.forwardRef<unknown, Readonly<{ children?: React.ReactNode; surfaceId?: string }>>((props, ref) => {
        React.useImperativeHandle(ref, () => ({ copySelection: surfaceState.termuxCopySelection }));
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

function makeController(): EmbeddedTerminalPaneController & Readonly<{
    copySelection: ReturnType<typeof vi.fn>;
}> {
    return {
        status: 'connected',
        error: null,
        detectedUrl: null,
        onInput: vi.fn(),
        onPaste: vi.fn(),
        onResize: vi.fn(),
        onReady: vi.fn(),
        onWriteComplete: vi.fn(),
        copySelection: vi.fn(),
        clearTerminal: vi.fn(),
        requestRestart: vi.fn(),
        retryConnect: vi.fn(),
        dismissDetectedUrl: vi.fn(),
    };
}

function resetSurfaceState() {
    surfaceState.xtermProps = null;
    surfaceState.xtermMountCount = 0;
    surfaceState.ghosttyProps = null;
    surfaceState.termuxProps = null;
    surfaceState.ghosttySurfaceIds = [];
    surfaceState.termuxSurfaceIds = [];
    surfaceState.ghosttyCopySelection.mockReset();
    surfaceState.termuxCopySelection.mockReset();
    featureState.enabled = {};
    screenReaderState.enabled = false;
    screenReaderState.notify = null;
    localSettingState.terminalRendererPreference = 'auto';
    localSettingState.terminalNativeRendererQuarantine = null;
    localSettingMutations.setTerminalNativeRendererQuarantine.mockClear();
    clipboardState.setClipboardStringSafe.mockReset();
    nativeAvailabilityState.availability = {
        available: false,
        reason: 'native-module-missing',
    };
    nativeQaState.enabled = false;
    nativeQaState.injectRendererCrash.mockReset();
    nativeQaState.injectRendererCrash.mockResolvedValue({ injected: false, reason: 'qa-disabled' });
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
        expect(surfaceState.ghosttyProps).toMatchObject({
            accessibilityAccepted: true,
            accessibilityTerminalLabel: 'terminalEmbedded.nativeAccessibility.terminalLabel',
            accessibilityFallbackValue: 'terminalEmbedded.nativeAccessibility.fallbackValue',
            accessibilityFocusActionLabel: 'terminalEmbedded.nativeAccessibility.focusAction',
            accessibilityCopySelectionActionLabel: 'terminalEmbedded.nativeAccessibility.copySelectionAction',
            accessibilitySelectAllActionLabel: 'terminalEmbedded.nativeAccessibility.selectAllAction',
            accessibilityOpenLinkActionLabel: 'terminalEmbedded.nativeAccessibility.openLinkAction',
        });
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

    it('routes xterm WebView paste envelopes through the terminal controller policy', async () => {
        platformState.os = 'android';
        resetSurfaceState();
        const controller = makeController();

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={controller}
                terminalRef={{ current: null }}
            />,
        );

        expect(surfaceState.xtermProps).not.toBeNull();
        expect((surfaceState.xtermProps as {
            onPaste?: (text: string) => void;
        }).onPaste).toBe(controller.onPaste);
    });

    it('reconnects and remounts xterm after its boot retry is exhausted without restarting the PTY', async () => {
        platformState.os = 'android';
        resetSurfaceState();
        const controller = makeController();

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={controller}
                terminalRef={{ current: null }}
            />,
        );

        expect(surfaceState.xtermMountCount).toBe(1);

        await act(async () => {
            (surfaceState.xtermProps as {
                onRendererFailure?: (failure: Readonly<{
                    type: 'boot-retry-exhausted';
                    code: string;
                    rejectedWrites: readonly unknown[];
                }>) => void;
            }).onRendererFailure?.({
                type: 'boot-retry-exhausted',
                code: 'terminal_boot_failed',
                rejectedWrites: [],
            });
        });

        expect(controller.retryConnect).toHaveBeenCalledTimes(1);
        expect(controller.requestRestart).not.toHaveBeenCalled();
        expect(surfaceState.xtermMountCount).toBe(2);
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

    it('selects native iOS when the user explicitly prefers the native renderer', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native';
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
                testIdPrefix="terminal"
            />,
        );

        expect(surfaceState.ghosttyProps).not.toBeNull();
        expect(surfaceState.ghosttyProps).toMatchObject({ testID: 'terminal-ghostty-native' });
        expect(surfaceState.xtermProps).toBeNull();
        expect(surfaceState.termuxProps).toBeNull();
    });

    it('routes Ghostty copy events through the host clipboard owner', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native';
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

        const controller = makeController();
        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={controller}
                terminalRef={{ current: null }}
            />,
        );

        await act(async () => {
            (surfaceState.ghosttyProps as {
                onCopy?: (event: Readonly<{ surfaceId: string; text: string }>) => void;
            }).onCopy?.({
                surfaceId: 'embedded-terminal:ios-ghosttykit:embedded-terminal',
                text: 'selected terminal output',
            });
        });

        expect(controller.copySelection).toHaveBeenCalledWith({
            source: 'user-selection',
            text: 'selected terminal output',
        });
        expect(clipboardState.setClipboardStringSafe).not.toHaveBeenCalled();
    });

    it('asks the selected iOS Ghostty surface to copy its real selection through the host clipboard path', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native';
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
        const terminalRef = { current: null } as React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
        const controller = makeController();
        const screen = await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={controller}
                terminalRef={terminalRef}
                testIdPrefix="terminal"
            />,
        );

        await act(async () => {
            screen.tree?.root.findByProps({ testID: 'terminal-copy-selection' }).props.onPress();
        });

        expect(surfaceState.ghosttyCopySelection).toHaveBeenCalledTimes(1);

        await act(async () => {
            (surfaceState.ghosttyProps as {
                onCopy?: (event: Readonly<{ surfaceId: string; text: string }>) => void;
            }).onCopy?.({
                surfaceId: 'embedded-terminal:ios-ghosttykit:terminal',
                text: 'only Ghostty selection text',
            });
        });

        expect(controller.copySelection).toHaveBeenCalledWith({
            source: 'user-selection',
            text: 'only Ghostty selection text',
        });
        expect(clipboardState.setClipboardStringSafe).not.toHaveBeenCalled();
    });

    it('asks the selected Android Termux surface to copy its real selection through the host clipboard path', async () => {
        platformState.os = 'android';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native';
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
            accessibility: 'fallback-required',
        };
        const terminalRef = { current: null } as React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
        const controller = makeController();
        const screen = await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={controller}
                terminalRef={terminalRef}
                testIdPrefix="terminal"
            />,
        );

        await act(async () => {
            screen.tree?.root.findByProps({ testID: 'terminal-copy-selection' }).props.onPress();
        });

        expect(surfaceState.termuxCopySelection).toHaveBeenCalledTimes(1);

        await act(async () => {
            (surfaceState.termuxProps as {
                onCopy?: (event: Readonly<{ surfaceId: string; text: string }>) => void;
            }).onCopy?.({
                surfaceId: 'embedded-terminal:android-termux:terminal',
                text: 'only Termux selection text',
            });
        });

        expect(controller.copySelection).toHaveBeenCalledWith({
            source: 'user-selection',
            text: 'only Termux selection text',
        });
        expect(clipboardState.setClipboardStringSafe).not.toHaveBeenCalled();
    });

    it('routes Android Termux copy events through the host clipboard owner', async () => {
        platformState.os = 'android';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native';
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
            accessibility: 'fallback-required',
        };
        expect(Platform.OS).toBe('android');

        const controller = makeController();
        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={controller}
                terminalRef={{ current: null }}
                testIdPrefix="terminal"
            />,
        );

        expect(surfaceState.termuxProps).not.toBeNull();
        expect(surfaceState.termuxProps).toMatchObject({
            testID: 'terminal-termux-native',
            accessibilityTerminalLabel: 'terminalEmbedded.nativeAccessibility.terminalLabel',
            accessibilityFallbackValue: 'terminalEmbedded.nativeAccessibility.fallbackValue',
            accessibilityFocusActionLabel: 'terminalEmbedded.nativeAccessibility.focusAction',
            accessibilityCopySelectionActionLabel: 'terminalEmbedded.nativeAccessibility.copySelectionAction',
            accessibilitySelectAllActionLabel: 'terminalEmbedded.nativeAccessibility.selectAllAction',
            accessibilityOpenLinkActionLabel: 'terminalEmbedded.nativeAccessibility.openLinkAction',
        });
        expect(surfaceState.xtermProps).toBeNull();

        await act(async () => {
            (surfaceState.termuxProps as {
                onCopy?: (event: Readonly<{ surfaceId: string; text: string }>) => void;
            }).onCopy?.({
                surfaceId: 'embedded-terminal:android-termux:embedded-terminal',
                text: 'selected Android terminal output',
            });
        });

        expect(controller.copySelection).toHaveBeenCalledWith({
            source: 'user-selection',
            text: 'selected Android terminal output',
        });
        expect(clipboardState.setClipboardStringSafe).not.toHaveBeenCalled();
    });

    it('persists a next-launch quarantine only for an attributed fatal native renderer termination', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native';
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
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

        try {
            await renderScreen(
                <EmbeddedTerminalPane
                    title="Terminal"
                    controller={makeController()}
                    terminalRef={{ current: null }}
                />,
            );

            await act(async () => {
                (surfaceState.ghosttyProps as {
                    onRendererCrash?: (event: Readonly<{ surfaceId: string; reason: string; fatal?: boolean }>) => void;
                }).onRendererCrash?.({
                    surfaceId: 'embedded-terminal:ios-ghosttykit:embedded-terminal',
                    reason: 'renderer-terminated',
                    fatal: true,
                });
            });

            expect(localSettingMutations.setTerminalNativeRendererQuarantine).toHaveBeenCalledWith({
                renderer: 'ios-ghosttykit',
                expiresAtMs: 1_700_086_400_000,
            });
            expect(surfaceState.xtermProps).not.toBeNull();
        } finally {
            now.mockRestore();
        }
    });

    it('exposes no renderer crash injection control without an explicit QA-surface opt-in', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        nativeQaState.enabled = true;
        localSettingState.terminalRendererPreference = 'native';
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

        const screen = await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
                testIdPrefix="terminal"
            />,
        );

        expect(() => screen.tree?.root.findByProps({ testID: 'terminal-native-qa-inject-renderer-crash' })).toThrow();
        expect(nativeQaState.injectRendererCrash).not.toHaveBeenCalled();
    });

    it('targets the active native surface and falls back with persisted quarantine after a QA-injected native fatal event', async () => {
        platformState.os = 'android';
        resetSurfaceState();
        nativeQaState.enabled = true;
        localSettingState.terminalRendererPreference = 'native';
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
            accessibility: 'fallback-required',
        };
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        nativeQaState.injectRendererCrash.mockImplementation(async (surfaceId: string) => {
            (surfaceState.termuxProps as {
                onRendererCrash?: (event: Readonly<{ surfaceId: string; reason: string; fatal: true }>) => void;
            }).onRendererCrash?.({
                surfaceId,
                reason: 'qa-injected-renderer-crash',
                fatal: true,
            });
            return { injected: true, surfaceId };
        });

        try {
            const screen = await renderScreen(
                <EmbeddedTerminalPane
                    title="Terminal"
                    controller={makeController()}
                    terminalRef={{ current: null }}
                    testIdPrefix="terminal"
                    enableNativeRendererQaCrashControl={true}
                />,
            );

            await act(async () => {
                screen.tree?.root.findByProps({ testID: 'terminal-native-qa-inject-renderer-crash' }).props.onPress();
            });

            expect(nativeQaState.injectRendererCrash).toHaveBeenCalledWith('embedded-terminal:android-termux:terminal');
            expect(localSettingMutations.setTerminalNativeRendererQuarantine).toHaveBeenCalledWith({
                renderer: 'android-termux',
                expiresAtMs: 1_700_086_400_000,
            });
            expect(surfaceState.xtermProps).not.toBeNull();
            expect(surfaceState.termuxProps).toBeNull();

            localSettingState.terminalNativeRendererQuarantine = null;
            await act(async () => {
                screen.tree?.update(
                    <EmbeddedTerminalPane
                        title="Terminal"
                        controller={makeController()}
                        terminalRef={{ current: null }}
                        testIdPrefix="terminal"
                        enableNativeRendererQaCrashControl={true}
                    />,
                );
            });

            expect(surfaceState.termuxProps).not.toBeNull();
        } finally {
            now.mockRestore();
        }
    });

    it('keeps recoverable native unavailability in-memory and out of the persisted fatal quarantine', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native';
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

        await act(async () => {
            (surfaceState.ghosttyProps as { onUnavailable?: (reason: string) => void }).onUnavailable?.('renderer-unavailable');
        });

        expect(surfaceState.xtermProps).not.toBeNull();
        expect(localSettingMutations.setTerminalNativeRendererQuarantine).not.toHaveBeenCalled();
    });

    it('uses an unexpired fatal quarantine for xterm fallback and clears it once it expires', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native';
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
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

        try {
            localSettingState.terminalNativeRendererQuarantine = {
                renderer: 'ios-ghosttykit',
                expiresAtMs: 1_700_086_400_000,
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

            localSettingState.terminalNativeRendererQuarantine = {
                renderer: 'ios-ghosttykit',
                expiresAtMs: 1_699_999_999_999,
            };
            await renderScreen(
                <EmbeddedTerminalPane
                    title="Terminal"
                    controller={makeController()}
                    terminalRef={{ current: null }}
                />,
            );

            expect(surfaceState.ghosttyProps).not.toBeNull();
            expect(localSettingMutations.setTerminalNativeRendererQuarantine).toHaveBeenCalledWith(null);
        } finally {
            now.mockRestore();
        }
    });

    it('uses terminal instance identity instead of UI test ids for native surface ids', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        localSettingState.terminalRendererPreference = 'native';
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
        localSettingState.terminalRendererPreference = 'native';
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
        localSettingState.terminalRendererPreference = 'native';
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
        localSettingState.terminalRendererPreference = 'native';
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

    it('selects the native renderer by default in auto mode without an active screen reader on both platforms', async () => {
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

        expect(surfaceState.ghosttyProps).not.toBeNull();
        expect(surfaceState.xtermProps).toBeNull();
        expect(surfaceState.termuxProps).toBeNull();

        platformState.os = 'android';
        resetSurfaceState();
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
            accessibility: 'fallback-required',
        };

        await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={makeController()}
                terminalRef={{ current: null }}
            />,
        );

        expect(surfaceState.termuxProps).not.toBeNull();
        expect(surfaceState.xtermProps).toBeNull();
        expect(surfaceState.ghosttyProps).toBeNull();
    });

    it('switches the auto default between native and xterm WebView as the screen reader toggles without changing the pane controller', async () => {
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
        const controller = makeController();
        const screen = await renderScreen(
            <EmbeddedTerminalPane
                title="Terminal"
                controller={controller}
                terminalRef={{ current: null }}
            />,
        );
        expect(surfaceState.ghosttyProps).not.toBeNull();

        screenReaderState.enabled = true;
        await act(async () => {
            screenReaderState.notify?.(true);
        });
        expect(surfaceState.xtermProps).not.toBeNull();
        expect(surfaceState.ghosttyProps).toBeNull();
        expect(surfaceState.xtermProps).toMatchObject({ onInput: controller.onInput });

        screenReaderState.enabled = false;
        await act(async () => {
            screenReaderState.notify?.(false);
        });
        expect(surfaceState.ghosttyProps).not.toBeNull();
        expect(surfaceState.xtermProps).toBeNull();
    });

    it('keeps the native renderer with a screen reader active when the module reports native accessibility', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        screenReaderState.enabled = true;
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
        expect(surfaceState.ghosttyProps).toMatchObject({ accessibilityAccepted: true });
        expect(surfaceState.xtermProps).toBeNull();
    });

    it('keeps the explicit native preference selected with a screen reader active while native accessibility stays fallback-required', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
        screenReaderState.enabled = true;
        localSettingState.terminalRendererPreference = 'native';
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
    });

    it('keeps xterm WebView selected from the auto default when a hard native gate fails without a screen reader', async () => {
        platformState.os = 'ios';
        resetSurfaceState();
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

    it('routes the auto-default native renderer through the same fatal quarantine fallback', async () => {
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
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

        try {
            await renderScreen(
                <EmbeddedTerminalPane
                    title="Terminal"
                    controller={makeController()}
                    terminalRef={{ current: null }}
                />,
            );
            expect(surfaceState.ghosttyProps).not.toBeNull();

            await act(async () => {
                (surfaceState.ghosttyProps as {
                    onRendererCrash?: (event: Readonly<{ surfaceId: string; reason: string; fatal?: boolean }>) => void;
                }).onRendererCrash?.({
                    surfaceId: 'embedded-terminal:ios-ghosttykit:embedded-terminal',
                    reason: 'renderer-terminated',
                    fatal: true,
                });
            });

            expect(surfaceState.xtermProps).not.toBeNull();
            expect(localSettingMutations.setTerminalNativeRendererQuarantine).toHaveBeenCalledWith({
                renderer: 'ios-ghosttykit',
                expiresAtMs: 1_700_086_400_000,
            });
        } finally {
            now.mockRestore();
        }
    });
});
