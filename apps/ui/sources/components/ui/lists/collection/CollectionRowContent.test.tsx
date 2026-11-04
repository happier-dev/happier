import * as React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { HappierMaterialRoleProvider, happierMaterialInnerBackgroundColor } from '@happier-dev/plugin-ui/presentation';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
afterEach(standardCleanup);

function ancestorTestIds(node: ReactTestInstance | null): string[] {
    const ids: string[] = [];
    for (let current = node?.parent ?? null; current; current = current.parent) {
        const id = current.props?.testID;
        if (typeof id === 'string') ids.push(id);
    }
    return ids;
}

describe('CollectionRowContent', () => {
    /**
     * On the web a `button` role renders a `<button>`, and a `<button>` may not contain another one: the row's
     * own press target and its trailing controls (tag, pin, ⋯) are siblings.
     */
    it('keeps trailing controls outside the row press target', async () => {
        const { CollectionRowContent } = await import('./CollectionRowContent');
        const screen = await renderScreen(
            <CollectionRowContent
                density="detailed"
                identity={React.createElement('Identity')}
                title={React.createElement('Title')}
                trailing={<Pressable testID="row-action" accessibilityRole="button" accessibilityLabel="Pin" onPress={() => {}} />}
                renderContainer={(content, style) => (
                    <Pressable testID="row-press-target" accessibilityRole="button" style={style} onPress={() => {}}>{content}</Pressable>
                )}
            />,
        );
        expect(ancestorTestIds(screen.findHostByTestId('row-action'))).not.toContain('row-press-target');
        expect(ancestorTestIds(screen.root.findAllByType('Title' as never)[0] ?? null)).toContain('row-press-target');
    });

    it('lies flat on the plane: only the open row and the hovered row take a fill, through the plane material', async () => {
        const { CollectionRowContent } = await import('./CollectionRowContent');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        const rowFill = async (state: Readonly<{ selected?: boolean; hovered?: boolean }>) => {
            const screen = await renderScreen(<HappierMaterialRoleProvider role="sidebar" translucentColor={theme.colors.surface.selected}>
                <CollectionRowContent density="compact" {...state} title={<>sample</>} />
            </HappierMaterialRoleProvider>);
            const styles = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style)).filter(Boolean);
            const row = styles.find(style => style.height === 32)!;
            standardCleanup();
            return row;
        };
        const rest = await rowFill({});
        expect(rest.backgroundColor).toBeUndefined();
        expect(rest.borderLeftWidth ?? 0).toBe(0);
        expect((await rowFill({ selected: true })).backgroundColor)
            .toBe(happierMaterialInnerBackgroundColor(theme.colors.surface.elevated, theme.colors.surface.selected, 'sidebar', true));
        expect((await rowFill({ hovered: true })).backgroundColor)
            .toBe(happierMaterialInnerBackgroundColor(theme.colors.surface.hover, theme.colors.surface.selected, 'sidebar', true));
    });
});
