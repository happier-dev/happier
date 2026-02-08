import { describe, expect, it, vi } from 'vitest';
import renderer, { act, type ReactTestInstance } from 'react-test-renderer';
import React from 'react';
import { EnvironmentVariableCard } from './EnvironmentVariableCard';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
    Platform: {
        OS: 'web',
        select: (options: { web?: unknown; ios?: unknown; default?: unknown }) =>
            options.web ?? options.ios ?? options.default,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            margins: { md: 8 },
            iconSize: { small: 12, large: 16 },
            colors: {
                surface: '#fff',
                groupped: { sectionTitle: '#666', background: '#fff' },
                shadow: { color: '#000', opacity: 0.1 },
                text: '#000',
                textSecondary: '#666',
                textDestructive: '#f00',
                divider: '#ddd',
                input: { background: '#fff', text: '#000', placeholder: '#999' },
                button: {
                    primary: { background: '#000', tint: '#fff' },
                    secondary: { tint: '#000' },
                },
                deleteAction: '#f00',
                warning: '#f90',
                success: '#0a0',
            },
        },
    }),
    StyleSheet: {
        create: (factory: (theme: unknown) => unknown) =>
            factory({
                margins: { md: 8 },
                iconSize: { small: 12, large: 16 },
                colors: {
                    surface: '#fff',
                    groupped: { sectionTitle: '#666', background: '#fff' },
                    shadow: { color: '#000', opacity: 0.1 },
                    text: '#000',
                    textSecondary: '#666',
                    textDestructive: '#f00',
                    divider: '#ddd',
                    input: { background: '#fff', text: '#000', placeholder: '#999' },
                    button: {
                        primary: { background: '#000', tint: '#fff' },
                        secondary: { tint: '#000' },
                    },
                    deleteAction: '#f00',
                    warning: '#f90',
                    success: '#0a0',
                },
            }),
    },
}));

vi.mock('@/components/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: {
        title?: React.ReactNode;
        subtitle?: React.ReactNode;
        rightElement?: React.ReactNode;
    }) =>
        React.createElement(
            'Item',
            props,
            props.title ? React.createElement('Text', null, props.title) : null,
            props.subtitle ?? null,
            props.rightElement ?? null,
        ),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

function renderCard(params: {
    value: string;
    onUpdate: ReturnType<typeof vi.fn<(index: number, next: string) => void>>;
}) {
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(
            React.createElement(EnvironmentVariableCard, {
                variable: { name: 'FOO', value: params.value },
                index: 0,
                machineId: 'machine-1',
                onUpdate: params.onUpdate,
                onDelete: () => {},
                onDuplicate: () => {},
            }),
        );
    });
    return tree!;
}

function findTextInputs(tree: renderer.ReactTestRenderer): ReactTestInstance[] {
    return tree.root.findAllByType('TextInput');
}

function findUseMachineSwitch(tree: renderer.ReactTestRenderer): ReactTestInstance | undefined {
    const switches = tree.root.findAllByType('Switch');
    return switches.find((node) => node.props.disabled !== true);
}

describe('EnvironmentVariableCard', () => {
    describe('remote-template state synchronization', () => {
        it('syncs remote-variable toggle state when variable value changes externally', () => {
            const onUpdate = vi.fn<(index: number, next: string) => void>();
            const tree = renderCard({ value: '${BAR:-baz}', onUpdate });

            const initialUseMachineSwitch = findUseMachineSwitch(tree);
            expect(initialUseMachineSwitch?.props.value).toBe(true);

            act(() => {
                tree.update(
                    React.createElement(EnvironmentVariableCard, {
                        variable: { name: 'FOO', value: 'literal' },
                        index: 0,
                        machineId: 'machine-1',
                        onUpdate,
                        onDelete: () => {},
                        onDuplicate: () => {},
                    }),
                );
            });

            const updatedUseMachineSwitch = findUseMachineSwitch(tree);
            expect(updatedUseMachineSwitch?.props.value).toBe(false);
        });
    });

    describe('fallback template transformation', () => {
        it('adds a fallback operator when user enters fallback for template without one', () => {
            const onUpdate = vi.fn<(index: number, next: string) => void>();
            const tree = renderCard({ value: '${BAR}', onUpdate });

            const [fallbackInput] = findTextInputs(tree);
            expect(fallbackInput).toBeTruthy();

            act(() => {
                fallbackInput?.props.onChangeText?.('baz');
            });

            const lastCall = onUpdate.mock.calls.at(-1);
            expect(lastCall).toEqual([0, '${BAR:-baz}']);
        });

        it('removes operator when user clears existing fallback', () => {
            const onUpdate = vi.fn<(index: number, next: string) => void>();
            const tree = renderCard({ value: '${BAR:=baz}', onUpdate });

            const [fallbackInput] = findTextInputs(tree);
            expect(fallbackInput).toBeTruthy();

            act(() => {
                fallbackInput?.props.onChangeText?.('');
            });

            const lastCall = onUpdate.mock.calls.at(-1);
            expect(lastCall).toEqual([0, '${BAR}']);
        });
    });
});
