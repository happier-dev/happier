import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const stageSurfaceModuleState = vi.hoisted(() => ({
    voiceLoads: 0,
}));

vi.mock('./surfaces/JourneyVoiceStageSurface', async () => {
    stageSurfaceModuleState.voiceLoads += 1;
    const ReactModule = await import('react');
    return {
        JourneyVoiceStageSurface: (props: Record<string, unknown>) => (
            ReactModule.createElement('JourneyVoiceStageSurface', props)
        ),
    };
});

describe('stageSurfaces', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('loads a registered lazy surface on demand and reuses its cached module', async () => {
        const { stageSurfaceById } = await import('./stageSurfaces');
        const voiceSurface = stageSurfaceById.get('voice');
        if (!voiceSurface) throw new Error('Missing voice stage surface');
        const VoiceSurface = voiceSurface.component;

        expect(stageSurfaceModuleState.voiceLoads).toBe(0);

        const firstScreen = await renderScreen(
            <React.Suspense fallback={null}>
                <VoiceSurface device="desktop" />
            </React.Suspense>,
            { flushOptions: { cycles: 0 } },
        );
        await act(async () => {
            await vi.dynamicImportSettled();
        });

        expect(stageSurfaceModuleState.voiceLoads).toBe(1);
        expect(firstScreen.findByType('JourneyVoiceStageSurface' as never)).not.toBeNull();

        await firstScreen.unmount();
        const secondScreen = await renderScreen(
            <React.Suspense fallback={null}>
                <VoiceSurface device="desktop" />
            </React.Suspense>,
            { flushOptions: { cycles: 0 } },
        );

        expect(stageSurfaceModuleState.voiceLoads).toBe(1);
        expect(secondScreen.findByType('JourneyVoiceStageSurface' as never)).not.toBeNull();
    });

    it('retries a failed surface import instead of caching the rejection for the whole session', async () => {
        const { cacheStageSurfaceLoader } = await import('./stageSurfaces');
        let attempts = 0;
        const load = cacheStageSurfaceLoader(async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('stage surface chunk unavailable');
            return { default: () => null };
        });

        await expect(load()).rejects.toThrow('stage surface chunk unavailable');

        const resolved = await load();
        expect(attempts).toBe(2);
        expect(await load()).toBe(resolved);
        expect(attempts).toBe(2);

        // A surface can fail because a chunk it COMPOSES failed, and that nested
        // lazy lives inside the already-cached module, so the reset has to drop a
        // successful entry too.
        load.reset();
        expect(await load()).not.toBe(resolved);
        expect(attempts).toBe(3);
    });

    it('replaces the lazy component on reset so React cannot keep replaying a cached rejection', async () => {
        const { resetStageSurfaceComponent, stageSurfaceById } = await import('./stageSurfaces');
        const poisoned = stageSurfaceById.get('voice')?.component;
        expect(poisoned).toBeDefined();

        resetStageSurfaceComponent('voice');

        const replacement = stageSurfaceById.get('voice')?.component;
        expect(replacement).toBeDefined();
        expect(replacement).not.toBe(poisoned);

        const RetriedVoiceSurface = replacement as NonNullable<typeof replacement>;
        const screen = await renderScreen(
            <React.Suspense fallback={null}>
                <RetriedVoiceSurface device="desktop" />
            </React.Suspense>,
            { flushOptions: { cycles: 0 } },
        );
        await act(async () => {
            await vi.dynamicImportSettled();
        });

        expect(screen.findByType('JourneyVoiceStageSurface' as never)).not.toBeNull();
    });
});
