import React from 'react';
import renderer from 'react-test-renderer';
import { Pressable } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

/**
 * `installUiListsCommonModuleMocks()` registers its `react-native` mock from
 * inside a function, so it is NOT hoisted above this file's imports. Anything
 * already evaluated by those imports — `@/components/ui/text/Text` reaches the
 * shared `@happier-dev/plugin-ui` presentation layer — therefore binds the
 * setup-level stub (`Platform.OS === 'node'`) while this file's own modules see
 * the web mock. A shared component that branches on the platform then renders
 * its NATIVE variant inside a web test. This hoisted declaration pins one
 * react-native for the whole graph; it is redundant with the helper's default
 * and deliberately identical to it.
 */
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
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
    function findClosestPressableAncestor(node: renderer.ReactTestInstance): renderer.ReactTestInstance | null {
        let current = node.parent;
        while (current) {
            if (String(current.type) === 'Pressable') {
                return current;
            }
            current = current.parent;
        }
        return null;
    }

    it('forwards testID as data-testid on interactive web rows', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(<Item
                    testID="settings-appearance-themePreference-cycle"
                    title="Appearance"
                    detail="Adaptive"
                    detailTestID="settings-appearance-themePreference-detail"
                    onPress={() => {}}
                />);

        const row = screen.findByTestId('settings-appearance-themePreference-cycle');
        expect(row).toBeTruthy();
        expect(row?.props.testID).toBe('settings-appearance-themePreference-cycle');
        expect(row?.props['data-testid']).toBe('settings-appearance-themePreference-cycle');
        expect(row?.props.accessibilityRole).toBeUndefined();
        expect(row?.props.role).toBe('button');
        expect(row?.props.accessibilityLabel).toBe('Appearance. Adaptive');
        expect(row?.props.tabIndex).toBe(0);
        const detail = screen.findByTestId('settings-appearance-themePreference-detail');
        expect(detail?.props.children).toBe('Adaptive');
    });

    it('avoids button semantics on web rows with nested right-side actions', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item
                testID="item-with-actions"
                title="Relay"
                onPress={() => {}}
                rightElement={(
                    <Pressable testID="item-right-action" onPress={() => {}}>
                        <Text>Action</Text>
                    </Pressable>
                )}
            />,
        );

        const row = screen.findByTestId('item-with-actions');
        const action = screen.findByTestId('item-right-action');

        expect(findClosestPressableAncestor(action as renderer.ReactTestInstance)).toBe(row);
        expect(row?.props.accessibilityRole).toBeUndefined();
        expect(row?.props.role).toBeUndefined();
    });

    it('keeps a split navigation row named and button-semantic when its right-side action is a sibling', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item
                testID="provider-connection-row"
                title="Work Ollama"
                subtitle="Ollama · 1 model"
                onPress={() => {}}
                rightElement={(
                    <Pressable testID="provider-connection-toggle" onPress={() => {}}>
                        <Text>Enabled</Text>
                    </Pressable>
                )}
                rightElementOutsidePressable
            />,
        );

        const row = screen.findByTestId('provider-connection-row');
        const action = screen.findByTestId('provider-connection-toggle');

        expect(findClosestPressableAncestor(action as renderer.ReactTestInstance)).toBeNull();
        expect(row?.props.role).toBe('button');
        expect(row?.props.accessibilityLabel).toBe('Work Ollama. Ollama · 1 model');
        expect(row?.props.tabIndex).toBe(0);
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

    it('exposes a stable selected-state attribute for interactive web rows', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(<Item
                    testID="settings-notifications-sounds-account-happier"
                    title="Happier"
                    selected
                    onPress={() => {}}
                />);

        const row = screen.findByTestId('settings-notifications-sounds-account-happier');
        expect(row).toBeTruthy();
        expect(row?.props['aria-selected']).toBe(true);
    });

    it('exposes checked radio semantics and activates a radio row with Space without swallowing the event', async () => {
        const { Item } = await import('./Item');
        const onPress = vi.fn();
        const screen = await renderScreen(<Item
                    testID="voice-provider-openai"
                    title="OpenAI"
                    accessibilityRole="radio"
                    webRole="radio"
                    selected
                    onPress={onPress}
                />);

        const row = screen.findByTestId('voice-provider-openai');
        expect(row?.props.role).toBe('radio');
        expect(row?.props.accessibilityState).toEqual({ checked: true });
        expect(row?.props['aria-selected']).toBeUndefined();
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        row?.props.onKeyDown?.({ key: ' ', preventDefault, stopPropagation });
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopPropagation).not.toHaveBeenCalled();
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('preserves named checked and disabled semantics for a visible unavailable radio option', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(<Item
                    testID="voice-provider-hosted"
                    title="Hosted voice"
                    subtitle="Unavailable on this server"
                    accessibilityRole="radio"
                    webRole="radio"
                    selected={false}
                    disabled
                />);

        const row = screen.findByTestId('voice-provider-hosted');
        expect(row?.props.role).toBe('radio');
        expect(row?.props.accessibilityLabel).toBe('Hosted voice. Unavailable on this server');
        expect(row?.props.accessibilityState).toEqual({ checked: false, disabled: true });
        expect(row?.props['aria-checked']).toBe(false);
        expect(row?.props['aria-disabled']).toBe(true);
        expect(row?.props.onPress).toBeUndefined();
        expect(row?.props.tabIndex).toBe(-1);
    });

    it('exposes loading on the row while keeping its visual spinner out of accessibility traversal', async () => {
        const { Item } = await import('./Item');
        const screen = await renderScreen(
            <Item
                testID="external-session-pending"
                title="Importing session"
                loading
                onPress={() => {}}
            />,
        );

        const row = screen.findByTestId('external-session-pending');
        expect(row?.props.accessibilityState).toEqual({ disabled: true, busy: true });

        const spinners = row?.findAll((node) => node.props.accessibilityRole === 'progressbar') ?? [];
        expect(spinners).toHaveLength(1);
        expect(spinners[0]?.props['aria-hidden']).toBe(true);
        expect(spinners[0]?.props.accessibilityElementsHidden).toBe(true);
        expect(spinners[0]?.props.importantForAccessibility).toBe('no-hide-descendants');
    });
});
