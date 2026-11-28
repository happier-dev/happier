/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadingPlanetBreathS, loadingPlanetBreathScale } from '@happier-dev/brand/glyph-scene';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { readLaunchShellBreathS } from '@/boot/launchCurtain';
import { AppLaunchState, LaunchCurtain } from './AppLaunchState';

const glyphModuleEvaluated = vi.hoisted(() => vi.fn());
const reducedMotion = vi.hoisted(() => ({ value: false }));

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotion.value,
}));
vi.mock('@/components/atmosphere/glyph/GlyphSurface.web', async importOriginal => {
    glyphModuleEvaluated();
    return await importOriginal<typeof import('@/components/atmosphere/glyph/GlyphSurface.web')>();
});

afterEach(() => {
    standardCleanup();
    document.documentElement.classList.remove('launch-planet');
    reducedMotion.value = false;
    glyphModuleEvaluated.mockClear();
});

async function renderHeldLaunch() {
    document.documentElement.classList.add('launch-planet');
    const screen = await renderScreen(
        <>
            <AppLaunchState testID="app-boot-loading" />
            <LaunchCurtain />
        </>,
    );
    await vi.dynamicImportSettled();
    return screen;
}

it('moves while launch is held: the curtain loads the live Loading planet over its Still frame', async () => {
    const screen = await renderHeldLaunch();

    expect(screen.findHostByTestId('launch-curtain')).not.toBeNull();
    expect(glyphModuleEvaluated).toHaveBeenCalled();
    expect(screen.findHostByTestId('launch-curtain-live')).not.toBeNull();
    // Until the live planet has painted, the Still frame stays in the same rect.
    expect(screen.findHostByTestId('launch-curtain-still')).not.toBeNull();
});

it('keeps reduced motion on the Still frame without loading the live renderer', async () => {
    reducedMotion.value = true;
    const screen = await renderHeldLaunch();

    expect(screen.findHostByTestId('launch-curtain-still')).not.toBeNull();
    expect(screen.findHostByTestId('launch-curtain-live')).toBeNull();
    expect(glyphModuleEvaluated).not.toHaveBeenCalled();
});

it('reads the HTML shell breath as the live planet\'s starting phase', () => {
    const shellBreath = { animationName: 'launch-planet-breath', currentTime: 3_250 };
    const other = { animationName: 'something-else', currentTime: 9_000 };
    const getAnimations = vi.fn(() => [other, shellBreath]);
    Object.defineProperty(document, 'getAnimations', { configurable: true, value: getAnimations });
    try {
        expect(readLaunchShellBreathS()).toBeCloseTo(3.25);
        getAnimations.mockReturnValue([other]);
        expect(readLaunchShellBreathS()).toBe(0);
    } finally {
        delete (document as { getAnimations?: unknown }).getAnimations;
    }
});

it('breathes the HTML shell on the Loading planet\'s own cycle', () => {
    // The pre-JS shell cannot import the brand owner, so its CSS copy is checked against it.
    const html = readFileSync(resolve(__dirname, '../../../../public/index.html'), 'utf8');
    expect(html).toContain(`launch-planet-breath ${loadingPlanetBreathS}s`);
    expect(html).toContain(`scale(${1 + loadingPlanetBreathScale})`);
});
