import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installEmbeddedTerminalPaneCommonModuleMocks } from './embeddedTerminalPaneTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('EmbeddedTerminalPaneFrame', () => {
    it('keeps the disconnected overlay inside the terminal surface so toolbar actions remain accessible', async () => {
        const controller: EmbeddedTerminalPaneController = {
            status: 'exited',
            error: null,
            detectedUrl: null,
            onInput: () => {},
            onResize: () => {},
            onReady: () => {},
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
            onResize: () => {},
            onReady: () => {},
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

        const surface = screen.findByTestId('embedded-terminal-surface');
        expect(flattenStyle(surface?.props.style).marginBottom).toBe(216);
    });
});
