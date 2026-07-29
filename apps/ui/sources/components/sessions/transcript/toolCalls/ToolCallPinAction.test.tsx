import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MessagePinAvailability } from '../messageActions/resolveMessagePinAvailability';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'web',
}));

const iconCalls = vi.hoisted(() => [] as Array<{ name: string; color: string; size: number }>);

function available(overrides: Partial<Extract<MessagePinAvailability, { status: 'available' }>> = {}): Extract<MessagePinAvailability, { status: 'available' }> {
    return {
        status: 'available',
        pinned: false,
        identityKey: 'route-message-id|s1|tool:call-1|block:2|tool',
        pinTarget: {
            version: 1,
            sessionId: 's1',
            seq: 5,
            transcriptBlockIndex: 2,
            routeMessageId: 'tool:call-1',
            role: 'tool',
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
                text: { secondary: '#555555' },
                state: {
                    active: { foreground: '#0b7a75', background: '#ddf5f3' },
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

describe('ToolCallPinAction', () => {
    afterEach(() => {
        iconCalls.length = 0;
        platformState.os = 'web';
        standardCleanup();
    });

    it('renders a tool pin action with an accessible pin label', async () => {
        const { ToolCallPinAction } = await import('./ToolCallPinAction');

        const screen = await renderScreen(
            <ToolCallPinAction
                availability={available()}
                onTogglePin={() => {}}
                testID="tool-pin"
            />,
        );

        const button = screen.findByTestId('tool-pin');
        expect(button?.props.accessibilityRole).toBe('button');
        expect(button?.props.accessibilityLabel).toBe('session.transcriptNavigation.pinToolCallA11y');
        expect(button?.props.hitSlop).toBeUndefined();
        expect(iconCalls).toEqual([expect.objectContaining({ name: 'pin', color: '#555555', size: 14 })]);
    });

    it('uses an unpin label and active color for pinned tool calls', async () => {
        const { ToolCallPinAction } = await import('./ToolCallPinAction');

        const screen = await renderScreen(
            <ToolCallPinAction
                availability={available({ pinned: true })}
                onTogglePin={() => {}}
                testID="tool-pin"
            />,
        );

        expect(screen.findByTestId('tool-pin')?.props.accessibilityLabel).toBe('session.transcriptNavigation.unpinToolCallA11y');
        expect(iconCalls).toEqual([expect.objectContaining({ name: 'pin-slash', color: '#0b7a75' })]);
    });

    it('stops row propagation before toggling the pin', async () => {
        const { ToolCallPinAction } = await import('./ToolCallPinAction');
        const callOrder: string[] = [];
        const stopPropagation = vi.fn(() => {
            callOrder.push('stopPropagation');
        });
        const onToggle = vi.fn(() => {
            callOrder.push('onToggle');
        });
        const target = available();

        const screen = await renderScreen(
            <ToolCallPinAction
                availability={target}
                onTogglePin={onToggle}
                testID="tool-pin"
            />,
        );

        screen.findByTestId('tool-pin')?.props.onPress?.({ stopPropagation });

        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(onToggle).toHaveBeenCalledTimes(1);
        expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ ...target.pinTarget }));
        expect(callOrder).toEqual(['stopPropagation', 'onToggle']);
    });

    it('omits unavailable actions and actions without a host callback', async () => {
        const { ToolCallPinAction } = await import('./ToolCallPinAction');

        const unavailableScreen = await renderScreen(
            <ToolCallPinAction
                availability={{ status: 'unavailable', reason: 'missing-seq' }}
                onTogglePin={() => {}}
                testID="tool-pin"
            />,
        );
        expect(unavailableScreen.findAllByType('Pressable')).toHaveLength(0);
        standardCleanup();

        const noCallbackScreen = await renderScreen(
            <ToolCallPinAction
                availability={available()}
                testID="tool-pin"
            />,
        );
        expect(noCallbackScreen.findAllByType('Pressable')).toHaveLength(0);
    });

    it('uses native hit slop outside web', async () => {
        platformState.os = 'ios';
        const { ToolCallPinAction } = await import('./ToolCallPinAction');

        const screen = await renderScreen(
            <ToolCallPinAction
                availability={available()}
                onTogglePin={() => {}}
                testID="tool-pin"
            />,
        );

        expect(screen.findByTestId('tool-pin')?.props.hitSlop).toBe(15);
    });
});

describe('resolveToolRowPinAction', () => {
    afterEach(() => {
        iconCalls.length = 0;
        platformState.os = 'web';
        standardCleanup();
    });

    const rowIdentity = {
        sessionId: 's1',
        seq: 5,
        transcriptBlockIndex: 2,
        routeMessageId: 'tool:call-1',
        testID: 'tool-pin',
    } as const;

    it('resolves the row pin and its sticky flag once, so reveal containers do not recompute it', async () => {
        const { resolveToolRowPinAction } = await import('./ToolCallPinAction');

        const unpinned = resolveToolRowPinAction({ ...rowIdentity, pins: [], onTogglePin: () => {} });
        expect(unpinned?.pinned).toBe(false);

        const pinned = resolveToolRowPinAction({
            ...rowIdentity,
            pins: [{
                version: 1,
                sessionId: 's1',
                seq: 5,
                transcriptBlockIndex: 2,
                routeMessageId: 'tool:call-1',
                role: 'tool',
                pinnedAtMs: 1_000,
                label: null,
            }],
            onTogglePin: () => {},
        });
        expect(pinned?.pinned).toBe(true);
        expect(pinned?.node).toBeTruthy();
    });

    it('has no action without a toggle handler or for a read-only transcript', async () => {
        const { resolveToolRowPinAction } = await import('./ToolCallPinAction');

        expect(resolveToolRowPinAction({ ...rowIdentity, pins: [] })).toBeNull();
        expect(resolveToolRowPinAction({
            ...rowIdentity,
            pins: [],
            readOnlyContext: true,
            onTogglePin: () => {},
        })).toBeNull();
    });
});
