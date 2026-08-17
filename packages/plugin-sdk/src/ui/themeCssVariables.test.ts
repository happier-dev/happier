import { describe, expect, it } from 'vitest';

import { createSurfaceContextFixture } from './surfaceContext.fixture.js';
import {
    applyPluginUiThemeCssVariables,
    buildPluginUiThemeCssVariables,
} from './themeCssVariables.js';

const { theme } = createSurfaceContextFixture({
    mount: {
        kind: 'destination',
        destination: { pluginId: 'com.acme.fixture', localId: 'settings' },
        container: 'settingsPage',
    },
    target: { kind: 'app' },
    locale: 'en',
    colorScheme: 'dark',
});

describe('hosted-web theme CSS variables (§3.3, EU-8)', () => {
    it('projects every semantic theme field under the --happier-plugin-* namespace', () => {
        const variables = buildPluginUiThemeCssVariables(theme);

        // Every declared theme value reaches a variable — the count is derived
        // from the theme itself, so a field added at the Protocol owner without
        // a projection fails here rather than silently disappearing.
        const declaredValues = Object.keys(theme.colors).length
            + Object.keys(theme.spacing).length
            + Object.keys(theme.radii).length;
        expect(Object.keys(variables).length).toBeGreaterThan(declaredValues);
        expect(Object.keys(variables).every((name) => name.startsWith('--happier-plugin-'))).toBe(true);

        expect(variables['--happier-plugin-color-canvas']).toBe(theme.colors.canvas);
        expect(variables['--happier-plugin-color-elevated-surface']).toBe(theme.colors.elevatedSurface);
        // Numeric metrics become CSS lengths; a bare number would be invalid CSS
        // everywhere except `line-height`.
        expect(variables['--happier-plugin-spacing-medium']).toBe(`${theme.spacing.medium}px`);
        expect(variables['--happier-plugin-radius-panel']).toBe(`${theme.radii.panel}px`);
        expect(variables['--happier-plugin-text-body-size']).toBe(`${theme.typography.body.fontSize}px`);
        expect(variables['--happier-plugin-text-body-weight']).toBe(theme.typography.body.fontWeight);
        // `code` carries a family and no weight; the projection follows the type
        // rather than emitting `undefined`.
        expect(variables['--happier-plugin-text-code-weight']).toBeUndefined();
    });

    it('writes the variables onto a target element and overwrites them on a later snapshot', () => {
        const written = new Map<string, string>();
        const target = { style: { setProperty: (property: string, value: string) => { written.set(property, value); } } };

        applyPluginUiThemeCssVariables(theme, target);
        expect(written.get('--happier-plugin-color-canvas')).toBe(theme.colors.canvas);

        applyPluginUiThemeCssVariables(
            { ...theme, colors: { ...theme.colors, canvas: '#123456' } },
            target,
        );
        expect(written.get('--happier-plugin-color-canvas')).toBe('#123456');
    });
});
