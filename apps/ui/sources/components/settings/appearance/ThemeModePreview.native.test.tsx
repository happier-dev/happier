import * as React from 'react';
import { Platform, StyleSheet } from 'react-native';
import Color from 'color';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { lightTheme } from '@/theme';
import { ThemePalettePreview } from './ThemeModePreview';

// Only the native host boundary is substituted; material resolution and painting stay real.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
afterEach(standardCleanup);

describe('Native material miniature', () => {
    it('paints the effective floating coat and honors reduced transparency', async () => {
        expect(Platform.OS).toBe('android');
        const materials = glassPresetMaterials('everywhere');
        for (const reduced of [false, true]) {
            const screen = await renderScreen(<ThemePalettePreview palette={lightTheme} materials={materials}
                materialEnvironment={{ reduceTransparency: reduced }} floatingOnly />);
            const backgrounds = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style)?.backgroundColor);
            expect(backgrounds.filter(value => typeof value === 'string').join(' | ')).toContain(
                Color(lightTheme.colors.surface.base).alpha(reduced ? 1 : 0.02).rgb().string(),
            );
            standardCleanup();
        }
    });
});
