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

    it('renders nothing when disabled', async () => {
        const { KeyHint } = await import('./KeyHint');

        const screen = await renderScreen(<KeyHint label="esc-disabled-marker" enabled={false} testID="key-disabled" />);

        expect(screen.getTextContent()).not.toContain('esc-disabled-marker');
    });

    it('uses the named key-hint typography helper', async () => {
        const { KeyHint } = await import('./KeyHint');

        const screen = await renderScreen(<KeyHint label="esc" testID="key-hint" />);
        const textNode = screen.findByTestId('key-hint:label');
        const flat = flattenStyle(textNode?.props.style);

        expect(flat.fontFamily).toBeDefined();
        expect(Number(flat.fontSize)).toBeGreaterThan(0);
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}
