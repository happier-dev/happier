import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
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

function readOpacity(style: unknown): number | undefined {
    const opacity = flattenStyle(style).opacity;
    if (typeof opacity === 'number') return opacity;
    const animated = opacity as { __getValue?: () => number } | undefined;
    return typeof animated?.__getValue === 'function' ? animated.__getValue() : undefined;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

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
                isWeb
                invertTimestampAndActions={false}
            >
                <View testID="child-action" />
            </MessageActionRow>,
        );

        expect(screen.findByTestId('transcript-message-actions-row:m1')).toBeTruthy();
        expect(screen.findByTestId('transcript-message-timestamp:m1')?.props.children).toBe('May 19, 2026, 4:30 PM');
        expect(readOpacity(screen.findByTestId('transcript-message-actions:m1')?.props.style)).toBe(1);
        expect(screen.findByTestId('child-action')).toBeTruthy();
    });

    it('never lets the absolutely-positioned row intercept pointer input', async () => {
        const { MessageActionRow } = await import('./MessageActionRow');

        const screen = await renderScreen(
            <MessageActionRow
                messageId="hidden"
                timestampText={null}
                showActions={false}
                isWeb
                invertTimestampAndActions={false}
            >
                <View testID="hidden-child-action" />
            </MessageActionRow>,
        );

        const row = screen.findByTestId('transcript-message-actions-row:hidden');
        const actions = screen.findByTestId('transcript-message-actions:hidden');

        expect(flattenStyle(row?.props.style).pointerEvents).toBe('box-none');
        expect(readOpacity(actions?.props.style)).toBe(0);
        expect(flattenStyle(actions?.props.style).pointerEvents).toBe('none');
    });

    it('keeps a pinned row pin visible without dragging the timestamp or the rest of the actions into view', async () => {
        const { MessageActionRow } = await import('./MessageActionRow');

        const screen = await renderScreen(
            <MessageActionRow
                messageId="pinned"
                timestampText={null}
                showActions={false}
                showPinAction
                pinAction={<View testID="pin-action" />}
                isWeb
                invertTimestampAndActions={false}
            >
                <View testID="other-action" />
            </MessageActionRow>,
        );

        expect(readOpacity(screen.findByTestId('transcript-message-pin-slot:pinned')?.props.style)).toBe(1);
        expect(readOpacity(screen.findByTestId('transcript-message-actions:pinned')?.props.style)).toBe(0);
        expect(screen.findAllByTestId('transcript-message-timestamp:pinned')).toHaveLength(0);
    });

    it('reports descendant focus so the host can mirror it into its row visibility state', async () => {
        const { MessageActionRow } = await import('./MessageActionRow');
        const onActionsFocus = vi.fn();
        const onActionsBlur = vi.fn();

        const screen = await renderScreen(
            <MessageActionRow
                messageId="focus"
                timestampText={null}
                showActions={false}
                onActionsFocus={onActionsFocus}
                onActionsBlur={onActionsBlur}
                isWeb
                invertTimestampAndActions={false}
            >
                <View testID="focus-action" />
            </MessageActionRow>,
        );

        act(() => {
            screen.findByTestId('transcript-message-actions:focus')?.props.onFocus?.();
        });
        expect(onActionsFocus).toHaveBeenCalledTimes(1);
        expect(readOpacity(screen.findByTestId('transcript-message-actions:focus')?.props.style)).toBe(1);

        act(() => {
            screen.findByTestId('transcript-message-actions:focus')?.props.onBlur?.();
        });
        expect(onActionsBlur).toHaveBeenCalledTimes(1);
    });

    it('inverts timestamp spacing when requested', async () => {
        const { MessageActionRow } = await import('./MessageActionRow');

        const screen = await renderScreen(
            <MessageActionRow
                messageId="web-inverted"
                timestampText="Now"
                showActions={false}
                isWeb
                invertTimestampAndActions
            >
                <View testID="web-child-action" />
            </MessageActionRow>,
        );

        const row = screen.findByTestId('transcript-message-actions-row:web-inverted');
        const timestamp = screen.findByTestId('transcript-message-timestamp:web-inverted');

        expect(flattenStyle(row?.props.style)).toEqual(expect.objectContaining({
            flexDirection: 'row-reverse',
        }));
        expect(flattenStyle(timestamp?.props.style)).toEqual(expect.objectContaining({
            marginLeft: 12,
            marginRight: 0,
        }));
    });

    describe('closed row mounts no action controls', () => {
        const renderRow = async (showActions: boolean) => {
            const { MessageActionRow } = await import('./MessageActionRow');
            const element = (show: boolean) => (
                <MessageActionRow
                    messageId="lazy"
                    timestampText={null}
                    showActions={show}
                    isWeb
                    invertTimestampAndActions={false}
                >
                    <View testID="lazy-action" />
                </MessageActionRow>
            );
            const screen = await renderScreen(element(showActions));
            return { screen, update: async (show: boolean) => { await act(async () => { screen.update(element(show)); }); } };
        };

        it('mounts the controls only once the row is revealed, then keeps them mounted', async () => {
            const { screen, update } = await renderRow(false);

            expect(screen.findAllByTestId('lazy-action')).toHaveLength(0);
            expect(screen.findAllByTestId('transcript-message-actions-opener:lazy')).not.toHaveLength(0);

            await update(true);
            expect(screen.findAllByTestId('lazy-action')).toHaveLength(1);
            expect(screen.findAllByTestId('transcript-message-actions-opener:lazy')).toHaveLength(0);

            await update(false);
            expect(screen.findAllByTestId('lazy-action')).toHaveLength(1);
        });

        it('keeps the row keyboard-reachable: focusing the stand-in mounts the controls', async () => {
            const { MessageActionRow } = await import('./MessageActionRow');
            const screen = await renderScreen(
                <MessageActionRow messageId="focus-lazy" timestampText={null} showActions={false} isWeb invertTimestampAndActions={false}>
                    <View testID="focus-lazy-action" />
                </MessageActionRow>,
            );

            const opener = screen.findByTestId('transcript-message-actions-opener:focus-lazy');
            await act(async () => { opener?.props.onFocus?.({ currentTarget: null }); });
            expect(screen.findAllByTestId('focus-lazy-action')).toHaveLength(1);
            expect(screen.findAllByTestId('transcript-message-actions-opener:focus-lazy')).toHaveLength(0);
        });

        it('hands focus to the last control on reverse entry and the first on forward entry', async () => {
            const { MessageActionRow } = await import('./MessageActionRow');
            const enter = async (messageId: string, relatedFollowsStandIn: boolean) => {
                const first = { focus: vi.fn() };
                const last = { focus: vi.fn() };
                const slot = { querySelectorAll: () => [first, last] };
                const standIn = {
                    parentElement: slot,
                    compareDocumentPosition: () => (relatedFollowsStandIn ? 4 : 2),
                };
                const screen = await renderScreen(
                    <MessageActionRow messageId={messageId} timestampText={null} showActions={false} isWeb invertTimestampAndActions={false}>
                        <View testID={`${messageId}-action`} />
                    </MessageActionRow>,
                );
                const opener = screen.findByTestId(`transcript-message-actions-opener:${messageId}`);
                await act(async () => { opener?.props.onFocus?.({ currentTarget: standIn, relatedTarget: {} }); });
                return { first, last };
            };

            const reverse = await enter('reverse', true);
            expect(reverse.last.focus).toHaveBeenCalledTimes(1);
            expect(reverse.first.focus).not.toHaveBeenCalled();

            const forward = await enter('forward', false);
            expect(forward.first.focus).toHaveBeenCalledTimes(1);
            expect(forward.last.focus).not.toHaveBeenCalled();
        });
    });
});
