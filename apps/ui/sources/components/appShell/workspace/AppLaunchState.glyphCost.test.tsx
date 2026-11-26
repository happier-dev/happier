/** @vitest-environment jsdom */
import * as React from 'react';
import { expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AppLaunchState, LaunchCurtain } from './AppLaunchState';

const glyphModuleEvaluated = vi.hoisted(() => vi.fn());

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
    useReducedMotionPreference: () => false,
}));
vi.mock('@/components/atmosphere/glyph/GlyphSurface.web', async importOriginal => {
    glyphModuleEvaluated();
    return await importOriginal<typeof import('@/components/atmosphere/glyph/GlyphSurface.web')>();
});

it('keeps the static boot mark while launch is held without loading the live glyph renderer', async () => {
    document.documentElement.classList.add('launch-planet');
    try {
        const screen = await renderScreen(
            <>
                <AppLaunchState testID="app-boot-loading" />
                <LaunchCurtain />
            </>,
        );
        await vi.dynamicImportSettled();

        expect(screen.findHostByTestId('launch-curtain')).not.toBeNull();
        expect(screen.findHostByTestId('launch-curtain-still')).not.toBeNull();
        expect(glyphModuleEvaluated).not.toHaveBeenCalled();
    } finally {
        standardCleanup();
        document.documentElement.classList.remove('launch-planet');
    }
});
