import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runtimeState = vi.hoisted(() => ({
    breakpoint: 'lg',
    screen: { width: 1200, height: 800 },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const mock = await createUnistylesMock();
    return {
        ...mock,
        useUnistyles: () => {
            const current = mock.useUnistyles();
            return {
                ...current,
                rt: {
                    ...current.rt,
                    breakpoint: runtimeState.breakpoint,
                    screen: runtimeState.screen,
                },
            };
        },
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('JumpToBottomButton compact layout', () => {
    beforeEach(() => {
        runtimeState.breakpoint = 'lg';
        runtimeState.screen = { width: 1200, height: 800 };
    });

    it('keeps label and count visible on large screens', async () => {
        const { JumpToBottomButton } = await import('./JumpToBottomButton');
        const screen = await renderScreen(
            <JumpToBottomButton count={3} onPress={() => {}} testID="jump" />,
        );

        expect(screen.getTextContent()).toContain('settingsSession.transcript.jumpToBottomButtonLabel');
        expect(screen.getTextContent()).toContain('3');
    });

    it('hides the label but keeps the count visible on smaller screens', async () => {
        runtimeState.breakpoint = 'md';
        runtimeState.screen = { width: 500, height: 800 };

        const { JumpToBottomButton } = await import('./JumpToBottomButton');
        const screen = await renderScreen(
            <JumpToBottomButton count={3} onPress={() => {}} testID="jump" />,
        );

        expect(screen.getTextContent()).not.toContain('settingsSession.transcript.jumpToBottomButtonLabel');
        expect(screen.getTextContent()).toContain('3');
        expect(screen.findByTestId('jump')?.props.accessibilityLabel).toBe('settingsSession.transcript.jumpToBottomButtonLabel');
        expect(screen.findByType('Ionicons')).toBeTruthy();
    });
});
