import * as React from 'react';
import { StyleSheet } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createValidPluginBrandPngFixture, renderScreen } from '@/dev/testkit';
import { darkTheme, lightTheme, type Theme } from '@/theme';
import type { InstalledPluginBrandPresentation } from './installedPluginBrandPresentation';

const themeState = vi.hoisted(() => ({ theme: null as unknown as Theme }));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: themeState.theme, rt: { colorScheme: 'light' } }),
}));
// SVG is a native renderer boundary; keep AgentIcon/catalog resolution real.
vi.mock('react-native-svg', () => ({ SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props) }));

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
    it('renders an exact bundled Agent package with its canonical artwork at the compact slot size', async () => {
        const screen = await renderScreen(<InstalledPluginBrandMark
            brand={{ displayName: 'Codex' }} pluginId="happier.agent.codex" pixelSize={10} externallyLabelled
        />);
        const logo = screen.findByType('SvgXml');
        expect(logo?.props.xml).toContain('<path');
        expect(logo?.props.width).toBe(10);
        expect(screen.getTextContent()).not.toContain('C');
    });

    it('renders an admitted colored PNG without a tile with one accessible display name', async () => {
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
        }));
        expect(image?.props.style.backgroundColor).toBeUndefined();
        expect(image?.props.style.tintColor).toBeUndefined();
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
        expect(fallback?.props.style.backgroundColor).toBeUndefined();
        expect(screen.getTextContent()).toContain('A');
        expect(screen.getTextContent()).not.toContain('Acme Brand');
    });

    it('fits the canonical brand mark into an exact compact host-chrome slot', async () => {
        const screen = await renderScreen(
            <InstalledPluginBrandMark
                brand={brand}
                pixelSize={14}
                externallyLabelled
                testID="plugin-brand"
            />,
        );

        const slot = screen.findByTestId('plugin-brand');
        expect(slot?.props.style).toEqual(expect.objectContaining({ width: 14, height: 14 }));
        const scaled = screen.findAllByType('View').find((view) => (
            view.props.style?.width === 32
            && view.props.style?.height === 32
            && view.props.style?.transform?.[0]?.scale === 14 / 32
        ));
        expect(scaled).toBeTruthy();
        expect(screen.findByType('Image')?.props.style.width).toBe(32);
    });

    it.each([['small', 32], ['medium', 48], ['large', 72]] as const)('keeps the %s monogram proportional to its centered identity slot', async (size, pixels) => {
        const screen = await renderScreen(<InstalledPluginBrandMark brand={{ displayName: 'Acme' }} size={size} externallyLabelled />);
        const glyph = screen.findAllByType('Text').find((node) => node.children.includes('A'));
        const geometry = StyleSheet.flatten(glyph?.props.style);
        expect(geometry.fontSize).toBeCloseTo(pixels * 0.75);
        expect(geometry.lineHeight).toBe(pixels);
        const slot = screen.findAllByProps({ accessibilityElementsHidden: true })[0];
        expect(slot?.props.style).toEqual(expect.objectContaining({ width: pixels, height: pixels, alignItems: 'center', justifyContent: 'center' }));
    });

    it('renders a declared monochrome glyph in the dark theme foreground without changing its bytes', async () => {
        themeState.theme = darkTheme;
        const screen = await renderScreen(
            <InstalledPluginBrandMark brand={{ ...brand, monochrome: true }} testID="plugin-brand" />,
        );

        const image = screen.findByType('Image');
        expect(image?.props.source).toEqual({
            uri: `data:image/png;base64,${Buffer.from(createValidPluginBrandPngFixture()).toString('base64')}`,
        });
        expect(image?.props.style).toEqual(expect.objectContaining({
            tintColor: darkTheme.colors.text.primary,
        }));
        expect(image?.props.style.backgroundColor).toBeUndefined();
    });
});
