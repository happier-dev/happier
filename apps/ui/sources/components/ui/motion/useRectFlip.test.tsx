import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import * as flight from './rectFlight';
import { interpolateRectFlip } from './rectFlipGeometry';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const animations = vi.hoisted(() => ({ callbacks: [] as Array<(finished?: boolean) => void> }));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const animate = (value: number, _config: unknown, callback?: (finished?: boolean) => void) => {
        if (callback) animations.callbacks.push(callback);
        return value;
    };
    return { ...createReanimatedModuleMock(), withTiming: animate, withSpring: animate };
});

describe('rectangle FLIP', () => {
    it.each([undefined, 900])('settles an interrupted close once (velocity %s), including after a second open', async (velocityY) => {
        let current: ReturnType<typeof flight.useRectFlip> | undefined;
        function Harness() { current = flight.useRectFlip({ reducedMotion: false }); return null; }
        const screen = await renderScreen(<Harness />);
        const target = { x: 100, y: 100, width: 400, height: 200 };
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                const complete = vi.fn();
                await act(async () => current!.openFrom(null, target));
                current!.progress.value = 0.6678215536361898;
                await act(async () => current!.closeTo(null, { velocityY, onComplete: complete }));
                const callback = animations.callbacks.at(-1)!;
                expect(complete).not.toHaveBeenCalled();
                await act(async () => callback(false));
                expect(complete).toHaveBeenCalledTimes(1);
                await act(async () => callback(true));
                expect(complete).toHaveBeenCalledTimes(1);
            }
        } finally { await screen.unmount(); }
    });

    it('recovers the uncropped image rect from a centre-cover thumbnail', () => {
        expect(flight.coverRectFlipOrigin({ x: 10, y: 20, width: 100, height: 100 }, { width: 400, height: 200 }))
            .toEqual({ imageRect: { x: -40, y: 20, width: 200, height: 100 }, clipRect: { x: 10, y: 20, width: 100, height: 100 } });
    });

    it('interpolates both image axes and its visible crop', () => {
        const frame = interpolateRectFlip(
            { imageRect: { x: 10, y: 20, width: 100, height: 200 }, clipRect: { x: 10, y: 70, width: 100, height: 100 } },
            { imageRect: { x: 100, y: 100, width: 400, height: 400 }, clipRect: { x: 100, y: 100, width: 400, height: 400 } },
            0.5,
        );
        expect(frame.imageRect).toEqual({ x: 55, y: 60, width: 250, height: 300 });
        expect(frame.clipRect).toEqual({ x: 55, y: 85, width: 250, height: 250 });
    });

    it('retargets a close from the visible opening rect and keeps backdrop progress continuous', async () => {
        let current: ReturnType<typeof flight.useRectFlip> | undefined;
        function Harness() {
            current = flight.useRectFlip({ reducedMotion: false });
            return null;
        }
        await renderScreen(<Harness />);
        const origin = { x: 10, y: 20, width: 100, height: 100 };
        const target = { x: 100, y: 100, width: 400, height: 200 };
        await act(async () => current!.openFrom(origin, target));
        // Simulate the compositor midway through the shared opening clock.
        current!.progress.value = 0.5;
        await act(async () => current!.closeTo({ ...origin, x: 30 }));
        expect(current!.from.value.imageRect).toEqual({ x: 55, y: 60, width: 250, height: 150 });
        expect(current!.to.value.imageRect).toEqual({ ...origin, x: 30 });
        expect(current!.backdropFrom.value).toBe(0.5);
        await act(async () => current!.openFrom(flight.coverRectFlipOrigin(origin, { width: 400, height: 200 }), target));
        current!.progress.value = 0.5;
        await act(async () => current!.closeTo(null));
        expect(current!.to.value.clipRect.width).toBe(current!.from.value.clipRect.width * 0.96);
    });

    it('uses a crossfade with identity geometry under reduced motion', async () => {
        let current: ReturnType<typeof flight.useRectFlip> | undefined;
        function Harness() {
            current = flight.useRectFlip({ reducedMotion: true });
            return null;
        }
        await renderScreen(<Harness />);
        const target = { x: 100, y: 100, width: 400, height: 200 };
        await act(async () => current!.openFrom({ x: 0, y: 0, width: 20, height: 20 }, target));
        expect(current!.from.value.imageRect).toEqual(target);
        expect(current!.to.value.imageRect).toEqual(target);
    });
});
