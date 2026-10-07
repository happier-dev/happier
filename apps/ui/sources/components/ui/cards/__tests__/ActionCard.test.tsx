import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

describe('ActionCard', () => {
    it('keeps the complete primary action readable and operable', async () => {
        const { ActionCard } = await import('../ActionCard');
        const onPress = vi.fn();
        const screen = await renderScreen(
            <ActionCard
                testID="action-card"
                title="Install CLI"
                primaryAction={{ label: 'Connect this computer here', onPress }}
            />,
        );

        const label = screen.tree.findAllByType('Text' as never).find((node) => node.props.children === 'Connect this computer here');
        expect(label).toBeTruthy();
        expect(label?.props.numberOfLines).toBeUndefined();
        await act(async () => { screen.findByTestId('action-card-primary')?.props.onPress(); });
        expect(onPress).toHaveBeenCalledOnce();
    });

    it('renders secondary button when provided', async () => {
        const { ActionCard } = await import('../ActionCard');
        const screen = await renderScreen(
            <ActionCard
                testID="action-card"
                title="Install"
                primaryAction={{ label: 'Install', onPress: () => {} }}
                secondaryAction={{ label: 'Skip', onPress: () => {} }}
            />,
        );

        expect(screen.findByTestId('action-card-secondary')).toBeTruthy();
        const label = screen.tree.findAllByType('Text' as never).find((node) => node.props.children === 'Skip');
        expect(label).toBeTruthy();
        expect(label?.props.numberOfLines).toBeUndefined();
    });

    it('does not render secondary button when omitted', async () => {
        const { ActionCard } = await import('../ActionCard');
        const screen = await renderScreen(
            <ActionCard
                testID="action-card"
                title="Install"
                primaryAction={{ label: 'Go', onPress: () => {} }}
            />,
        );

        expect(screen.findByTestId('action-card-secondary')).toBeNull();
    });

    it('disables buttons when loading', async () => {
        const { ActionCard } = await import('../ActionCard');
        const primaryPress = vi.fn();
        const secondaryPress = vi.fn();
        const screen = await renderScreen(
            <ActionCard
                testID="action-card"
                title="Install"
                primaryAction={{ label: 'Go', onPress: primaryPress }}
                secondaryAction={{ label: 'Skip', onPress: secondaryPress }}
                loading
            />,
        );

        for (const id of ['action-card-primary', 'action-card-secondary']) {
            const button = screen.findHostByTestId(id);
            expect(button).not.toBeNull();
            expect(button?.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
            expect(button?.props.onPress).toBeTypeOf('function');
            await act(async () => { button?.props.onPress(); });
        }
        expect(primaryPress).not.toHaveBeenCalled();
        expect(secondaryPress).not.toHaveBeenCalled();
    });

    it('description is optional', async () => {
        const { ActionCard } = await import('../ActionCard');
        const screen = await renderScreen(
            <ActionCard
                testID="action-card"
                title="No Desc"
                primaryAction={{ label: 'Go', onPress: () => {} }}
            />,
        );

        expect(screen.getTextContent()).toBe('No Desc Go');
    });
});
