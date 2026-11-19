import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('KeyHint', () => {
    it('renders a decorative keyboard hint without press handlers', async () => {
        const { KeyHint } = await import('./KeyHint');

        const screen = await renderScreen(<KeyHint label="⌘N" testID="key-hint" />);
        const node = screen.findByTestId('key-hint');

        expect(node).not.toBeNull();
        expect(node?.props.accessibilityLabel).toBe('⌘N');
        expect(node?.props.onPress).toBeUndefined();
        expect(screen.getTextContent()).toContain('⌘N');
    });

    it('draws arrows, Return and Escape as their keycap faces wherever a key is shown (shortcut sheet KB1)', async () => {
        const { KeyHint } = await import('./KeyHint');

        const screen = await renderScreen(<>
            <KeyHint label="ArrowDown" testID="down" />
            <KeyHint label="Enter" testID="enter" />
            <KeyHint label="Escape" testID="escape" />
        </>);

        expect(screen.findByTestId('down:label')?.props.children).toBe('↓');
        expect(screen.findByTestId('enter:label')?.props.children).toBe('↵');
        expect(screen.findByTestId('escape:label')?.props.children).toBe('Esc');
    });

    it('draws a resolved shortcut as one keycap per key with a keyboard, and nothing on a touch screen (Search rows)', async () => {
        const { KeyboardShortcutHint } = await import('./KeyHint');
        vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
        vi.stubGlobal('navigator', { maxTouchPoints: 0 });
        const keyboard = await renderScreen(<KeyboardShortcutHint label="Alt+N" testID="row-key" />);
        expect(keyboard.findByTestId('row-key')?.props.accessibilityLabel).toBe('Alt+N');
        // Caps per key, never one "Alt+N" cap.
        expect(keyboard.getTextContent()).not.toContain('+');
        expect(keyboard.getTextContent()).toContain('N');

        vi.stubGlobal('navigator', { maxTouchPoints: 5 });
        const touch = await renderScreen(<KeyboardShortcutHint label="Alt+N" testID="row-key" />);
        // The hint component stays mounted and draws nothing.
        expect(touch.getTextContent()).toBe('');
        vi.unstubAllGlobals();
    });

    it('renders nothing when disabled', async () => {
        const { KeyHint } = await import('./KeyHint');

        const screen = await renderScreen(<KeyHint label="esc-disabled-marker" enabled={false} testID="key-disabled" />);

        expect(screen.getTextContent()).not.toContain('esc-disabled-marker');
    });
});
