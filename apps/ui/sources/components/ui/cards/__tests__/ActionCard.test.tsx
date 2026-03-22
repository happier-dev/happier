import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            Platform: {
                                OS: 'web',
                            },
                            View: 'View',
                            Text: 'Text',
                            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: any) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

describe('ActionCard', () => {
    it('renders primary button with correct label', async () => {
        const { ActionCard } = await import('../ActionCard');
        const onPress = vi.fn();
        const screen = await renderScreen(
            <ActionCard
                testID="action-card"
                title="Install CLI"
                primaryAction={{ label: 'Install', onPress }}
            />,
        );

        expect(screen.findByTestId('action-card-primary')?.props.title).toBe('Install');
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

        expect(screen.findByTestId('action-card-secondary')?.props.title).toBe('Skip');
        expect(screen.findByTestId('action-card-secondary')?.props.display).toBe('inverted');
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
        const screen = await renderScreen(
            <ActionCard
                testID="action-card"
                title="Install"
                primaryAction={{ label: 'Go', onPress: () => {} }}
                secondaryAction={{ label: 'Skip', onPress: () => {} }}
                loading
            />,
        );

        expect(screen.findByTestId('action-card-primary')?.props.disabled).toBe(true);
        expect(screen.findByTestId('action-card-secondary')?.props.disabled).toBe(true);
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

        expect(screen.getTextContent()).toBe('No Desc');
    });
});
