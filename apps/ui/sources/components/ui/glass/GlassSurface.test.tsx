import * as React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installExpoBlurRequireStub } from '@/dev/testkit/mocks/expoBlur';
import { lightTheme } from '@/theme';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { get OS() { return platform.OS; } },
        View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
            React.createElement('View', props, children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Native SDK boundaries: `expo-blur` (blur material, loaded through `require`) and
// `expo-glass-effect` (Liquid Glass, reported unavailable so iOS exercises the blur tier).
const restoreExpoBlur = installExpoBlurRequireStub();
vi.mock('expo-glass-effect', () => ({
    isLiquidGlassAvailable: () => false,
    GlassView: 'GlassView',
}));

function backgroundColorOf(style: unknown): unknown {
    const styles = Array.isArray(style) ? style.flat(Infinity) : [style];
    return Object.assign({}, ...styles.filter((value) => Boolean(value) && typeof value === 'object')).backgroundColor;
}

async function renderGlassSurface(props: Readonly<{ enabled?: boolean }> = {}) {
    const { GlassSurface } = await import('./GlassSurface');
    return renderScreen(
        <GlassSurface testID="glass" enabled={props.enabled} blurIntensity={80}>
            {React.createElement('Content')}
        </GlassSurface>,
    );
}

afterEach(() => {
    platform.OS = 'ios';
});

afterAll(() => {
    restoreExpoBlur();
});

describe('GlassSurface', () => {
    it('renders the native blur material on iOS without Liquid Glass', async () => {
        const screen = await renderGlassSurface();

        expect(screen.findAllByType('BlurView')).toHaveLength(1);
    });

    // Android has no blur that is safe to mount: expo-blur's Dimezis integration redraws the whole
    // app into a software bitmap every frame and leaks those pre-draw hooks past unmount.
    it('paints a translucent tint without mounting any blur view on Android', async () => {
        platform.OS = 'android';

        const screen = await renderGlassSurface();

        expect(screen.findAllByType('BlurView')).toHaveLength(0);
        expect(screen.findAllByType('Content')).toHaveLength(1);
        expect(backgroundColorOf(screen.findHostByTestId('glass')?.props.style))
            .toBe(lightTheme.colors.glass.webBlurTint);
    });

    it('stays an opaque solid surface on Android when glass is disabled', async () => {
        platform.OS = 'android';

        const screen = await renderGlassSurface({ enabled: false });

        expect(screen.findAllByType('BlurView')).toHaveLength(0);
        expect(backgroundColorOf(screen.findHostByTestId('glass')?.props.style))
            .toBe(lightTheme.colors.surface.base);
    });
});
