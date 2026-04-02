import * as React from 'react';
import { Animated } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => true,
}));

import { WelcomeProvidersShowcase } from './WelcomeProvidersShowcase';

describe('WelcomeProvidersShowcase', () => {
    it('renders the showcase grid with animated rows and stable provider cells', async () => {
        const screen = await renderScreen(
            <WelcomeProvidersShowcase
                testID="welcome-showcase"
                testIDPrefix="welcome"
            />,
        );

        expect(screen.findByTestId('welcome-showcase')).toBeTruthy();
        expect(screen.findAllByType(Animated.View).length).toBeGreaterThanOrEqual(2);
        expect(
            screen.findAll((node) => (
                typeof node.props?.testID === 'string'
                && node.props.testID.startsWith('welcome-provider:')
            )).length,
        ).toBeGreaterThan(0);
    });
});
