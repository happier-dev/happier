import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createAtmosphereTransition, type AtmospherePixels } from '@happier-dev/brand/atmosphere';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { BackdropCanvas as WebCanvas } from './BackdropCanvas.web';
import { BackdropCanvas as NativeCanvas } from './BackdropCanvas.native';
import { atmosphereResettleFact } from './atmosphereStage';
import type { BackdropCanvasProps, BackdropRenderRequest, BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';
import type { PictureRecord } from './pictureStore.types';

const native = vi.hoisted(() => ({ painted: [] as number[], requests: [] as BackdropRenderRequest[] }));
const host = vi.hoisted(() => ({ emitter: null as ReturnType<typeof import('@/dev/testkit/mocks/reactNative').createReactNativeAppStateEmitter> | null }));
vi.mock('react-native', async () => {
    const kit = await import('@/dev/testkit/mocks/reactNative');
    host.emitter = kit.createReactNativeAppStateEmitter();
    return kit.createReactNativeWebMock({ AppState: host.emitter.appState });
});
// The off-thread native renderer owns Skia/file handles. This boundary preserves the real Brand
// transition math while replacing native handle allocation and filesystem output in Node.
vi.mock('./renderBackdrop.native', () => ({
    acquireNativeBackdrop: (request: BackdropRenderRequest) => {
        native.requests.push(request);
        return { promise: Promise.resolve('localId' in request.source ? request.source.localId : 'pixels'), release() {} };
    },
    createNativeBackdropTransition: async () => {
        const frames = createAtmosphereTransition('resettle', { from: pixels(10), to: pixels(210), page: [245, 245, 245], theme: 'light', dpr: 1 });
        return {
            frame: async (t: number) => { frames.frame(t); native.painted.push(t); return { dispose() {} }; },
            dispose: async () => {},
        };
    },
}));

function pixels(value: number): AtmospherePixels { return { rgba: new Uint8ClampedArray(8 * 4 * 4).fill(value), w: 8, h: 4 }; }
const record = (localId: string): PictureRecord => ({ localId, kind: 'builtin', data: 'cached', size: 1, createdAtMs: 1 });
async function frames(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 16) await act(async () => { vi.advanceTimersByTime(16); });
}

describe.each([['web', WebCanvas], ['native', NativeCanvas]] as const)('%s resettle playback', (_platform, Canvas) => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
        setReducedMotionPreferenceOverride(false);
        native.painted.length = 0;
        native.requests.length = 0;
        vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
        vi.stubGlobal('Worker', class {
            onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
            postMessage(message: BackdropWorkerRequest) {
                if (!('request' in message)) return;
                const value = 'localId' in message.request.source && message.request.source.localId === 'next' ? 210 : 10;
                queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, result: pixels(value) } }));
            }
            terminate() {}
        });
    });
    afterEach(async () => {
        await act(async () => { host.emitter?.emit('active'); setReducedMotionPreferenceOverride(null); });
        atmosphereResettleFact.clear(); vi.useRealTimers(); vi.unstubAllGlobals();
    });

    async function start(staticPaint = false) {
        const painted: Uint8ClampedArray[] = [];
        const props = { source: record('old'), size: { width: 8, height: 4 }, look: 'original', page: [245, 245, 245], theme: 'light', dpr: 1 } satisfies BackdropCanvasProps;
        const screen = await renderScreen(<Canvas {...props} {...(staticPaint ? { resettle: false } : {})} />, { createNodeMock: element => element.type === 'canvas' ? {
            getContext: () => ({ putImageData: (image: ImageData) => painted.push(image.data), getImageData: () => ({ data: pixels(10).rgba }) }),
        } : null });
        atmosphereResettleFact.announce('next', false);
        const next = { ...props, source: record('next'), ...(staticPaint ? { resettle: false } : {}) };
        await screen.update(<Canvas {...next} />);
        await frames(96);
        return { screen, next, paints: () => _platform === 'web' ? painted.length : native.painted.length,
            last: () => _platform === 'web' ? painted.at(-1) : native.painted.at(-1) };
    }

    if (_platform === 'native') it('settles native size and crop span as one render input', async () => {
        const source = record('native-span');
        const picture = (width: number) => <Canvas source={source} size={{ width, height: 4 }}
            span={{ x: 3, y: 0, W: width * 2, H: 4 }} horizon={{ src: 0.55, at: width / 20 }}
            look="original" page={[245, 245, 245]} theme="light" dpr={1} />;
        const screen = await renderScreen(picture(8));
        native.requests.length = 0;
        await screen.update(picture(10));
        expect(native.requests).toHaveLength(0);
        await act(async () => { vi.advanceTimersByTime(120); });
        expect(native.requests).toHaveLength(1);
        expect(native.requests[0]).toMatchObject({ width: 10, horizon: { src: 0.55, at: 0.5 }, job: { span: { x: 3, W: 20 } } });
        await screen.unmount();
    });

    it('paints a private static preview immediately without consuming a Home idle resettle', async () => {
        const canvas = await start(true);
        if (_platform === 'web') expect(canvas.last()).toEqual(pixels(210).rgba);
        else {
            expect(native.painted).toEqual([]);
            expect(canvas.screen.findAll(node => node.props.source?.uri === 'next').length).toBeGreaterThan(0);
        }
    });

    it('holds the current frame after typing or Home focus pauses an admitted resettle, then resumes its elapsed clock', async () => {
        const canvas = await start();
        expect(canvas.paints()).toBeGreaterThan(1);
        await canvas.screen.update(<Canvas {...canvas.next} resettlePaused />);
        const held = canvas.last();
        const count = canvas.paints();
        await frames(2400);
        expect(canvas.paints()).toBe(count);
        expect(canvas.last()).toEqual(held);
        await canvas.screen.update(<Canvas {...canvas.next} resettlePaused={false} />);
        await frames(96);
        expect(canvas.paints()).toBeGreaterThan(count);
        // Hidden time must not finish the transition on its first resumed frame.
        expect(canvas.last()).not.toEqual(_platform === 'web' ? pixels(210).rgba : 1);
        await frames(1800);
        expect(canvas.last()).toEqual(_platform === 'web' ? pixels(210).rgba : 1);
    });

    it('settles an in-flight resettle when reduced motion is newly selected, including while paused', async () => {
        const canvas = await start();
        await canvas.screen.update(<Canvas {...canvas.next} resettlePaused />);
        await act(async () => { setReducedMotionPreferenceOverride(true); });
        // Web paints the exact target; native swaps to the target image and removes the animated layer.
        if (_platform === 'web') expect(canvas.last()).toEqual(pixels(210).rgba);
        else {
            expect(canvas.screen.findAllByType('SkiaImage')).toHaveLength(0);
            expect(canvas.screen.findAll(node => node.props.source?.uri === 'next').length).toBeGreaterThan(0);
        }
        const count = canvas.paints();
        await frames(2400);
        expect(canvas.paints()).toBe(count);
    });

    it('holds an admitted transition while the host is hidden and resumes without counting hidden time', async () => {
        const canvas = await start();
        await act(async () => { host.emitter!.emit('background'); });
        const count = canvas.paints();
        const held = canvas.last();
        await frames(2400);
        expect(canvas.paints()).toBe(count);
        expect(canvas.last()).toEqual(held);
        await act(async () => { host.emitter!.emit('active'); });
        await frames(96);
        expect(canvas.paints()).toBeGreaterThan(count);
        expect(canvas.last()).not.toEqual(_platform === 'web' ? pixels(210).rgba : 1);
        await frames(1800);
        expect(canvas.last()).toEqual(_platform === 'web' ? pixels(210).rgba : 1);
    });
});
