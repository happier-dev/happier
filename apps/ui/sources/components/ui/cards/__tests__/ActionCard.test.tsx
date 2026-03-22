import React from 'react';
import renderer from 'react-test-renderer';
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
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ActionCard title="Install CLI" primaryAction={{ label: 'Install', onPress }} />)).tree;
        const buttons = tree.root.findAllByType('RoundButton' as any);
        expect(buttons).toHaveLength(1);
        expect(buttons[0].props.title).toBe('Install');
    });

    it('renders secondary button when provided', async () => {
        const { ActionCard } = await import('../ActionCard');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ActionCard
                    title="Install"
                    primaryAction={{ label: 'Install', onPress: () => {} }}
                    secondaryAction={{ label: 'Skip', onPress: () => {} }}
                />)).tree;
        const buttons = tree.root.findAllByType('RoundButton' as any);
        expect(buttons).toHaveLength(2);
        expect(buttons[1].props.title).toBe('Skip');
        expect(buttons[1].props.display).toBe('inverted');
    });

    it('does not render secondary button when omitted', async () => {
        const { ActionCard } = await import('../ActionCard');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ActionCard title="Install" primaryAction={{ label: 'Go', onPress: () => {} }} />)).tree;
        const buttons = tree.root.findAllByType('RoundButton' as any);
        expect(buttons).toHaveLength(1);
    });

    it('disables buttons when loading', async () => {
        const { ActionCard } = await import('../ActionCard');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ActionCard
                    title="Install"
                    primaryAction={{ label: 'Go', onPress: () => {} }}
                    secondaryAction={{ label: 'Skip', onPress: () => {} }}
                    loading
                />)).tree;
        const buttons = tree.root.findAllByType('RoundButton' as any);
        expect(buttons[0].props.disabled).toBe(true);
        expect(buttons[1].props.disabled).toBe(true);
    });

    it('description is optional', async () => {
        const { ActionCard } = await import('../ActionCard');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ActionCard title="No Desc" primaryAction={{ label: 'Go', onPress: () => {} }} />)).tree;
        const texts = tree.root.findAllByType('Text' as any);
        const textContents = texts.map((t) => t.children.join(''));
        expect(textContents).toContain('No Desc');
        expect(textContents).toHaveLength(1); // Only title
    });
});
