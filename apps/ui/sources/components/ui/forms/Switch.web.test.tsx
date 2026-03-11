import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    View: (props: any) => React.createElement('View', props, props.children),
}));

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            switch: {
                track: { active: '#0f0', inactive: '#999' },
                thumb: { active: '#fff' },
            },
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme) : input) },
    };
});

describe('Switch.web', () => {
    it('exposes aria-checked for web switch semantics', async () => {
        const { Switch } = await import('./Switch.web');
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(
                <Switch
                    value
                    onValueChange={() => {}}
                    testID="settings-toggle"
                />,
            );
        });

        const pressable = tree.root.findByType('Pressable' as any);
        expect(pressable.props.accessibilityRole).toBe('switch');
        expect(pressable.props['aria-checked']).toBe(true);
    });
});
