import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: (props: any) => React.createElement('View', props, props.children),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                surface: '#000',
                surfaceHigh: '#111',
                divider: '#222',
                text: '#fff',
                textSecondary: '#aaa',
            },
        }),
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#fff',
                textSecondary: '#aaa',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: (props: any) => React.createElement('PrimaryCircleIconButton', props, props.children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
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

describe('EmbeddedTerminalPaneFrame', () => {
    it('keeps the disconnected overlay inside the terminal surface so toolbar actions remain accessible', () => {
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

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <EmbeddedTerminalPaneFrame
                    title="Provider login terminal"
                    controller={controller}
                    onRequestClose={() => {}}
                    surface={React.createElement('TerminalSurface')}
                    testIdPrefix="provider-auth-terminal"
                    platformOS="web"
                />
            );
        });

        const overlay = tree!.root.findByProps({ testID: 'provider-auth-terminal-overlay' });
        expect(overlay.parent?.props.style).toBe(embeddedTerminalPaneStyles.terminalSurface);
        expect(tree!.root.findByProps({ testID: 'provider-auth-terminal-close' })).toBeTruthy();
    });
});
