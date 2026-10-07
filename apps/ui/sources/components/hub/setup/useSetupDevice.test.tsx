import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));

// Native viewport and browser hardware are external platform boundaries. The responsive
// classifier and scanner eligibility remain real beneath these boundary fixtures.
vi.mock('react-native', async () => (
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
    })
));

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
});

describe('Home setup device presentation', () => {
    it('recomposes a narrow desktop browser without treating it as a scanner device', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 });
        vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: query.includes('pointer: fine') }) });
        Object.assign(viewport, { width: 390, height: 844 });
        const { useSetupDevice } = await import('./useSetupDevice');
        const hook = await renderHook(() => useSetupDevice());

        expect(hook.getCurrent()).toMatchObject({ isComputer: true, isPhone: false, tileLayout: 'row' });
        Object.assign(viewport, { width: 1440, height: 1000 });
        await hook.rerender();
        expect(hook.getCurrent()).toMatchObject({ isComputer: true, isPhone: false, tileLayout: 'card' });
        Object.assign(viewport, { width: 844, height: 390 });
        await hook.rerender();
        expect(hook.getCurrent()).toMatchObject({ isComputer: true, isPhone: false, tileLayout: 'row' });
    });

    it('keeps real phone scanning eligibility with the compact presentation', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; Mobile)', maxTouchPoints: 5 });
        vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
        Object.assign(viewport, { width: 390, height: 844 });
        const { useSetupDevice } = await import('./useSetupDevice');
        const hook = await renderHook(() => useSetupDevice());
        expect(hook.getCurrent()).toMatchObject({ isComputer: false, isPhone: true, tileLayout: 'row' });
    });
});
