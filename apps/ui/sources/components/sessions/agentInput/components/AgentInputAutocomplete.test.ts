import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let pressableIndex = 0;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode; testID?: string }) =>
                React.createElement(
                    'Pressable',
                    {
                        ...props,
                        testID: props.testID ?? `agent-input-autocomplete.option:${pressableIndex++}`,
                    },
                    props.children,
                ),
            Platform: {
                OS: 'web',
            },
            View: 'View',
        },
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: { colors: { surfacePressed: '#eee', surfaceSelected: '#ddd' } },
    });
});

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('FloatingOverlay', { ...props, testID: 'agent-input-autocomplete.overlay' }, props.children),
}));

async function renderAutocomplete(props: {
    suggestions: React.ReactElement[];
    onSelect: (index: number) => void;
    itemHeight: number;
    selectedIndex?: number;
    maxHeight?: number;
}) {
    return renderScreen(React.createElement(AgentInputAutocomplete, props));
}

describe('AgentInputAutocomplete', () => {
    beforeEach(() => {
        pressableIndex = 0;
    });

    it('returns null when suggestions are empty', async () => {
        const screen = await renderAutocomplete({
            suggestions: [],
            onSelect: () => {},
            itemHeight: 48,
        });

        expect(screen.tree.toJSON()).toBe(null);
    });

    it('passes maxHeight through to FloatingOverlay', async () => {
        const screen = await renderAutocomplete({
            suggestions: [React.createElement('Suggestion', { key: 's1' })],
            onSelect: () => {},
            itemHeight: 48,
            maxHeight: 123,
        });

        expect(screen.findByTestId('agent-input-autocomplete.overlay')?.props.maxHeight).toBe(123);
    });

    it('calls onSelect with the pressed index', async () => {
        const onSelect = vi.fn<(index: number) => void>();
        const screen = await renderAutocomplete({
            suggestions: [
                React.createElement('Suggestion', { key: 's1' }),
                React.createElement('Suggestion', { key: 's2' }),
            ],
            onSelect,
            itemHeight: 48,
        });

        expect(screen.findByTestId('agent-input-autocomplete.option:0')).toBeTruthy();
        expect(screen.findByTestId('agent-input-autocomplete.option:1')).toBeTruthy();

        await screen.pressByTestIdAsync('agent-input-autocomplete.option:1');

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(1);
    });
});
