import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

let storage: typeof import('@/sync/domains/state/storage')['storage'];
let previousState: ReturnType<typeof storage.getState>;
beforeAll(async () => {
    ({ storage } = await import('@/sync/domains/state/storage'));
    previousState = storage.getState();
});
afterEach(() => {
    standardCleanup();
    act(() => storage.setState(previousState, true));
});

function setBlurSettings(enabled: boolean, intensity: 'light' | 'regular' | 'strong') {
    act(() => storage.setState({ settings: { ...previousState.settings, glassBlurEnabled: enabled, glassBlurIntensity: intensity, glassSurfaceMaterials: null } }));
}

describe('useGlassBlurSetting', () => {
    it('resolves the intensity enum to a blur radius and passes enabled through', async () => {
        const { useGlassBlurSetting } = await import('./useGlassBlurSetting');

        setBlurSettings(true, 'light');
        expect((await renderHook(() => useGlassBlurSetting())).getCurrent()).toEqual({
            blurEnabled: true,
            blurIntensity: 25,
        });

        setBlurSettings(true, 'regular');
        expect((await renderHook(() => useGlassBlurSetting())).getCurrent()).toEqual({
            blurEnabled: true,
            blurIntensity: 50,
        });

        setBlurSettings(true, 'strong');
        expect((await renderHook(() => useGlassBlurSetting())).getCurrent()).toEqual({
            blurEnabled: true,
            blurIntensity: 80,
        });
    });

    it('reports disabled while preserving the selected regular intensity', async () => {
        const { useGlassBlurSetting } = await import('./useGlassBlurSetting');

        setBlurSettings(false, 'regular');
        expect((await renderHook(() => useGlassBlurSetting())).getCurrent()).toEqual({
            blurEnabled: false,
            blurIntensity: 50,
        });
    });
});
