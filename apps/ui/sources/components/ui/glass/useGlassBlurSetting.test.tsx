import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const { storage } = await import('@/sync/domains/state/storageStore');
const previousState = storage.getState();
afterEach(() => {
    standardCleanup();
    act(() => storage.setState(previousState, true));
});

function setBlurSettings(enabled: boolean, intensity: 'light' | 'regular' | 'strong') {
    act(() => storage.setState({ settings: { ...previousState.settings, glassBlurEnabled: enabled, glassBlurIntensity: intensity, glassSurfaceMaterials: null } }));
}

describe('useGlassBlurSetting', () => {
    it('consumes the write-owned material hold while the acknowledged setting remains unchanged', async () => {
        const { useGlassBlurSetting } = await import('./useGlassBlurSetting');
        const { holdSettingWrite } = await import('@/sync/store/settingsPreview');
        setBlurSettings(true, 'regular');
        act(() => storage.setState({ settingsScope: { serverId: 'held-material-home', accountId: 'owner' } }));
        const reader = await renderHook(useGlassBlurSetting);
        let withdraw!: () => void;
        try {
            await act(async () => { withdraw = holdSettingWrite({ anchor: 'appearance.glassPreset' }, 'solid'); });
            expect(reader.getCurrent().blurEnabled).toBe(false);
            expect(storage.getState().settings.glassBlurEnabled).toBe(true);
            await act(async () => { withdraw(); });
            expect(reader.getCurrent().blurEnabled).toBe(true);
        } finally { withdraw?.(); }
    });
    it('uses Strong for the default floating preset regardless of the global intensity', async () => {
        const { useGlassBlurSetting } = await import('./useGlassBlurSetting');

        setBlurSettings(true, 'light');
        expect((await renderHook(() => useGlassBlurSetting())).getCurrent()).toEqual({
            blurEnabled: true,
            blurIntensity: 80,
        });

        setBlurSettings(true, 'regular');
        expect((await renderHook(() => useGlassBlurSetting())).getCurrent()).toEqual({
            blurEnabled: true,
            blurIntensity: 80,
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
