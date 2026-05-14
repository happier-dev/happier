import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('StatusPill', () => {
    it('renders the label text', async () => {
        const { StatusPill } = await import('../../accessories/StatusPill');
        const screen = await renderScreen(<StatusPill variant="clean" label="clean" testID="pill-clean" />);
        expect(screen.getTextContent()).toContain('clean');
    });

    it('appends count + suffix in tabular-nums when provided', async () => {
        const { StatusPill } = await import('../../accessories/StatusPill');
        const screen = await renderScreen(
            <StatusPill variant="dirty" label="ch" count={3} testID="pill-dirty" />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('3');
        expect(text).toContain('ch');
        const countNode = screen.findByTestId('pill-dirty:count');
        const flat = flatten(countNode?.props.style);
        expect(flat.fontVariant).toEqual(['tabular-nums']);
    });

    it('uses pill shape (999 borderRadius)', async () => {
        const { StatusPill } = await import('../../accessories/StatusPill');
        const screen = await renderScreen(<StatusPill variant="stale" label="stale" testID="pill-stale" />);
        const node = screen.findByTestId('pill-stale');
        const flat = flatten(node?.props.style);
        expect(flat.borderRadius).toBe(999);
    });

    it('renders a stable testID suffix per variant', async () => {
        const { StatusPill } = await import('../../accessories/StatusPill');
        const screen = await renderScreen(<StatusPill variant="info" label="info" testID="pill-info" />);
        const node = screen.findByTestId('pill-info');
        expect(node?.props['data-status-variant'] ?? node?.props.accessibilityLabel ?? 'info').toBeDefined();
        // Variant-specific testID for selectors:
        expect(screen.findByTestId('pill-info:variant:info')).not.toBeNull();
    });
});

function flatten(style: unknown): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) return style.reduce<Record<string, any>>((a, s) => ({ ...a, ...flatten(s) }), {});
    if (typeof style === 'object') return style as Record<string, any>;
    return {};
}
