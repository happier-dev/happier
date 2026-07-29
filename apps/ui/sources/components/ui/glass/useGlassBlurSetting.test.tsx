import { describe, expect, it, vi } from 'vitest';

import { createPartialStorageModuleMock, renderHook } from '@/dev/testkit';

let blurEnabledSetting = true;
let blurIntensitySetting: 'light' | 'regular' | 'strong' | undefined = 'regular';

vi.mock('@/sync/domains/state/storage', async (importOriginal) =>
    await createPartialStorageModuleMock(importOriginal as <T>() => Promise<T>, {
        useSetting: (key: string) => {
            if (key === 'glassBlurEnabled') return blurEnabledSetting;
            if (key === 'glassBlurIntensity') return blurIntensitySetting;
            return undefined;
        },
    }),
);

describe('useGlassBlurSetting', () => {
    it('resolves the intensity enum to a blur radius and passes enabled through', async () => {
        const { useGlassBlurSetting } = await import('./useGlassBlurSetting');

        blurEnabledSetting = true;
        blurIntensitySetting = 'light';
        expect((await renderHook(() => useGlassBlurSetting())).getCurrent()).toEqual({
            blurEnabled: true,
            blurIntensity: 25,
        });

        blurIntensitySetting = 'regular';
        expect((await renderHook(() => useGlassBlurSetting())).getCurrent()).toEqual({
            blurEnabled: true,
            blurIntensity: 50,
        });

        blurIntensitySetting = 'strong';
        expect((await renderHook(() => useGlassBlurSetting())).getCurrent()).toEqual({
            blurEnabled: true,
            blurIntensity: 80,
        });
    });

    it('reports disabled and falls back to the regular intensity for an unknown value', async () => {
        const { useGlassBlurSetting } = await import('./useGlassBlurSetting');

        blurEnabledSetting = false;
        blurIntensitySetting = undefined;
        expect((await renderHook(() => useGlassBlurSetting())).getCurrent()).toEqual({
            blurEnabled: false,
            blurIntensity: 50,
        });
    });
});
