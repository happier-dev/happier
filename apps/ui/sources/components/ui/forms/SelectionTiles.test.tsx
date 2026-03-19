import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            surface: '#ffffff',
            divider: '#e5e7eb',
            text: '#111827',
            textSecondary: '#6b7280',
            button: {
                primary: {
                    background: '#2563eb',
                },
            },
            warningCritical: '#dc2626',
            success: '#16a34a',
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme) : input) },
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

describe('SelectionTiles', () => {
    it('supports single selection mode', async () => {
        const onChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SelectionTiles
                    options={[
                        { id: 'session_menu', title: 'Session menu' },
                        { id: 'command_palette', title: 'Command palette' },
                    ]}
                    value={null}
                    onChange={onChange}
                />,
            );
        });

        const pressables = tree.root.findAllByType('Pressable' as any);
        await act(async () => {
            pressables[1]!.props.onPress();
        });

        expect(pressables[0]!.props.accessibilityRole).toBe('radio');
        expect(pressables[0]!.props.accessibilityState).toEqual({ selected: false, disabled: false });
        expect(pressables[1]!.props.accessibilityRole).toBe('radio');
        expect(onChange).toHaveBeenCalledWith('command_palette');
    });

    it('supports multiple selection mode and toggles selected values', async () => {
        const onChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SelectionTiles
                    selectionMode="multiple"
                    options={[
                        { id: 'voice_panel', title: 'Voice panel' },
                        { id: 'mcp', title: 'MCP' },
                    ]}
                    value={['voice_panel']}
                    onChange={onChange}
                />,
            );
        });

        const pressables = tree.root.findAllByType('Pressable' as any);
        await act(async () => {
            pressables[1]!.props.onPress();
        });
        await act(async () => {
            pressables[0]!.props.onPress();
        });

        expect(pressables[0]!.props.accessibilityRole).toBe('checkbox');
        expect(pressables[0]!.props.accessibilityState).toEqual({ checked: true, disabled: false });
        expect(pressables[1]!.props.accessibilityRole).toBe('checkbox');
        expect(pressables[1]!.props.accessibilityState).toEqual({ checked: false, disabled: false });
        expect(onChange).toHaveBeenNthCalledWith(1, ['voice_panel', 'mcp']);
        expect(onChange).toHaveBeenNthCalledWith(2, []);
    });

    it('does not toggle disabled options', async () => {
        const onChange = vi.fn();
        const { SelectionTiles } = await import('./SelectionTiles');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SelectionTiles
                    selectionMode="multiple"
                    options={[
                        { id: 'voice_tool', title: 'Voice tool', disabled: true, badge: 'Unavailable' },
                    ]}
                    value={[]}
                    onChange={onChange}
                />,
            );
        });

        const pressables = tree.root.findAllByType('Pressable' as any);
        await act(async () => {
            pressables[0]!.props.onPress();
        });

        expect(onChange).not.toHaveBeenCalled();
    });
});
