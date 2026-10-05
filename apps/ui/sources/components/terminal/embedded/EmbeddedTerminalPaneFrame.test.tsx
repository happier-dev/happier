/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installEmbeddedTerminalPaneCommonModuleMocks } from './embeddedTerminalPaneTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installEmbeddedTerminalPaneCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            Platform: {
                OS: 'web',
                select: (value: any) => value?.default ?? null,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    text: '#fff',
                    textSecondary: '#aaa',
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: (props: any) => React.createElement('PrimaryCircleIconButton', props, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: vi.fn(),
}));

vi.mock('@/utils/url/openExternalUrl', () => ({
    openExternalUrl: vi.fn(),
}));

vi.mock('@/components/sessions/terminal/terminalErrorCopy', () => ({
    resolveTerminalErrorCopy: () => null,
}));

import { EmbeddedTerminalPaneFrame } from './EmbeddedTerminalPaneFrame';
import { embeddedTerminalPaneStyles } from './embeddedTerminalPaneStyles';
import type { EmbeddedTerminalPaneController } from './types';

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function makeController(overrides: Partial<EmbeddedTerminalPaneController>): EmbeddedTerminalPaneController {
    return {
        status: 'connected',
        error: null,
        detectedUrl: null,
        onInput: () => {},
        onPaste: () => {},
        onResize: () => {},
        onReady: () => {},
        onWriteComplete: () => {},
        clearTerminal: () => {},
        requestRestart: () => {},
        retryConnect: () => {},
        dismissDetectedUrl: () => {},
        ...overrides,
    };
}

describe('EmbeddedTerminalPaneFrame states (terminal lab ST)', () => {
    it('without its own chrome, leaves the toolbar and the address to the owning strip', async () => {
        const screen = await renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
            title: 'zsh',
            chrome: 'none',
            controller: makeController({ detectedUrl: { url: 'http://localhost:5173/', kind: 'generic' } }),
            surface: React.createElement('TerminalSurface'),
            testIdPrefix: 'term',
            platformOS: 'web',
        }));
        expect(screen.findByTestId('term-clear')).toBeFalsy();
        expect(screen.findByTestId('term-url-banner')).toBeFalsy();
        expect(screen.findByTestId('term-surface')).toBeTruthy();
    });

    it('keeps an exited process\'s output readable and offers Restart instead of covering it', async () => {
        const requestRestart = vi.fn();
        const screen = await renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
            title: 'zsh',
            chrome: 'none',
            controller: makeController({ status: 'exited', requestRestart }),
            surface: React.createElement('TerminalSurface'),
            testIdPrefix: 'term',
            platformOS: 'web',
        }));
        expect(screen.findByTestId('term-overlay')).toBeFalsy();
        const line = screen.findByTestId('term-state-line');
        expect(line).toBeTruthy();
        screen.findByTestId('term-state-line-action')?.props.onPress();
        expect(requestRestart).toHaveBeenCalledTimes(1);
    });

    it('keeps the output when the machine goes offline, with one line and Check again', async () => {
        const retryConnect = vi.fn();
        const screen = await renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
            title: 'zsh',
            chrome: 'none',
            controller: makeController({ status: 'error', error: 'terminal_machine_unreachable', retryConnect }),
            surface: React.createElement('TerminalSurface'),
            testIdPrefix: 'term',
            platformOS: 'web',
        }));
        expect(screen.findByTestId('term-overlay')).toBeFalsy();
        screen.findByTestId('term-state-line-action')?.props.onPress();
        expect(retryConnect).toHaveBeenCalledTimes(1);
    });

    it('covers the surface with the cause and Try again when the terminal could not start', async () => {
        const retryConnect = vi.fn();
        const screen = await renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
            title: 'zsh',
            chrome: 'none',
            controller: makeController({ status: 'error', error: 'terminal_cwd_denied', retryConnect }),
            surface: React.createElement('TerminalSurface'),
            testIdPrefix: 'term',
            platformOS: 'web',
        }));
        expect(screen.findByTestId('term-overlay')).toBeTruthy();
        expect(screen.findByTestId('term-state-line')).toBeFalsy();
    });
});

describe('EmbeddedTerminalPaneFrame', () => {
    it('keeps every paint around the renderer nested in the content material', async () => {
        const { applyGlassDocumentPresentation } = await import('@/components/ui/glass/glassDocumentPresentation');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const screen = await renderScreen(<EmbeddedTerminalPaneFrame title="zsh" controller={makeController({ detectedUrl: { url: 'http://localhost:5173', kind: 'generic' } })} surface={React.createElement('TerminalSurface')} testIdPrefix="material-term" platformOS="web" />);
        const rootColor = flattenStyle(screen.findByTestId('material-term-root')?.props.style).backgroundColor;
        const bannerColor = flattenStyle(screen.findByTestId('material-term-url-banner')?.props.style).backgroundColor;
        const toolbarColor = flattenStyle(embeddedTerminalPaneStyles.toolbar).backgroundColor;
        const doc = document.implementation.createHTMLDocument();
        for (const opacity of [0, 0.2, 1]) {
            for (const reduceTransparency of [false, true]) {
                const stop = applyGlassDocumentPresentation(doc, { glassSurfaceMaterials: {
                    ...glassPresetMaterials('everywhere'), content: { blur: 'strong', opacity },
                } }, { desktopWindow: true, nativeWindowMaterialLive: true, reduceTransparency });
                try {
                    for (const color of [rootColor, toolbarColor, bannerColor]) {
                        const variable = typeof color === 'string' ? color.match(/var\((--happier-glass-content-nested-opacity),/) : null;
                        const alpha = variable ? parseFloat(doc.documentElement.style.getPropertyValue(variable[1]!)) / 100 : 1;
                        // One coat belongs to the shell; terminal paints add none
                        // at 0/.2, and restore semantic solid hues on OS recovery.
                        expect(alpha).toBe(reduceTransparency || opacity === 1 ? 1 : 0);
                    }
                } finally { stop(); }
            }
        }
    });

    it('keeps the failure overlay inside the terminal surface so toolbar actions remain accessible', async () => {
        const controller: EmbeddedTerminalPaneController = {
            status: 'error',
            error: 'terminal_spawn_failed',
            detectedUrl: null,
            onInput: () => {},
            onPaste: () => {},
            onResize: () => {},
            onReady: () => {},
            onWriteComplete: () => {},
            clearTerminal: () => {},
            requestRestart: () => {},
            retryConnect: () => {},
            dismissDetectedUrl: () => {},
        };

        const screen = await renderScreen(
            React.createElement(EmbeddedTerminalPaneFrame, {
                title: 'Provider login terminal',
                controller,
                onRequestClose: () => {},
                surface: React.createElement('TerminalSurface'),
                testIdPrefix: 'provider-auth-terminal',
                platformOS: 'web',
            }),
        );

        const overlay = screen.findByTestId('provider-auth-terminal-overlay');
        expect(overlay).toBeTruthy();
        expect(overlay?.parent?.props.style).toBe(embeddedTerminalPaneStyles.terminalSurface);
        expect(screen.findByTestId('provider-auth-terminal-close')).toBeTruthy();
    });

    it('reserves bottom space for the native keyboard inside the terminal surface', async () => {
        const controller: EmbeddedTerminalPaneController = {
            status: 'connected',
            error: null,
            detectedUrl: null,
            onInput: () => {},
            onPaste: () => {},
            onResize: () => {},
            onReady: () => {},
            onWriteComplete: () => {},
            clearTerminal: () => {},
            requestRestart: () => {},
            retryConnect: () => {},
            dismissDetectedUrl: () => {},
        };

        const screen = await renderScreen(
            React.createElement(EmbeddedTerminalPaneFrame, {
                title: 'Terminal',
                controller,
                surface: React.createElement('TerminalSurface'),
                footer: React.createElement('QuickKeys'),
                testIdPrefix: 'embedded-terminal',
                platformOS: 'ios',
                keyboardBottomInset: 216,
            }),
        );

        // The footer (the phone key rail) sits last, above the keyboard, at the full width.
        const footer = screen.findByTestId('embedded-terminal-footer');
        expect(flattenStyle(footer?.props.style).marginBottom).toBe(216);
        expect(flattenStyle(screen.findByTestId('embedded-terminal-surface')?.props.style).marginBottom).toBeUndefined();
    });

    it('does not add a second keyboard inset on Android because the window already resizes', async () => {
        const controller: EmbeddedTerminalPaneController = {
            status: 'connected',
            error: null,
            detectedUrl: null,
            onInput: () => {},
            onPaste: () => {},
            onResize: () => {},
            onReady: () => {},
            onWriteComplete: () => {},
            clearTerminal: () => {},
            requestRestart: () => {},
            retryConnect: () => {},
            dismissDetectedUrl: () => {},
        };

        const screen = await renderScreen(
            React.createElement(EmbeddedTerminalPaneFrame, {
                title: 'Terminal',
                controller,
                surface: React.createElement('TerminalSurface'),
                footer: React.createElement('QuickKeys'),
                testIdPrefix: 'embedded-terminal',
                platformOS: 'android',
                keyboardBottomInset: 216,
            }),
        );

        expect(flattenStyle(screen.findByTestId('embedded-terminal-footer')?.props.style).marginBottom).toBeUndefined();
    });
});
