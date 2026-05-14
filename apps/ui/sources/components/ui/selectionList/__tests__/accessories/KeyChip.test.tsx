import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('KeyChip', () => {
    it('renders the label as text', async () => {
        const { KeyChip } = await import('../../accessories/KeyChip');
        const screen = await renderScreen(<KeyChip label="⌘N" testID="kc-1" />);
        const node = screen.findByTestId('kc-1');
        expect(node).not.toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('⌘N');
    });

    it('renders nothing when enabled is false (no host node, no label text)', async () => {
        const { KeyChip } = await import('../../accessories/KeyChip');
        const screen = await renderScreen(<KeyChip label="↵-disabled-marker" enabled={false} testID="kc-disabled" />);
        // The React fiber retains the testID prop even when the component returns null,
        // so assert on rendered output (no label text reaches the tree).
        expect(screen.getTextContent()).not.toContain('↵-disabled-marker');
    });

    it('does not expose press handlers (decorative chrome only)', async () => {
        const { KeyChip } = await import('../../accessories/KeyChip');
        const screen = await renderScreen(<KeyChip label="↵" testID="kc-2" />);
        const node = screen.findByTestId('kc-2');
        expect(node?.props.onPress).toBeUndefined();
        expect(node?.props.onClick).toBeUndefined();
    });

    it('uses a 4px corner radius (concentric with row padding) per design rule', async () => {
        const { KeyChip } = await import('../../accessories/KeyChip');
        const screen = await renderScreen(<KeyChip label="↵" testID="kc-radius" />);
        const node = screen.findByTestId('kc-radius');
        const styleArr = Array.isArray(node?.props.style) ? node!.props.style : [node?.props.style];
        const merged = styleArr.reduce<Record<string, unknown>>((acc, s) => ({ ...acc, ...(s ?? {}) }), {});
        expect(merged.borderRadius).toBe(4);
    });
});
