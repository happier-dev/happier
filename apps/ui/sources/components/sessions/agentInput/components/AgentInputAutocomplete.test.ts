import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: { colors: { surfacePressed: '#eee', surfaceSelected: '#ddd' } },
    }),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('FloatingOverlay', props, props.children),
}));

function renderAutocomplete(props: {
    suggestions: React.ReactElement[];
    onSelect: (index: number) => void;
    itemHeight: number;
    selectedIndex?: number;
    maxHeight?: number;
}): renderer.ReactTestRenderer {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(React.createElement(AgentInputAutocomplete, props));
    });
    return tree!;
}

function findOverlay(tree: renderer.ReactTestRenderer): ReactTestInstance | undefined {
    return tree.root.findAllByType('FloatingOverlay')[0];
}

function findPressables(tree: renderer.ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType('Pressable');
}

describe('AgentInputAutocomplete', () => {
    it('returns null when suggestions are empty', () => {
        const tree = renderAutocomplete({
            suggestions: [],
            onSelect: () => {},
            itemHeight: 48,
        });
        expect(tree.toJSON()).toBe(null);
    });

    it('passes maxHeight through to FloatingOverlay', () => {
        const tree = renderAutocomplete({
            suggestions: [React.createElement('Suggestion', { key: 's1' })],
            onSelect: () => {},
            itemHeight: 48,
            maxHeight: 123,
        });

        expect(findOverlay(tree)?.props.maxHeight).toBe(123);
    });

    it('calls onSelect with the pressed index', () => {
        const onSelect = vi.fn<(index: number) => void>();
        const tree = renderAutocomplete({
            suggestions: [
                React.createElement('Suggestion', { key: 's1' }),
                React.createElement('Suggestion', { key: 's2' }),
            ],
            onSelect,
            itemHeight: 48,
        });

        const pressables = findPressables(tree);
        expect(pressables).toHaveLength(2);

        act(() => {
            pressables[1]?.props?.onPress?.();
        });

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(1);
    });
});
