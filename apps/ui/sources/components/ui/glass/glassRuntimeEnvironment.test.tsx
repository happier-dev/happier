import * as React from 'react';
import { expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { GlassRuntimeEnvironmentProvider, useGlassReduceTransparency } from './glassRuntimeEnvironment';

it('keeps transparency readers asleep for tone, backing and window changes, but delivers transparency', async () => {
    let renders = 0;
    let reduceTransparency = false;
    function AtmosphereReader() { renders++; reduceTransparency = useGlassReduceTransparency(); return null; }
    const child = <AtmosphereReader />;
    const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ highContrast: true }}>{child}</GlassRuntimeEnvironmentProvider>);
    try {
        renders = 0;
        for (const highContrast of [false, true, false]) await screen.update(
            <GlassRuntimeEnvironmentProvider value={{ highContrast, atmosphereBehind: 'wallpaper', atmosphereTone: undefined }}>{child}</GlassRuntimeEnvironmentProvider>);
        expect(renders).toBe(0);
        expect(reduceTransparency).toBe(false);
        await screen.update(<GlassRuntimeEnvironmentProvider value={{ reduceTransparency: true }}>{child}</GlassRuntimeEnvironmentProvider>);
        expect(renders).toBe(1);
        expect(reduceTransparency).toBe(true);
    } finally { await screen.unmount(); }
});
