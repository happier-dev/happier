import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('session row sidebar material', () => {
    it('inherits the sidebar coat for ordinary and selected rows without fading text', async () => {
        const { SessionListRowPresentation } = await import('./SessionListRowPresentation');
        const { glassSurfaceBackgroundColor } = await import('@/components/ui/glass/glassSurfacePaint');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        for (const selected of [false, true]) {
            const screen = await renderScreen(<SessionListRowPresentation density="minimal" selected={selected} title={<>sample</>} />);
            const row = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style)).find(style => style?.borderLeftWidth === 2)!;
            expect(row.backgroundColor).toBe(glassSurfaceBackgroundColor(selected ? theme.colors.surface.selected : theme.colors.surface.base, 'sidebar', true));
            expect(row.borderColor).toBe(glassSurfaceBackgroundColor(theme.colors.surface.base, 'sidebar', true));
            expect(row.opacity).toBeUndefined();
            standardCleanup();
        }
    });

    it('keeps attention and error status tints within the requested sidebar material', async () => {
        const { SessionListRowPresentation } = await import('./SessionListRowPresentation');
        for (const statusTone of ['attention', 'danger'] as const) {
            const screen = await renderScreen(<SessionListRowPresentation density="minimal" statusTone={statusTone} title={<>sample</>} />);
            const row = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style)).find(style => style?.borderLeftWidth === 2)!;
            expect(row.backgroundColor).toContain('--happier-glass-sidebar-nested-opacity');
            expect(row.borderColor).not.toContain('--happier-glass-sidebar-nested-opacity');
            expect(row.opacity).toBeUndefined();
            standardCleanup();
        }
    });
});
