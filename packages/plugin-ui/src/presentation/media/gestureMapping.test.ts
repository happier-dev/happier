import { describe, expect, it } from 'vitest';
import { createLiveStreamGestureMapper } from './gestureMapping.js';

const geometry = { viewport: { width: 800, height: 400 }, content: { x: 0, y: 0, width: 800, height: 400 }, orientation: 'portrait' } as const;
const context = (mode: 'direct' | 'trackpad', pointer = true) => ({ ...geometry, mode, localZoom: true, supports: (kind: string) => pointer || kind !== 'pointer' });
const event = (phase: 'start' | 'move' | 'end' | 'cancel', x: number, y: number, at: number, touches?: readonly { x: number; y: number }[]) => ({ phase, point: { x, y }, at, touches });

describe('shared live stream gesture mapping', () => {
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
