import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { collectRenderedTestIds, renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

/** Host-element placeholder so passed-in icon/action nodes carry a discoverable testID. */
const Stub = (props: { testID?: string }) => React.createElement('Stub', props);

describe('EmptyState', () => {
    it('renders the icon, title and subtitle', async () => {
        const { EmptyState } = await import('./EmptyState');

        const screen = await renderScreen(
            <EmptyState
                testID="empty"
                icon={<Stub testID="empty-icon" />}
                title="No accounts yet"
                subtitle="Connect an account to get started"
                titleTestID="empty-title"
                subtitleTestID="empty-subtitle"
            />,
        );

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('empty');
        expect(ids).toContain('empty-icon');

        const title = screen.findByTestId('empty-title');
        expect(title?.props.children).toBe('No accounts yet');
        const subtitle = screen.findByTestId('empty-subtitle');
        expect(subtitle?.props.children).toBe('Connect an account to get started');
    });

    it('renders the action when provided', async () => {
        const { EmptyState } = await import('./EmptyState');

        const screen = await renderScreen(
            <EmptyState
                icon={<Stub />}
                title="No pools yet"
                action={<Stub testID="cta" />}
                actionTestID="empty-action"
            />,
        );

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('empty-action');
        expect(ids).toContain('cta');
    });

    it('omits the action slot when no action is provided', async () => {
        const { EmptyState } = await import('./EmptyState');

        const screen = await renderScreen(
            <EmptyState icon={<Stub />} title="Nothing here" actionTestID="empty-action" />,
        );

        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).not.toContain('empty-action');
    });
});
