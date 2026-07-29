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
});
