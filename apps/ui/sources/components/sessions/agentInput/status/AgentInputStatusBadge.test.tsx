import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('AgentInputStatusBadge', () => {
    it('keeps required disclosure text fully visible in the composer status row', async () => {
        const { AgentInputStatusBadge } = await import('./AgentInputStatusBadge');
        const label = 'Full requester sign-in and computer administrator visibility';
        const screen = await renderScreen(<AgentInputStatusBadge key="disclosure" label={label} labelNumberOfLines={0} emphasis="quiet" />);
        expect(screen.find(node => node.props.children === label && node.props.numberOfLines === 0)).toBeTruthy();
    });
    it('keeps quiet badges pressable while removing persistent border and background chrome', async () => {
        const onPress = vi.fn();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { AgentInputStatusBadge } = await import('./AgentInputStatusBadge');

        try {
            const screen = await renderScreen(
                <AgentInputStatusBadge
                    key="work-state"
                    label="Goal: Ship the release"
                    testID="quiet-work-state-badge"
                    tone="active"
                    emphasis="quiet"
                    onPress={onPress}
                />,
            );

            const badge = screen.findByTestId('quiet-work-state-badge');
            expect(badge?.type).toBe('Pressable');
            expect(typeof badge?.props.style).toBe('function');

            const badgeSurface = flattenStyle(badge?.props.style({ pressed: false }));

            expect(badgeSurface).not.toEqual(expect.objectContaining({
                backgroundColor: expect.anything(),
                borderColor: expect.anything(),
            }));
            expect(screen.find((node) => node.props.chrome === 'plain')).toBeTruthy();

            badge?.props.onPress?.();
            expect(onPress).toHaveBeenCalledTimes(1);
        } finally {
            consoleError.mockRestore();
        }
    });
});
