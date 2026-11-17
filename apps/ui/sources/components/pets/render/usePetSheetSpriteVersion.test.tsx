import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';

const sheet = vi.hoisted(() => ({ width: 1536, height: 2288 }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Image: Object.assign(() => null, {
        // Image decoding is an OS boundary: report the sheet's decoded size.
        getSize: (_uri: string, onSuccess: (width: number, height: number) => void) => onSuccess(sheet.width, sheet.height),
    }) });
});

const { usePetSheetSpriteVersion } = await import('./usePetSheetSpriteVersion');

afterEach(standardCleanup);

describe('usePetSheetSpriteVersion', () => {
    it('takes the atlas version from the decoded sheet, not from a registry label', async () => {
        sheet.height = 2288;
        const hook = await renderHook(() => usePetSheetSpriteVersion({ uri: 'https://petdex.dev/boba.webp' }, undefined));
        expect(hook.getCurrent()).toBe(2);
        sheet.height = 1872;
        const v1 = await renderHook(() => usePetSheetSpriteVersion({ uri: 'https://codex-pets.net/winter.webp' }, undefined));
        expect(v1.getCurrent()).toBe(1);
    });

    it('trusts an authoritative version and never decodes for it', async () => {
        sheet.height = 2288;
        const hook = await renderHook(() => usePetSheetSpriteVersion({ uri: 'https://example.test/held.webp' }, 1));
        expect(hook.getCurrent()).toBe(1);
    });

    it('reports nothing for a sheet that is not a pet atlas', async () => {
        sheet.height = 999;
        const hook = await renderHook(() => usePetSheetSpriteVersion({ uri: 'https://example.test/other.webp' }, undefined));
        expect(hook.getCurrent()).toBeNull();
    });
});
