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

    it('renders the count and label with their accessible name', async () => {
        const { StatusPill } = await import('../../accessories/StatusPill');
        const screen = await renderScreen(
            <StatusPill variant="dirty" label="ch" count={3} testID="pill-dirty" />,
        );
        const text = screen.getTextContent();
        expect(text).toContain('3');
        expect(text).toContain('ch');
        expect(screen.findByTestId('pill-dirty')?.props.accessibilityLabel).toBe('ch 3');
    });

    it('renders a stable testID suffix per variant', async () => {
        const { StatusPill } = await import('../../accessories/StatusPill');
        const screen = await renderScreen(<StatusPill variant="info" label="info" testID="pill-info" />);
        // Variant-specific testID for selectors:
        expect(screen.findByTestId('pill-info:variant:info')).not.toBeNull();
    });
});
