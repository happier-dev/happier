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
                                    View: (props: any) => React.createElement('View', props, props.children),
                                    Text: 'Text',
                                    ActivityIndicator: 'ActivityIndicator',
                                    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/lists/useResolvedItemDensity', () => ({
    useResolvedItemDensity: () => 'comfortable',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => null,
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => null,
}));

describe('Item web testID forwarding', () => {
    it('forwards testID as data-testid on interactive web rows', async () => {
        const { Item } = await import('./Item');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Item
                    testID="settings-appearance-themePreference-cycle"
                    title="Appearance"
                    detail="Adaptive"
                    onPress={() => {}}
                />)).tree;

        const pressable = tree.findByType('Pressable' as any);
        expect(pressable.props.testID).toBe('settings-appearance-themePreference-cycle');
        expect(pressable.props['data-testid']).toBe('settings-appearance-themePreference-cycle');
        expect(pressable.props.accessibilityRole).toBe('button');
    });

    it('forwards testID as data-testid on non-interactive web rows', async () => {
        const { Item } = await import('./Item');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Item
                    testID="settings-static-row"
                    title="Static"
                    mode="info"
                />)).tree;

        const view = tree.findByType('View' as any);
        expect(view.props.testID).toBe('settings-static-row');
        expect(view.props['data-testid']).toBe('settings-static-row');
    });
});
