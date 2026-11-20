// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { processColor } from 'react-native';
import { renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { darkTheme } from '@/theme';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import { ThemePreferenceTransitionHost } from './ThemePreferenceTransitionHost.web';
import { runThemePreferenceChange } from './themePreferenceTransition';
import { themeHorizonClipKeyframes, themeHorizonTransition } from './themeHorizonTransition.web';

// Status bar and system background are platform boundaries of the theme runtime the digits read their ink from.
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));
vi.mock('react-native', async () => {
    const kit = await import('@/dev/testkit/mocks/reactNative');
    const fixture = await kit.createReactNativeWebMock();
    const { View } = await import('react-native-web');
    return { ...fixture, View };
});

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const flush = async (update?: () => void) => await act(async () => { update?.(); await vi.dynamicImportSettled(); });

// Canvas rendering, font readiness, and Animation playback time are browser boundaries.
function browser() {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const fonts = deferred();
    const ready = deferred();
    const finished = deferred();
    const spriteColours: Uint8Array[] = [];
    const graphics = new Proxy({
        isContextLost: () => false, getExtension: () => null,
        getShaderParameter: () => true, getProgramParameter: () => true,
        bufferData(_target: number, data: ArrayBufferView) { if (data instanceof Uint8Array && data.length % 4 === 0) spriteColours.push(data.slice()); },
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => ({})) });
    const context = new Proxy({
        getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(4 * width * height) }),
        createRadialGradient: () => ({ addColorStop() {} }),
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((name: string) =>
        name === 'webgl2' ? graphics : context) as unknown as typeof HTMLCanvasElement.prototype.getContext);
    const reveal = { currentTime: 0 as number | null, cancel: vi.fn(() => { reveal.currentTime = null; }) };
    const animate = vi.fn(() => reveal);
    const transition = { ready: ready.promise, finished: finished.promise } as ViewTransition;
    Object.defineProperty(document.documentElement, 'animate', { configurable: true, value: animate });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load: () => fonts.promise } });
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: (mutation: () => void) => { mutation(); return transition; } });
    const overlay = () => document.querySelector('body > div[aria-hidden="true"]');
    const start = (direction: 'sunrise' | 'night' = 'sunrise') => flush(() => themeHorizonTransition.prepare(document, direction)!(transition));
    return { fonts, ready, finished, overlay, start, animate, reveal, spriteColours };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    Reflect.deleteProperty(document.documentElement, 'animate');
    Reflect.deleteProperty(document, 'fonts');
    Reflect.deleteProperty(document, 'startViewTransition');
});

describe('theme Horizon lifetime', () => {
    it('registers atmosphere choreography only while signed in', async () => {
        const host = browser();
        host.ready.resolve(); host.fonts.resolve();
        const mutate = () => runThemePreferenceChange({ platform: 'web', currentPreference: 'dark', nextPreference: 'light',
            systemTheme: 'light', reduceMotion: false, mutation: () => {}, webMutationCommit: mutation => mutation(), document });
        const surface = (credentials: React.ComponentProps<typeof InjectedAuthProvider>['credentials']) =>
            React.createElement(InjectedAuthProvider, { credentials, children:
                React.createElement(ThemePreferenceTransitionHost, { children: 'Content' }) });
        const screen = await renderScreen(surface(null));
        await act(mutate);
        expect(host.overlay()).toBeNull();
        await screen.update(surface({ token: 'test-token' }));
        await act(mutate);
        expect(host.overlay()).not.toBeNull();
        await flush(host.finished.resolve);
        await screen.update(surface(null));
        await act(mutate);
        expect(host.overlay()).toBeNull();
        await screen.unmount();
    });

    it('retires overlay and canvas backing stores when the transition ends before fonts resolve', async () => {
        const host = browser();
        await host.start();
        const canvases = [...host.overlay()!.querySelectorAll('canvas')];
        await flush(host.ready.resolve);
        await flush(host.finished.resolve);
        await flush(host.fonts.resolve);
        expect(host.overlay()).toBeNull();
        expect(host.reveal.currentTime).toBeNull();
        expect(canvases.length).toBeGreaterThan(0);
        expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not create a reveal after an already skipped transition', async () => {
        const host = browser();
        await host.start();
        await flush(host.finished.resolve);
        await flush(() => { host.ready.resolve(); host.fonts.resolve(); });
        expect(host.animate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('draws its digits on the root clip clock in the incoming theme ink', async () => {
        applyThemeRuntimeSelection({ themePreference: 'dark', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE, systemTheme: 'light',
            platform: 'ios', setSystemBackgroundColor: () => {}, recordBreadcrumb: () => {}, style: null });
        const host = browser();
        await host.start('night');
        await flush(() => { host.ready.resolve(); host.fonts.resolve(); });
        await flush(() => { host.reveal.currentTime = 600; vi.advanceTimersToNextFrame(); });
        const argb = processColor(darkTheme.colors.text.primary) as number;
        const ink = [(argb >>> 16) & 255, (argb >>> 8) & 255, argb & 255];
        expect(host.spriteColours.some(batch => batch.length > 4 && ink.every((value, index) => batch[index] === value))).toBe(true);
        expect(host.overlay()?.querySelector('[data-glyph-first-draw-ms]')).not.toBeNull();
        await flush(host.finished.resolve);
    });

    it('keeps the browser reveal usable when font preparation fails, then retires the overlay', async () => {
        const host = browser();
        await host.start();
        await flush(host.ready.resolve);
        await flush(() => host.fonts.reject(new Error('font unavailable')));
        expect(host.reveal.cancel).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await flush(host.finished.resolve);
        expect(host.overlay()).toBeNull();
    });
});

const circle = (clip: unknown) => {
    const match = /^circle\(([\d.]+)px at ([\d.-]+)px ([\d.-]+)px\)$/.exec(String(clip));
    if (!match) throw new Error(`not a circle: ${String(clip)}`);
    const [, r, x, y] = match.map(Number);
    return { r, x, y };
};
const corners = (w: number, h: number) => [[0, 0], [w, 0], [0, h], [w, h]] as const;

describe('themeHorizonClipKeyframes', () => {
    it.each(['sunrise', 'night'] as const)('reveals nothing on the first frame and the whole window on the last (%s)', (dir) => {
        const w = 1440, h = 900;
        const frames = themeHorizonClipKeyframes(w, h, dir);
        expect(frames[0].offset).toBe(0);
        expect(frames[frames.length - 1].offset).toBe(1);
        expect(frames).toHaveLength(73);
        const first = circle(frames[0].clipPath);
        const visible = (x: number, y: number) => Math.hypot(x - first.x, y - first.y) < first.r - 1;
        expect([[w / 2, h / 2], [w * 0.56, dir === 'sunrise' ? h - 4 : 4]].some(([x, y]) => visible(x, y))).toBe(false);
        const last = circle(frames[frames.length - 1].clipPath);
        for (const [x, y] of corners(w, h)) expect(Math.hypot(x - last.x, y - last.y)).toBeLessThan(last.r);
    });
});
