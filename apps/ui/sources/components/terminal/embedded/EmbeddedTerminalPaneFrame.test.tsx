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
    it('keeps uncertain input recoverable with copy and discard while retaining output', async () => {
        const copyInputRecovery = vi.fn(async () => {});
        const discardInputRecovery = vi.fn();
        const screen = await renderScreen(<EmbeddedTerminalPaneFrame title="shell" controller={makeController({
            status: 'error', connectionLost: true, inputRecoveryAvailable: true, copyInputRecovery, discardInputRecovery,
        })} chrome="none" surface={React.createElement('TerminalSurface')} testIdPrefix="input" platformOS="web" />);
        expect(screen.findByTestId('input-surface')).toBeTruthy();
        expect(screen.findByTestId('input-overlay')).toBeFalsy();
        const copy = screen.findByTestId('input-recover-input');
        const discard = screen.findByTestId('input-discard-input');
        expect(copy).toBeTruthy();
        expect(discard).toBeTruthy();
        await copy?.props.onPress();
        discard?.props.onPress();
        expect(copyInputRecovery).toHaveBeenCalledOnce();
        expect(discardInputRecovery).toHaveBeenCalledOnce();
    });
    it('offers the shared pending-approval continuation while retaining the terminal surface', async () => {
        const onOpenApproval = vi.fn();
        const controller = { ...makeController({ status: 'connecting' }), approvalPending: true, onOpenApproval };
        const screen = await renderScreen(<EmbeddedTerminalPaneFrame title="shell" controller={controller}
            chrome="none" surface={React.createElement('TerminalSurface')} testIdPrefix="pending" platformOS="web" />);
        expect(screen.findByTestId('pending-surface')).toBeTruthy();
        expect(screen.findByTestId('pending-overlay')).toBeFalsy();
        screen.findByTestId('pending-state-line-action')?.props.onPress();
        expect(onOpenApproval).toHaveBeenCalledOnce();
    });
    it.each(['not-open', 'idle', 'connecting'] as const)('waits on consent as a quiet line, never Connecting, when %s and the approval is pending', async (status) => {
        const bare = await renderScreen(<EmbeddedTerminalPaneFrame title="shell" controller={{ ...makeController({ status }), approvalPending: true }}
            chrome="none" surface={React.createElement('TerminalSurface')} testIdPrefix="consent" platformOS="web" />);
        expect(bare.findByTestId('consent-state-line')).toBeTruthy();
        expect(bare.findByTestId('consent-state-line-spinner')).toBeFalsy();
        expect(bare.findByTestId('consent-overlay')).toBeFalsy();
        expect(bare.getTextContent()).toContain('approvals.waitingForYou');
        expect(bare.getTextContent()).not.toContain('terminalWorkspace.states.connecting');
        // Only the Approvals action needs the callback.
        expect(bare.findByTestId('consent-state-line-action')).toBeFalsy();
    });
    it('keeps a connected terminal live even when an approval is pending', async () => {
        const screen = await renderScreen(<EmbeddedTerminalPaneFrame title="shell" controller={{ ...makeController({ status: 'connected' }), approvalPending: true }}
            chrome="none" surface={React.createElement('TerminalSurface')} testIdPrefix="live" platformOS="web" />);
        expect(screen.findByTestId('live-state-line')).toBeFalsy();
    });
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

    it('presents a borrowed read-only output as a light log: no title row, no Reset, Refresh, paste, selection copy or Restart', async () => {
        const screen = await renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
            title: 'test',
            controller: makeController({ status: 'exited', readOnly: true }),
            surface: React.createElement('TerminalSurface'),
            toolbarActionsStart: React.createElement('OwnerCopy', { testID: 'owner-copy' }),
            onCopySelection: () => {},
            onPaste: () => {},
            testIdPrefix: 'term',
            platformOS: 'web',
        }));
        expect(screen.findByTestId('owner-copy')).toBeTruthy();
        for (const control of ['clear', 'restart', 'paste', 'copy-selection']) expect(screen.findByTestId(`term-${control}`)).toBeFalsy();
        expect(screen.findByTestId('term-state-line')).toBeTruthy();
        expect(screen.findByTestId('term-state-line-action')).toBeFalsy();
    });

    it('leaves its exited line to an owner that already states how the run ended, and still speaks for other states', async () => {
        const render = (controller: Partial<EmbeddedTerminalPaneController>) => renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
            title: 'test',
            chrome: 'none',
            ownerStatesExit: true,
            controller: makeController({ readOnly: true, ...controller }),
            surface: React.createElement('TerminalSurface'),
            testIdPrefix: 'term',
            platformOS: 'web',
        }));
        const exited = await render({ status: 'exited', exitCode: 17 });
        expect(exited.findByTestId('term-state-line')).toBeFalsy();
        expect(exited.findByTestId('term-surface')).toBeTruthy();
        const offline = await render({ status: 'error', error: 'terminal_machine_unreachable' });
        expect(offline.findByTestId('term-state-line')).toBeTruthy();
    });

    it('says once that earlier output is no longer retained, for a borrowed retained output only', async () => {
        const retention = (truncated: boolean) => ({ mode: 'byte-offset' as const, retainedFromCursor: truncated ? 4096 : 0, availableCursor: 9000, truncated });
        const render = (controller: Partial<EmbeddedTerminalPaneController>) => renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
            title: 'build',
            chrome: 'none',
            ownerStatesExit: true,
            controller: makeController({ status: 'exited', exitCode: 0, ...controller }),
            surface: React.createElement('TerminalSurface'),
            testIdPrefix: 'term',
            platformOS: 'web',
        }));
        expect((await render({ readOnly: true, outputRetention: retention(true) })).findByTestId('term-retained-notice')).toBeTruthy();
        expect((await render({ readOnly: true, outputRetention: retention(false) })).findByTestId('term-retained-notice')).toBeFalsy();
        // Unknown bounds (legacy transport) say nothing; a person's own shell scrollback is not announced.
        expect((await render({ readOnly: true, outputRetention: null })).findByTestId('term-retained-notice')).toBeFalsy();
        expect((await render({ readOnly: false, outputRetention: retention(true) })).findByTestId('term-retained-notice')).toBeFalsy();
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

    it('keeps the output and offers Reconnect, not "Couldn\'t start", when a connected stream drops', async () => {
        const retryConnect = vi.fn();
        const screen = await renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
            title: 'zsh',
            chrome: 'none',
            controller: makeController({ status: 'error', error: 'terminal_stream_dropped', connectionLost: true, retryConnect }),
            surface: React.createElement('TerminalSurface'),
            testIdPrefix: 'term',
            platformOS: 'web',
        }));
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(screen.findByTestId('term-overlay')).toBeFalsy();
        expect(rendered).toContain('terminalWorkspace.states.connectionLost');
        expect(rendered).not.toContain('terminalWorkspace.states.failedTitle');
        screen.findByTestId('term-state-line-action')?.props.onPress();
        expect(retryConnect).toHaveBeenCalledTimes(1);
    });

    it('keeps a retained terminal readable when attaching fails before its first read', async () => {
        const retryConnect = vi.fn();
        const screen = await renderScreen(<EmbeddedTerminalPaneFrame title="Script"
            controller={makeController({ status: 'error', error: 'terminal_access_denied', readOnly: true, retryConnect })}
            surface={React.createElement('TerminalSurface')} testIdPrefix="retained" platformOS="web" />);
        expect(screen.findByTestId('retained-overlay')).toBeFalsy();
        expect(screen.findByTestId('retained-state-line')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('terminalWorkspace.states.failedTitle');
        screen.findByTestId('retained-state-line-action')?.props.onPress();
        expect(retryConnect).toHaveBeenCalledOnce();
    });

    it.each([['not-open', undefined], ['error', 'terminal_cwd_denied']] as const)('hides a covered renderer (%s) while keeping it mounted, so nothing bleeds through a clear coat', async (status, error) => {
        const render = (next: EmbeddedTerminalPaneController) => renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
            title: 'zsh', chrome: 'none', controller: next, surface: React.createElement('TerminalSurface'),
            testIdPrefix: 'term', platformOS: 'web',
        }));
        const covered = await render(makeController({ status, error: error ?? null }));
        expect(covered.findByTestId('term-overlay')).toBeTruthy();
        expect(covered.findAllByType('TerminalSurface')).toHaveLength(1);
        expect(covered.findByTestId('term-renderer')?.props.pointerEvents).toBe('none');
        expect(flattenStyle(covered.findByTestId('term-renderer')?.props.style).opacity).toBe(0);
        const live = await render(makeController({ status: 'connected' }));
        expect(live.findByTestId('term-renderer')?.props.pointerEvents).not.toBe('none');
        expect(flattenStyle(live.findByTestId('term-renderer')?.props.style).opacity).not.toBe(0);
    });

    it('names the not-open state itself instead of repeating the terminal title the card already carries', async () => {
        const screen = await renderScreen(React.createElement(EmbeddedTerminalPaneFrame, {
            title: 'Terminal on NLDW4-5-40-40',
            chrome: 'none',
            controller: makeController({ status: 'not-open' }),
            surface: React.createElement('TerminalSurface'),
            testIdPrefix: 'term',
            platformOS: 'web',
        }));
        const rendered = JSON.stringify(screen.tree.toJSON());
        expect(rendered).toContain('terminalWorkspace.states.notOpen');
        expect(rendered).not.toContain('Terminal on NLDW4-5-40-40');
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
