import { describe, expect, it } from 'vitest';
import { createLiveStreamGestureMapper, fillViewTransform } from './gestureMapping.js';
import { HAPPIER_GESTURE_TIMING } from './inputGesture.js';

const geometry = { viewport: { width: 800, height: 400 }, content: { x: 0, y: 0, width: 800, height: 400 }, orientation: 'portrait' } as const;
const context = (mode: 'direct' | 'trackpad', pointer = true) => ({ ...geometry, mode, localZoom: true, supports: (kind: string) => pointer || kind !== 'pointer' });
const event = (phase: 'start' | 'move' | 'end' | 'cancel', x: number, y: number, at: number, touches?: readonly { x: number; y: number }[]) => ({ phase, point: { x, y }, at, touches });

describe('shared live stream gesture mapping', () => {
    it('serializes sub-millisecond motion positively without rounding a short hold into a drag', () => {
        const direct = createLiveStreamGestureMapper();
        direct.map(event('start', 80, 40, 0.125), context('direct'));
        direct.map(event('move', 140, 90, 0.25), context('direct'));
        expect(direct.map(event('end', 140, 90, 0.375), context('direct')).actions)
            .toMatchObject([{ kind: 'swipe', durationMs: 1 }]);
        const trackpad = createLiveStreamGestureMapper();
        trackpad.map(event('start', 80, 40, 0), context('trackpad', false));
        trackpad.map(event('move', 140, 90, HAPPIER_GESTURE_TIMING.longPressMs - 0.125), context('trackpad', false));
        expect(trackpad.map(event('end', 140, 90, HAPPIER_GESTURE_TIMING.longPressMs + 50), context('trackpad', false)).actions).toEqual([]);
    });
    it.each(['direct', 'trackpad'] as const)('%s maps taps at the finger or retained pointer respectively', mode => {
        const mapper = createLiveStreamGestureMapper();
        mapper.map(event('start', 80, 40, 0), context(mode));
        expect(mapper.map(event('end', 80, 40, 50), context(mode)).actions).toMatchObject([
            { kind: 'tap', point: mode === 'direct' ? { x: 0.1, y: 0.1 } : { x: 0.5, y: 0.5 } },
        ]);
    });

    it('keeps direct swipes while trackpad movement accelerates from precise to fast strokes', () => {
        const direct = createLiveStreamGestureMapper();
        direct.map(event('start', 80, 40, 0), context('direct'));
        direct.map(event('move', 160, 80, 100), context('direct'));
        expect(direct.map(event('end', 160, 80, 110), context('direct')).actions).toMatchObject([{ kind: 'swipe', from: { x: 0.1, y: 0.1 }, to: { x: 0.2, y: 0.2 } }]);
        const stroke = (elapsed: number) => {
            const mapper = createLiveStreamGestureMapper();
            mapper.map(event('start', 0, 0, 0), context('trackpad'));
            return mapper.map(event('move', 30, 0, elapsed), context('trackpad'));
        };
        const slow = stroke(300);
        const fast = stroke(10);
        expect(slow.actions).toMatchObject([{ kind: 'move' }]);
        expect(fast.pointer.x - 0.5).toBeGreaterThan(slow.pointer.x - 0.5);
    });

    it('holds the browser button during a long-press drag and releases on cancellation', () => {
        const mapper = createLiveStreamGestureMapper();
        mapper.map(event('start', 10, 10, 0), context('trackpad'));
        const jitter = mapper.map(event('move', 11, 10, 100), context('trackpad'));
        expect(mapper.map(event('move', 40, 10, 550), context('trackpad')).actions).toMatchObject([
            { kind: 'pointer', phase: 'down', point: jitter.pointer }, { kind: 'pointer', phase: 'move' },
        ]);
        expect(mapper.map(event('cancel', 40, 10, 600), context('trackpad')).actions).toMatchObject([{ kind: 'pointer', phase: 'cancel' }]);
    });

    it('previews native drag motion and commits the approved atomic drag only on release', () => {
        const mapper = createLiveStreamGestureMapper();
        mapper.map(event('start', 10, 10, 0), context('trackpad', false));
        const preview = mapper.map(event('move', 40, 10, 550), context('trackpad', false));
        expect(preview.actions).toEqual([]);
        expect(preview.trail).toHaveLength(2);
        expect(mapper.map(event('end', 40, 10, 600), context('trackpad', false)).actions).toMatchObject([{kind: 'drag', from: {x: 0.5, y: 0.5}, to: preview.trail[1]}]);
    });

    it('maps a two-finger tap to right click and two-finger translation to wheel without moving the pointer', () => {
        const mapper = createLiveStreamGestureMapper();
        const touches = [{ x: 50, y: 50 }, { x: 90, y: 50 }];
        mapper.map(event('start', 50, 50, 0, touches), context('trackpad'));
        expect(mapper.map(event('end', 50, 50, 30), context('trackpad')).actions).toMatchObject([{ kind: 'tap', button: 'right', point: { x: 0.5, y: 0.5 } }]);
        mapper.map(event('start', 50, 50, 100, touches), context('trackpad'));
        const scroll = mapper.map(event('move', 50, 80, 150, [{ x: 50, y: 80 }, { x: 90, y: 80 }]), context('trackpad'));
        expect(scroll.actions).toMatchObject([{ kind: 'wheel', deltaX: 0, deltaY: -30 }]);
        expect(scroll.pointer).toEqual({ x: 0.5, y: 0.5 });
        expect(mapper.map(event('end', 50, 80, 160), context('trackpad')).actions).toEqual([]);
    });

    it.each(['direct', 'trackpad'] as const)('%s pinch changes only the local viewport, and direct simulator pinch stays remote', mode => {
        const mapper = createLiveStreamGestureMapper();
        const start = event('start', 300, 200, 0, [{ x: 300, y: 200 }, { x: 500, y: 200 }]);
        const move = event('move', 200, 200, 50, [{ x: 200, y: 200 }, { x: 600, y: 200 }]);
        mapper.map(start, context(mode));
        const zoom = mapper.map(move, context(mode));
        expect(zoom.actions).toEqual([]);
        expect(zoom.transform.scale).toBe(2);
        expect(mapper.map(event('end', 200, 200, 60), context(mode)).actions).toEqual([]);
        mapper.resetZoom();
        mapper.map(event('start', 80, 40, 100), context('direct'));
        expect(mapper.map(event('end', 80, 40, 110), context('direct')).actions).toMatchObject([{kind: 'tap', point: {x: 0.1, y: 0.1}}]);
        const simulator = createLiveStreamGestureMapper();
        simulator.map(start, { ...context('direct'), localZoom: false });
        simulator.map(move, { ...context('direct'), localZoom: false });
        expect(simulator.map(event('end', 200, 200, 60), { ...context('direct'), localZoom: false }).actions).toMatchObject([{ kind: 'pinch' }]);
    });

    describe('a passive phone viewer filling its pane', () => {
        // A desktop-shaped page drawn whole (contain, from the top) in a phone pane: 375 × 234 of 375 × 700.
        const viewport = { width: 375, height: 700 };
        const content = { x: 0, y: 0, width: 375, height: 234 };
        // The page's own size: drawn at 375 wide it is well below it, so the fill never passes it.
        const page = { width: 1280, height: 800 };
        const fill = { viewport, content, orientation: 'portrait', mode: 'direct', localZoom: true, dragPans: true,
            supports: () => true } as const;
        const remote = (point: { x: number; y: number }) => ({
            x: (point.x * viewport.width - content.x) / content.width,
            y: (point.y * viewport.height - content.y) / content.height,
        });
        const tapAt = (mapper: ReturnType<typeof createLiveStreamGestureMapper>, x: number, y: number, at: number) => {
            mapper.map(event('start', x, y, at), fill);
            const [tap] = mapper.map(event('end', x, y, at + 30), fill).actions;
            if (tap?.kind !== 'tap') throw new Error('expected a tap');
            return remote(tap.point);
        };

        it('rests filling the pane height from the top-left corner', () => {
            expect(fillViewTransform(viewport, content, page)).toEqual({ scale: 700 / 234, x: 0, y: 0 });
            // A page already filling its pane (the controller sized it) has nothing to fill.
            expect(fillViewTransform(viewport, { x: 0, y: 0, width: 375, height: 700 }, page)).toEqual({ scale: 1, x: 0, y: 0 });
        });

        it('anchors a letterboxed picture at the pane\'s top-left corner', () => {
            const letterboxed = { x: 50, y: 200, width: 275, height: 300 };
            const view = fillViewTransform(viewport, letterboxed, { width: 1100, height: 1200 });
            expect(view.scale).toBeCloseTo(700 / 300);
            expect(letterboxed.x * view.scale + view.x).toBeCloseTo(0);
            expect(letterboxed.y * view.scale + view.y).toBeCloseTo(0);
        });

        it('never draws a small picture past its own size: it stays whole instead of filling', () => {
            // A 636x136 window shown at its own size (one picture pixel per point) on a phone pane.
            const small = { x: 28.5, y: 282, width: 318, height: 68 };
            expect(fillViewTransform(viewport, small, { width: 318, height: 68 })).toEqual({ scale: 1, x: 0, y: 0 });
            // Drawn at half its size, the cover fill (about 10x) would still pass its own size: whole picture.
            expect(fillViewTransform(viewport, small, { width: 636, height: 136 })).toEqual({ scale: 1, x: 0, y: 0 });
        });

        it('maps taps to the same remote point at fill, panned, and with the whole page shown', () => {
            const scale = 700 / 234;
            const mapper = createLiveStreamGestureMapper();
            expect(mapper.setRestTransform(fillViewTransform(viewport, content, page)).transform).toEqual({ scale, x: 0, y: 0 });
            const atFill = tapAt(mapper, 187.5, 350, 0);
            expect(atFill.x).toBeCloseTo(187.5 / scale / 375);
            expect(atFill.y).toBeCloseTo(0.5);

            // A one-finger drag pans the picture locally and sends nothing to the page.
            mapper.map(event('start', 300, 350, 100), fill);
            mapper.map(event('move', 200, 350, 150), fill);
            const panned = mapper.map(event('end', 200, 350, 160), fill);
            expect(panned.actions).toEqual([]);
            expect(panned.transform).toEqual({ scale, x: -100, y: 0 });
            const afterPan = tapAt(mapper, 187.5, 350, 200);
            expect(afterPan.x).toBeCloseTo((187.5 + 100) / scale / 375);
            expect(afterPan.y).toBeCloseTo(0.5);

            // Pinching out shows the whole page; a tap then lands where it is drawn.
            mapper.map(event('start', 100, 350, 300, [{ x: 100, y: 350 }, { x: 300, y: 350 }]), fill);
            const whole = mapper.map(event('move', 200, 350, 350, [{ x: 190, y: 350 }, { x: 210, y: 350 }]), fill);
            mapper.map(event('end', 200, 350, 360), fill);
            expect(whole.transform).toEqual({ scale: 1, x: 0, y: 0 });
            const wholePage = tapAt(mapper, 187.5, 117, 400);
            expect(wholePage.x).toBeCloseTo(0.5);
            expect(wholePage.y).toBeCloseTo(0.5);

            // Reset returns to the fill, not to the letterboxed whole page.
            expect(mapper.resetZoom().transform).toEqual({ scale, x: 0, y: 0 });
        });

        it('never pans past the page into the empty pane below it', () => {
            const mapper = createLiveStreamGestureMapper();
            mapper.setRestTransform(fillViewTransform(viewport, content, page));
            mapper.map(event('start', 200, 600, 0), fill);
            mapper.map(event('move', 200, 100, 50), fill);
            expect(mapper.map(event('end', 200, 100, 60), fill).transform.y).toBe(0);
        });

        it('follows a new resting fill only while the viewer has not moved the picture', () => {
            const mapper = createLiveStreamGestureMapper();
            mapper.setRestTransform(fillViewTransform(viewport, content, page));
            const taller = { ...fill, content: { x: 0, y: 0, width: 375, height: 350 } };
            expect(mapper.setRestTransform(fillViewTransform(viewport, taller.content, page)).transform).toEqual({ scale: 2, x: 0, y: 0 });
            mapper.map(event('start', 300, 350, 0), taller);
            mapper.map(event('move', 250, 350, 50), taller);
            const moved = mapper.map(event('end', 250, 350, 60), taller).transform;
            expect(mapper.setRestTransform(fillViewTransform(viewport, content, page)).transform).toEqual(moved);
        });
    });

    it('pans zoomed content at the trackpad cursor edge and clamps the remote point to the picture', () => {
        const mapper = createLiveStreamGestureMapper();
        mapper.map(event('start', 300, 200, 0, [{ x: 300, y: 200 }, { x: 500, y: 200 }]), context('trackpad'));
        mapper.map(event('move', 200, 200, 50, [{ x: 200, y: 200 }, { x: 600, y: 200 }]), context('trackpad'));
        mapper.map(event('end', 200, 200, 60), context('trackpad'));
        mapper.map(event('start', 10, 10, 100), context('trackpad'));
        const moved = mapper.map(event('move', 700, 10, 110), context('trackpad'));
        expect(moved.transform.x).toBeLessThan(0);
        expect(moved.pointer.x).toBeLessThanOrEqual(1);
    });
});
