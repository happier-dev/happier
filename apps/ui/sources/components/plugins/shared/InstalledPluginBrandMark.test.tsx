import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createValidPluginBrandPngFixture, renderScreen } from '@/dev/testkit';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import type { InstalledPluginBrandPresentation } from './installedPluginBrandPresentation';

const themeState = vi.hoisted(() => ({ theme: null as unknown as Theme }));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: themeState.theme }),
}));

import { InstalledPluginBrandMark } from './InstalledPluginBrandMark';
import { materializeHappierRenderableImage } from '@happier-dev/plugin-ui/advanced';

const brandBytes = createValidPluginBrandPngFixture();
materializeHappierRenderableImage(brandBytes);
const brand: InstalledPluginBrandPresentation = Object.freeze({
    displayName: 'Acme Brand',
    bytes: brandBytes,
});

beforeEach(() => {
    themeState.theme = lightTheme;
});

describe('InstalledPluginBrandMark', () => {
    it('renders an admitted PNG against the canonical opaque light backing with one accessible display name', async () => {
        const screen = await renderScreen(
            <InstalledPluginBrandMark brand={brand} size="small" testID="plugin-brand" />,
        );

        const image = screen.findByType('Image');
        expect(image?.props.source).toEqual({
            uri: `data:image/png;base64,${Buffer.from(createValidPluginBrandPngFixture()).toString('base64')}`,
        });
        expect(image?.props.resizeMode).toBe('contain');
        expect(image?.props.accessible).toBe(true);
        expect(image?.props.accessibilityLabel).toBe('Acme Brand');
        expect(image?.props.style).toEqual(expect.objectContaining({
            width: 32,
            height: 32,
            borderRadius: lightTheme.borderRadius.md,
            backgroundColor: lightTheme.colors.surface.base,
        }));
        expect(screen.getTextContent()).not.toContain('Acme Brand');
    });

    it('uses the neutral textual fallback and becomes decorative when the host already names the package', async () => {
        const screen = await renderScreen(
            <InstalledPluginBrandMark
                brand={{ displayName: 'Acme Brand' }}
                externallyLabelled
                testID="plugin-brand"
            />,
        );

        expect(screen.findAllByType('Image')).toHaveLength(0);
        const [fallback] = screen.findAllByProps({ accessibilityElementsHidden: true });
        expect(fallback?.props.accessible).toBe(false);
        expect(fallback?.props.accessibilityLabel).toBeUndefined();
        expect(fallback?.props.accessibilityElementsHidden).toBe(true);
        expect(fallback?.props.importantForAccessibility).toBe('no-hide-descendants');
        expect(fallback?.props.style).toEqual(expect.objectContaining({
            backgroundColor: lightTheme.colors.surface.base,
            borderRadius: lightTheme.borderRadius.md,
        }));
        expect(screen.getTextContent()).toContain('A');
        expect(screen.getTextContent()).not.toContain('Acme Brand');
    });

    it('inverts the opaque backing contrast pair in dark theme without changing the packaged bitmap', async () => {
        themeState.theme = darkTheme;
        const screen = await renderScreen(
            <InstalledPluginBrandMark brand={brand} testID="plugin-brand" />,
        );

        const image = screen.findByType('Image');
        expect(image?.props.source).toEqual({
            uri: `data:image/png;base64,${Buffer.from(createValidPluginBrandPngFixture()).toString('base64')}`,
        });
        expect(image?.props.style).toEqual(expect.objectContaining({
            backgroundColor: darkTheme.colors.text.primary,
        }));
    });
});
