import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentInputAutocomplete, type AgentInputAutocompleteItem } from './AgentInputAutocomplete';
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
    items: readonly AgentInputAutocompleteItem[];
    onSelect: (index: number) => void;
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
            items: [],
            onSelect: () => {},
        });

        expect(screen.tree.toJSON()).toBe(null);
    });

    it('passes maxHeight through to FloatingOverlay', async () => {
        const screen = await renderAutocomplete({
            items: [{ id: 'cmd-help', label: '/help', minHeight: 48 }],
            onSelect: () => {},
            maxHeight: 123,
        });

        expect(screen.findByTestId('agent-input-autocomplete.overlay')?.props.maxHeight).toBe(123);
    });

    it('renders suggestions through SelectionList and calls onSelect with the pressed index', async () => {
        const onSelect = vi.fn<(index: number) => void>();
        const screen = await renderAutocomplete({
            items: [
                { id: 'cmd-help', label: '/help', subtitle: 'Show help', minHeight: 52 },
                { id: 'cmd-goal', label: '/goal', subtitle: 'Set the session goal', minHeight: 52 },
            ],
            onSelect,
        });

        expect(screen.findByTestId('agent-input-autocomplete')).toBeTruthy();
        expect(screen.findByTestId('agent-input-autocomplete:root:option:cmd-help')).toBeTruthy();
        expect(screen.findByTestId('agent-input-autocomplete:root:option:cmd-goal')).toBeTruthy();
        expect(screen.getTextContent()).toContain('/goal');
        expect(screen.getTextContent()).toContain('Set the session goal');

        await screen.pressByTestIdAsync('agent-input-autocomplete:root:option:cmd-goal');

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(1);
    });
});
