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

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

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
            expect(typeof badge?.props.children).toBe('function');

            const badgeSurface = React.isValidElement(badge?.props.children?.({ pressed: false }))
                ? flattenStyle(badge?.props.children({ pressed: false }).props.style)
                : undefined;

            expect(badgeSurface).toEqual(expect.objectContaining({
                backgroundColor: 'transparent',
                borderColor: 'transparent',
                borderWidth: 0,
            }));

            badge?.props.onPress?.();
            expect(onPress).toHaveBeenCalledTimes(1);
        } finally {
            consoleError.mockRestore();
        }
    });
});
