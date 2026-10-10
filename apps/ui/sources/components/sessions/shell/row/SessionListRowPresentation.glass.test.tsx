import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { HappierMaterialRoleProvider, happierMaterialInnerBackgroundColor } from '@happier-dev/plugin-ui/presentation';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
afterEach(standardCleanup);

describe('session row sidebar material', () => {
    it('inherits the sidebar coat for ordinary and selected rows without fading text', async () => {
        const { SessionListRowPresentation } = await import('./SessionListRowPresentation');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        for (const selected of [false, true]) {
            const screen = await renderScreen(<HappierMaterialRoleProvider role="sidebar" translucentColor={theme.colors.surface.selected}>
                <SessionListRowPresentation density="minimal" selected={selected} title={<>sample</>} />
            </HappierMaterialRoleProvider>);
            const row = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style)).find(style => style?.borderLeftWidth === 2)!;
            expect(row.backgroundColor).toBe(happierMaterialInnerBackgroundColor(selected ? theme.colors.surface.selected : theme.colors.surface.base, selected ? theme.colors.surface.selected : 'transparent', 'sidebar', true));
            expect(row.borderColor).toBe(happierMaterialInnerBackgroundColor(theme.colors.surface.base, 'transparent', 'sidebar', true));
            expect(row.opacity).toBeUndefined();
            standardCleanup();
        }
    });

    it('preserves authored attention and error tint within the sidebar material', async () => {
        const { SessionListRowPresentation } = await import('./SessionListRowPresentation');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        for (const statusTone of ['attention', 'danger'] as const) {
            const screen = await renderScreen(<HappierMaterialRoleProvider role="sidebar" translucentColor={theme.colors.surface.selected}>
                <SessionListRowPresentation density="minimal" statusTone={statusTone} title={<>sample</>} />
            </HappierMaterialRoleProvider>);
            const row = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style)).find(style => style?.borderLeftWidth === 2)!;
            const color = statusTone === 'danger' ? theme.colors.state.danger.background : theme.colors.state.warning.background;
            expect(row.backgroundColor).toBe(happierMaterialInnerBackgroundColor(color, color, 'sidebar', true));
            expect(row.borderColor).not.toContain('--happier-glass-sidebar-nested-opacity');
            expect(row.opacity).toBeUndefined();
            standardCleanup();
        }
    });
});
