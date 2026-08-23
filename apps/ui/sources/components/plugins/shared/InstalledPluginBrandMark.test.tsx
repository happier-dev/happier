import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import type { InstalledPluginBrandPresentation } from './installedPluginBrandPresentation';


/**
 * A minimal admissible packaged mark: PNG signature plus a real IHDR.
 *
 * The shared renderable-image owner reads the declared canvas out of IHDR to
 * bound decode memory before it will produce a platform source, so three
 * arbitrary bytes are not a mark any host can render. `seed` distinguishes one
 * target's bytes from another's without changing what makes them admissible.
 */
function brandPngFixture(seed: number): Uint8Array {
    const bytes = new Uint8Array(48);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 16);
    view.setUint32(20, 16);
    for (let index = 24; index < bytes.length; index += 1) bytes[index] = (index * seed) % 251;
    // The reader that acquires mark bytes admits them off the render path; this
    // stands in for it, because presentation deliberately cannot derive a source
    // of its own.
    materializeHappierRenderableImage(bytes);
    return bytes;
}

const themeState = vi.hoisted(() => ({ theme: null as unknown as Theme }));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: themeState.theme }),
}));

import { InstalledPluginBrandMark } from './InstalledPluginBrandMark';
import { materializeHappierRenderableImage } from '@happier-dev/plugin-ui/advanced';

const brand: InstalledPluginBrandPresentation = Object.freeze({
    displayName: 'Acme Brand',
    bytes: brandPngFixture(1),
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
            uri: `data:image/png;base64,${Buffer.from(brandPngFixture(1)).toString('base64')}`,
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
            uri: `data:image/png;base64,${Buffer.from(brandPngFixture(1)).toString('base64')}`,
        });
        expect(image?.props.style).toEqual(expect.objectContaining({
            backgroundColor: darkTheme.colors.text.primary,
        }));
    });
});
