import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ThemePreferenceTransitionHost } from './ThemePreferenceTransitionHost.web';
import { runThemePreferenceChange } from './themePreferenceTransition';
import { themeHorizonClipKeyframes, themeHorizonTransition } from './themeHorizonTransition.web';
import { darkTheme } from '@/theme';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import { processColor } from 'react-native';

// Status bar and system background are platform boundaries of the theme runtime the digits read their ink from.
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

// Browser DOM, font readiness and animation scheduling are the external boundaries.
function browser(start = true) {
    const fonts = deferred();
    const ready = deferred();
    const finished = deferred();
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    const spriteColours: Uint8Array[] = [];
    const graphics = new Proxy({
        isContextLost: () => false, getExtension: () => null,
        getShaderParameter: () => true, getProgramParameter: () => true,
        bufferData(_target: number, data: ArrayBufferView) { if (data instanceof Uint8Array && data.length % 4 === 0) spriteColours.push(data.slice()); },
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => ({})) });
    const context = new Proxy({
        getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(4 * width * height) }),
        createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
    const overlay = { style: { setProperty: vi.fn() }, setAttribute: vi.fn(), appendChild: vi.fn(), remove: vi.fn() };
    const newCanvas = () => ({
        style: {}, width: 0, height: 0, isConnected: true,
        getContext: (name: string) => name === 'webgl2' ? graphics : context,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
    });
    const reveal = { currentTime: 0 as number | null, cancel: vi.fn(() => { reveal.currentTime = null; }) };
    const animate = vi.fn(() => reveal);
    const document = {
        defaultView: { innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
            requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
            cancelAnimationFrame: (frame: number) => frames.delete(frame) },
        body: { appendChild: vi.fn() }, head: { appendChild: vi.fn() }, getElementById: () => null,
        createElement: (name: string) => name === 'canvas' ? newCanvas() : name === 'div' ? overlay : {},
        documentElement: { animate }, fonts: { load: () => fonts.promise },
        startViewTransition: (mutation: () => void) => { mutation(); return { ready: ready.promise, finished: finished.promise }; },
    };
    vi.stubGlobal('document', document);
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    if (start) {
        const play = themeHorizonTransition.prepare(document as unknown as Document, 'sunrise')!;
        play({ ready: ready.promise, finished: finished.promise } as ViewTransition);
    }
    return { document, fonts, ready, finished, frames, overlay, animate, reveal, spriteColours };
}

afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('theme Horizon lifetime', () => {
    it('registers atmosphere choreography only while signed in', async () => {
        const host = browser(false);
        host.ready.resolve(); host.fonts.resolve();
        const mutate = () => runThemePreferenceChange({ platform: 'web', currentPreference: 'dark', nextPreference: 'light',
            systemTheme: 'light', reduceMotion: false, mutation: () => {}, webMutationCommit: mutation => mutation(),
            document: host.document as unknown as Document });
        const surface = (credentials: React.ComponentProps<typeof InjectedAuthProvider>['credentials']) =>
            React.createElement(InjectedAuthProvider, { credentials, children:
                React.createElement(ThemePreferenceTransitionHost, { children: 'Content' }) });
        const screen = await renderScreen(surface(null));
        await mutate();
        expect(host.document.body.appendChild).toHaveBeenCalledTimes(0);
        await screen.update(surface({ token: 'test-token' }));
        await mutate();
        expect(host.document.body.appendChild).toHaveBeenCalledTimes(1);
        host.finished.resolve(); await flush();
        await screen.update(surface(null));
        await mutate();
        expect(host.document.body.appendChild).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });
    it('does not restart painting when fonts become ready after the transition finishes', async () => {
        const host = browser();
        host.ready.resolve(); await flush();
        host.finished.resolve(); await flush();
        host.fonts.resolve(); await flush();
        expect(host.overlay.remove).toHaveBeenCalled();
        expect(host.reveal.currentTime).toBeNull();
        expect(host.frames.size).toBe(0);
    });

    it('does not create a reveal after an already skipped transition', async () => {
        const host = browser();
        host.finished.resolve(); await flush();
        host.ready.resolve(); host.fonts.resolve(); await flush();
        expect(host.animate).not.toHaveBeenCalled();
        expect(host.frames.size).toBe(0);
    });

    it('draws the digits in the ink of the theme it reveals', async () => {
        // The switch to dark has applied by the time the reveal is ready.
        applyThemeRuntimeSelection({ themePreference: 'dark', themeProfiles: DEFAULT_THEME_PROFILES_LOCAL_STATE, systemTheme: 'light',
            platform: 'ios', setSystemBackgroundColor: () => {}, recordBreadcrumb: () => {}, style: null });
        const host = browser(false);
        const play = themeHorizonTransition.prepare(host.document as unknown as Document, 'night')!;
        play({ ready: host.ready.promise, finished: host.finished.promise } as ViewTransition);
        host.ready.resolve(); host.fonts.resolve(); await flush();
        host.reveal.currentTime = 600;
        for (const frame of [...host.frames.values()]) frame(0);
        const argb = processColor(darkTheme.colors.text.primary) as number;
        const ink = [(argb >>> 16) & 255, (argb >>> 8) & 255, argb & 255];
        expect(host.spriteColours.some(batch => batch.length > 4 && ink.every((value, index) => batch[index] === value))).toBe(true);
        host.finished.resolve(); await flush();
    });

    it('cleans up a rejected font load without scheduling paint', async () => {
        const host = browser();
        host.ready.resolve(); await flush();
        host.fonts.reject(new Error('font unavailable')); await flush();
        expect(host.overlay.remove).toHaveBeenCalled();
        expect(host.frames.size).toBe(0);
        host.finished.resolve();
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
