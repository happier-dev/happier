import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ThemePreferenceTransitionHost } from './ThemePreferenceTransitionHost.native';
import { runThemePreferenceChange } from './themePreferenceTransition';

const screenshot = vi.hoisted(() => ({
    captureFile: vi.fn(async () => 'file://theme-before.png'),
    image: { dispose: vi.fn(), width: () => 80, height: () => 60 },
    drawOldTheme: vi.fn(),
    clipOldTheme: vi.fn(),
    drawGlyphs: vi.fn(),
}));

// Native screenshot and Skia worklet/pictures are platform boundaries; the real clip, frame and host run beneath them.
vi.mock('react-native-view-shot', () => ({ captureRef: screenshot.captureFile, releaseCapture: vi.fn() }));
vi.mock('@/components/atmosphere/glyph/glyphAtlas.native', async () => ({
    glyphAtlas: (await import('@/dev/testkit/mocks/reactNativeSkia')).createGlyphAtlasRasterMock,
}));
vi.mock('@shopify/react-native-skia', async () => {
    const boundary = (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaGlyphMock();
    const noOp = () => {};
    const methods = <T extends object>(surface: T) => new Proxy(surface, { get: (target, key) => Reflect.get(target, key) ?? noOp });
    return {
        ...boundary,
        ClipOp: { ...boundary.ClipOp, Difference: 'difference' },
        PaintStyle: { Fill: 'fill' },
        Skia: {
            ...boundary.Skia,
            Paint: () => methods(boundary.Skia.Paint()),
            Shader: { MakeTwoPointConicalGradient: () => ({ dispose: noOp }) },
        },
        useTypeface: () => ({}),
        makeImageFromView: async () => screenshot.image,
        createPicture: (draw: (canvas: object) => void) => {
            draw(methods({ drawImageRect: screenshot.drawOldTheme, clipPath: screenshot.clipOldTheme, drawAtlas: screenshot.drawGlyphs }));
            return { dispose: noOp };
        },
    };
});
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({ settleTimingCallbacks: true }));
afterEach(() => { vi.useRealTimers(); });

it('keeps the pre-auth wipe and composes the captured old appearance with the signed-in Horizon', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const credentials = { token: 'test-token', secret: 'test-secret' };
    const element = (signedIn: boolean) => <InjectedAuthProvider credentials={signedIn ? credentials : null}>
        <ThemePreferenceTransitionHost><>{'app-content'}</></ThemePreferenceTransitionHost>
    </InjectedAuthProvider>;
    const screen = await renderScreen(element(false), { createNodeMock: () => ({}) });
    await act(async () => screen.findAll(node => typeof node.props.onLayout === 'function')[0].props.onLayout({
        nativeEvent: { layout: { width: 240, height: 320 } },
    }));
    const change = () => runThemePreferenceChange({ currentPreference: 'light', nextPreference: 'dark',
        platform: 'ios', reduceMotion: false, systemTheme: 'light', mutation() {} });
    const pending = change();
    await flushHookEffects();
    expect(screenshot.captureFile).not.toHaveBeenCalled();
    expect(screen.findAll(node => node.props.image === screenshot.image).length).toBeGreaterThan(0);
    await act(async () => { vi.advanceTimersByTime(32); });
    await pending;
    expect(screenshot.image.dispose).toHaveBeenCalledTimes(1);

    await screen.update(element(true));
    const authenticated = change();
    await flushHookEffects();
    expect(screen.findAll(node => node.props.image === screenshot.image).length).toBeGreaterThan(0);
    await act(async () => { vi.advanceTimersByTime(32); await vi.dynamicImportSettled(); });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(screenshot.image.dispose).toHaveBeenCalledTimes(1);
    expect(screenshot.drawOldTheme.mock.calls.some(([image]) => image === screenshot.image)).toBe(true);
    expect(screenshot.clipOldTheme.mock.calls.some(([, operation]) => operation === 'difference')).toBe(true);
    expect(screenshot.drawGlyphs).toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1000); });
    await authenticated;
    expect(screenshot.image.dispose).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await screen.unmount();
});
