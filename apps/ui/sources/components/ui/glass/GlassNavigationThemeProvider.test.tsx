import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { useTheme } from '@react-navigation/native';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import { GlassMaterialRuntime } from './GlassMaterialRuntime';
import { GlassNavigationThemeProvider } from './GlassNavigationThemeProvider';
import { useSetGlassAtmosphereBehind, useSetGlassAtmosphereTone } from './glassRuntimeEnvironment';

afterEach(() => { standardCleanup(); });

let appTreeRenders = 0;
/** Stands in for the boot/provider/route tree the root layout passes through the navigation theme. */
function AppTree() {
    appTreeRenders++;
    return null;
}

function AtmosphereProbe() {
    const setBehind = useSetGlassAtmosphereBehind();
    const setTone = useSetGlassAtmosphereTone();
    const theme = useTheme();
    return React.createElement('AtmosphereProbe', { testID: 'atmosphere-probe', setBehind, setTone, theme });
}

describe('glass navigation theme', () => {
    it('reaches only navigation theme readers when the atmosphere environment changes', async () => {
        appTreeRenders = 0;
        const screen = await renderScreen(<GlassMaterialRuntime>
            <GlassNavigationThemeProvider><AppTree /><AtmosphereProbe /></GlassNavigationThemeProvider>
        </GlassMaterialRuntime>);
        const probe = () => screen.findHostByTestId('atmosphere-probe')!;
        const settledRenders = appTreeRenders;
        const canvasTheme = probe().props.theme;
        expect(canvasTheme.colors.background).not.toBe('transparent');

        // The picture covering the route clears the stack background.
        await act(async () => probe().props.setBehind('wallpaper'));
        const pictureTheme = probe().props.theme;
        expect(pictureTheme.colors.background).toBe('transparent');

        // A measured tone changes glass paint, not the navigation background.
        await act(async () => probe().props.setTone({ dark: 0.4, light: 0.6, focus: 0.5 }));
        expect(probe().props.theme).toBe(pictureTheme);

        expect(appTreeRenders).toBe(settledRenders);
    });
});
