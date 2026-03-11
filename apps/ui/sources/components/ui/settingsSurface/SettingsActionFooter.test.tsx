import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Platform: {
        select: <T,>(options: { default?: T; ios?: T }) => options.default ?? options.ios ?? null,
    },
    Dimensions: {
        get: () => ({ width: 1440, height: 900 }),
    },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => styles,
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/forms/SplitActionButtons', () => ({
    SplitActionButtons: (props: any) => React.createElement('SplitActionButtons', props),
}));

describe('SettingsActionFooter', () => {
    it('renders split actions without wrapping them in an item group', async () => {
        const { SettingsActionFooter } = await import('./SettingsActionFooter');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(SettingsActionFooter, {
                    primaryLabel: 'Save',
                    onPrimaryPress: vi.fn(),
                    secondaryLabel: 'Cancel',
                    onSecondaryPress: vi.fn(),
                }),
            );
        });

        expect(tree.root.findAllByType('SplitActionButtons')).toHaveLength(1);
        expect(tree.root.findAllByType('ItemGroup')).toHaveLength(0);
    });
});
