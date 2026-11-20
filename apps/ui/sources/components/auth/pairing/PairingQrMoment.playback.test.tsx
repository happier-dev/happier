import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PairingQrMomentCanvas as WebCanvas } from './PairingQrMoment.web';
import { PairingQrMomentCanvas as NativeCanvas } from './PairingQrMoment.native';
import type { PairingQrMomentCanvasProps } from './pairingQrMoment.types';
import type { QrMomentScene } from './pairingQrMomentTimeline';

const host = vi.hoisted(() => ({ emitter: null as ReturnType<typeof import('@/dev/testkit/mocks/reactNative').createReactNativeAppStateEmitter> | null }));
vi.mock('react-native', async () => {
    const kit = await import('@/dev/testkit/mocks/reactNative');
    host.emitter = kit.createReactNativeAppStateEmitter();
    return kit.createReactNativeWebMock({ AppState: host.emitter.appState });
});
// The native worker and Skia raster resources are system boundaries.
vi.mock('@/components/atmosphere/glyph/glyphAtlas.native', async () => ({
    glyphAtlas: (await import('@/dev/testkit/mocks/reactNativeSkia')).createGlyphAtlasRasterMock,
}));
vi.mock('@shopify/react-native-skia', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaGlyphMock(),
    createPicture: () => ({ dispose() {} }),
    useTypeface: () => ({}),
}));

beforeEach(() => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }));
afterEach(async () => {
    await act(async () => { host.emitter?.emit('active'); });
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const flush = async () => await act(async () => { await vi.dynamicImportSettled(); });

function canvasBoundary(webgl: boolean, rejectFonts = false) {
    const canvases: Array<{ dataset: Record<string, string>; style: Record<string, string>; width: number; height: number }> = [];
    const spriteDraws = vi.fn();
    const qrDraws = vi.fn();
    const graphics = new Proxy({
        isContextLost: () => false, getExtension: () => null,
        getShaderParameter: () => true, getProgramParameter: () => true,
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => ({})) });
    const newCanvas = (mounted = false) => {
        const image = (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) });
        const context = new Proxy({
            getImageData: (_x: number, _y: number, width: number, height: number) => image(width, height),
            createImageData: image,
            createLinearGradient: () => ({ addColorStop() {} }),
            roundRect: (_x: number, _y: number, width: number, height: number) => {
                if (mounted && width < 20 && height < 20) qrDraws();
            },
            drawImage: () => { if (mounted) spriteDraws(); },
            putImageData: () => { if (mounted) spriteDraws(); },
        }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
        const canvas = { dataset: {}, style: {}, width: 0, height: 0, isConnected: true,
            ownerDocument: document,
            getContext: (kind: string) => kind === '2d' ? context : webgl ? graphics : null,
            addEventListener() {}, removeEventListener() {} };
        if (mounted) canvases.push(canvas);
        return canvas;
    };
    vi.stubGlobal('document', { documentElement: {}, visibilityState: 'visible',
        fonts: { load: async () => { if (rejectFonts) throw new Error('font unavailable'); return []; } },
        createElement: () => newCanvas(), addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    return { canvases, spriteDraws, qrDraws,
        createNodeMock: (node: Readonly<{ type: unknown }>) => node.type === 'canvas' ? newCanvas(true) : null };
}

it('paints the pairing planet Still in its square when the browser refuses WebGL', async () => {
    const browser = canvasBoundary(false);
    const screen = await renderScreen(<WebCanvas size={240} theme="light" reducedMotion={false} pairing machines={[]}
        scene={{ kind: 'pairing', device: 'Studio', scan: null, joinedAtMs: performance.now() }} />, browser);
    await flush();
    expect(browser.canvases.some(canvas => canvas.dataset.glyphRenderer === 'unavailable' && 'glyphFirstDrawMs' in canvas.dataset)).toBe(true);
    expect(browser.canvases.some(canvas => canvas.style.visibility === 'visible' && canvas.width === 240 && canvas.height === 240)).toBe(true);
    expect(browser.spriteDraws).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await screen.unmount();
    expect(browser.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});

it('keeps the settled QR scannable if glyph preparation fails on a browser that refuses WebGL', async () => {
    const browser = canvasBoundary(false, true);
    const screen = await renderScreen(<WebCanvas size={240} theme="light" reducedMotion={false} pairing machines={[]}
        scene={{ kind: 'assemble', link: 'happier://pair/example', atMs: performance.now() }} />, browser);
    await flush();
    expect(browser.qrDraws).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await screen.unmount();
});

describe.each([['web', WebCanvas], ['native', NativeCanvas]] as const)('%s pairing moment lifetime', (_platform, Canvas) => {
    it('does not schedule display frames in a retained inactive pane', async () => {
        const browser = canvasBoundary(true);
        const element = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}>
            <Canvas size={240} theme="light" reducedMotion={false} pairing machines={[]}
                scene={{ kind: 'assemble', link: 'happier://pair/example', atMs: 0 }} />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(element(false), browser);
        await flush();
        expect(vi.getTimerCount()).toBe(0);
        await screen.update(element(true));
        expect(vi.getTimerCount()).toBe(1);
        await screen.update(element(false));
        expect(vi.getTimerCount()).toBe(0);
        await screen.unmount();
    });

    it('cancels display frames while hidden, then renders the current lifecycle and settles', async () => {
        const browser = canvasBoundary(true);
        const props = { size: 240, theme: 'light', reducedMotion: false, pairing: true, machines: [],
            scene: { kind: 'assemble', link: 'happier://pair/example', atMs: 0 },
        } satisfies PairingQrMomentCanvasProps & { scene: QrMomentScene };
        const screen = await renderScreen(<Canvas {...props} />, browser);
        await flush();
        expect(vi.getTimerCount()).toBe(1);
        await act(async () => { vi.advanceTimersByTime(96); host.emitter!.emit('background'); });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { vi.advanceTimersByTime(60_000); });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { host.emitter!.emit('active'); });
        // Pairing follows real code and scan times, so an old code is already held on resume.
        expect(vi.getTimerCount()).toBe(0);
        await screen.update(<Canvas {...props} scene={{ kind: 'assemble', link: 'happier://pair/next', atMs: performance.now() }} />);
        expect(vi.getTimerCount()).toBe(1);
        await screen.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});
