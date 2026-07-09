import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('Text', props, props.children),
}));

describe('MessageActionRow', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders timestamp and action slot with stable row test ids', async () => {
        const { MessageActionRow } = await import('./MessageActionRow');

        const screen = await renderScreen(
            <MessageActionRow
                messageId="m1"
                timestampText="May 19, 2026, 4:30 PM"
                showActions
                pointerEvents="auto"
                isWeb
                invertTimestampAndActions={false}
            >
                <View testID="child-action" />
            </MessageActionRow>,
        );

        expect(screen.findByTestId('transcript-message-actions-row:m1')).toBeTruthy();
        expect(screen.findByTestId('transcript-message-timestamp:m1')?.props.children).toBe('May 19, 2026, 4:30 PM');
        expect(screen.findByTestId('transcript-message-actions:m1')?.props.accessibilityElementsHidden).toBe(false);
        expect(screen.findByTestId('child-action')).toBeTruthy();
    });

    it('hides the row and action descendants when neither timestamp nor actions are visible', async () => {
        const { MessageActionRow } = await import('./MessageActionRow');

        const screen = await renderScreen(
            <MessageActionRow
                messageId="hidden"
                timestampText={null}
                showActions={false}
                pointerEvents="none"
                isWeb={false}
                invertTimestampAndActions={false}
            >
                <View testID="hidden-child-action" />
            </MessageActionRow>,
        );

        const row = screen.findByTestId('transcript-message-actions-row:hidden');
        const actions = screen.findByTestId('transcript-message-actions:hidden');

        expect(screen.findAllByTestId('transcript-message-timestamp:hidden')).toHaveLength(0);
        expect(row?.props.pointerEvents).toBe('none');
        expect(flattenStyle(row?.props.style).opacity).toBe(0);
        expect(actions?.props.accessibilityElementsHidden).toBe(true);
        expect(actions?.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('uses style-level pointer events on web and inverts timestamp spacing when requested', async () => {
        const { MessageActionRow } = await import('./MessageActionRow');

        const screen = await renderScreen(
            <MessageActionRow
                messageId="web-inverted"
                timestampText="Now"
                showActions={false}
                pointerEvents="none"
                isWeb
                invertTimestampAndActions
            >
                <View testID="web-child-action" />
            </MessageActionRow>,
        );

        const row = screen.findByTestId('transcript-message-actions-row:web-inverted');
        const timestamp = screen.findByTestId('transcript-message-timestamp:web-inverted');

        expect(row?.props.pointerEvents).toBeUndefined();
        expect(flattenStyle(row?.props.style)).toEqual(expect.objectContaining({
            flexDirection: 'row-reverse',
            pointerEvents: 'none',
        }));
        expect(flattenStyle(timestamp?.props.style)).toEqual(expect.objectContaining({
            marginLeft: 12,
            marginRight: 0,
        }));
    });
});
