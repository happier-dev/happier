import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MessagePinAvailability } from './resolveMessagePinAvailability';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'web',
}));

const iconCalls = vi.hoisted(() => [] as Array<{ name: string; color: string; size: number }>);

function available(overrides: Partial<Extract<MessagePinAvailability, { status: 'available' }>> = {}): Extract<MessagePinAvailability, { status: 'available' }> {
    return {
        status: 'available',
        pinned: false,
        identityKey: 'fallback|s1|5|block:0|assistant',
        pin: {
            version: 1,
            sessionId: 's1',
            seq: 5,
            transcriptBlockIndex: 0,
            routeMessageId: null,
            role: 'assistant',
            pinnedAtMs: 1_000,
            label: null,
        },
        ...overrides,
    };
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (values: Record<string, unknown>) => values[platformState.os] ?? values.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: { secondary: '#666666' },
                state: {
                    active: { foreground: '#0a7a4b', background: '#daf5e9' },
                    neutral: { background: '#eeeeee' },
                },
            },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/sessions/shell/sessionPinIcons', () => ({
    PinIcon: (props: { color: string; size: number }) => {
        iconCalls.push({ name: 'pin', color: props.color, size: props.size });
        return React.createElement('PinIcon', props);
    },
    PinSlashIcon: (props: { color: string; size: number }) => {
        iconCalls.push({ name: 'pin-slash', color: props.color, size: props.size });
        return React.createElement('PinSlashIcon', props);
    },
}));

describe('MessagePinButton', () => {
    afterEach(() => {
        iconCalls.length = 0;
        platformState.os = 'web';
        standardCleanup();
    });

    it('renders an unpinned message action with web hit slop omitted', async () => {
        const { MessagePinButton } = await import('./MessagePinButton');
        const onToggle = vi.fn();

        const screen = await renderScreen(
            <MessagePinButton
                availability={available()}
                onTogglePin={onToggle}
                testID="message-pin"
            />,
        );

        const button = screen.findByTestId('message-pin');
        expect(button?.props.accessibilityRole).toBe('button');
        expect(button?.props.accessibilityLabel).toBe('session.transcriptNavigation.pinMessageA11y');
        expect(button?.props.hitSlop).toBeUndefined();
        expect(iconCalls).toEqual([expect.objectContaining({ name: 'pin', color: '#666666', size: 12 })]);
    });

    it('uses an unpin label and active icon color when pinned', async () => {
        const { MessagePinButton } = await import('./MessagePinButton');

        const screen = await renderScreen(
            <MessagePinButton
                availability={available({ pinned: true })}
                onTogglePin={() => {}}
                testID="message-pin"
            />,
        );

        expect(screen.findByTestId('message-pin')?.props.accessibilityLabel).toBe('session.transcriptNavigation.unpinMessageA11y');
        expect(iconCalls).toEqual([expect.objectContaining({ name: 'pin-slash', color: '#0a7a4b' })]);
    });

    it('passes the canonical pin record to the toggle callback', async () => {
        const { MessagePinButton } = await import('./MessagePinButton');
        const target = available();
        const onToggle = vi.fn();

        const screen = await renderScreen(
            <MessagePinButton
                availability={target}
                onTogglePin={onToggle}
                testID="message-pin"
            />,
        );

        screen.pressByTestId('message-pin');

        expect(onToggle).toHaveBeenCalledTimes(1);
        expect(onToggle).toHaveBeenCalledWith(target.pin);
    });

    it('omits unavailable actions and actions without a host callback', async () => {
        const { MessagePinButton } = await import('./MessagePinButton');

        const unavailableScreen = await renderScreen(
            <MessagePinButton
                availability={{ status: 'unavailable', reason: 'missing-seq' }}
                onTogglePin={() => {}}
                testID="message-pin"
            />,
        );
        expect(unavailableScreen.findAllByType('Pressable')).toHaveLength(0);
        standardCleanup();

        const noCallbackScreen = await renderScreen(
            <MessagePinButton
                availability={available()}
                testID="message-pin"
            />,
        );
        expect(noCallbackScreen.findAllByType('Pressable')).toHaveLength(0);
    });

    it('uses native action hit slop off web', async () => {
        platformState.os = 'ios';
        const { MessagePinButton } = await import('./MessagePinButton');

        const screen = await renderScreen(
            <MessagePinButton
                availability={available()}
                onTogglePin={() => {}}
                testID="message-pin"
            />,
        );

        expect(screen.findByTestId('message-pin')?.props.hitSlop).toBe(15);
    });
});
