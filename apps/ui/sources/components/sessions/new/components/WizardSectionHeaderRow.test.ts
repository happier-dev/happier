import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { WizardSectionHeaderRow } from './WizardSectionHeaderRow';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('WizardSectionHeaderRow', () => {
    it('renders the optional action immediately after the title and invokes its handler', () => {
        const onPress = vi.fn();

        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(
                React.createElement(WizardSectionHeaderRow, {
                    iconName: 'desktop-outline',
                    title: 'Select Machine',
                    action: {
                        accessibilityLabel: 'Refresh machines',
                        iconName: 'refresh-outline',
                        onPress,
                    },
                }),
            );
        });

        const rootView = tree?.root.findByType('View');
        const children = React.Children.toArray(rootView?.props.children).filter(React.isValidElement);
        const childTypes = children.map((child) => child.type);

        expect(childTypes[0]).toBe('Ionicons');
        expect(childTypes[2]).toBe('Pressable');
        expect((children[1]?.props as { children?: unknown }).children).toBe('Select Machine');

        const action = tree?.root.findByProps({ accessibilityLabel: 'Refresh machines' });
        expect(action).toBeTruthy();

        act(() => {
            action?.props.onPress?.();
        });

        expect(onPress).toHaveBeenCalledTimes(1);
    });
});
