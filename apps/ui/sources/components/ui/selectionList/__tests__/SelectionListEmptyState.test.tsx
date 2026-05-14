import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SelectionListEmptyState', () => {
    it('renders the supplied label text', async () => {
        const { SelectionListEmptyState } = await import('../SelectionListEmptyState');
        const screen = await renderScreen(
            <SelectionListEmptyState label="No matches" testID="empty" />,
        );
        expect(screen.getTextContent()).toContain('No matches');
        expect(screen.findByTestId('empty')).not.toBeNull();
    });

    it('falls back to a generic empty-state copy when no label is provided', async () => {
        const { SelectionListEmptyState } = await import('../SelectionListEmptyState');
        const screen = await renderScreen(<SelectionListEmptyState testID="empty-default" />);
        expect(screen.getTextContent().length).toBeGreaterThan(0);
    });
});
