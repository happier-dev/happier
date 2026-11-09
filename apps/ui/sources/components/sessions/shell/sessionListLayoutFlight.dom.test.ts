// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    SESSION_LIST_FLIGHT_ATTRIBUTE,
    captureSessionListLayoutFlight,
    captureSessionListPlacementFlight,
    playSessionListLayoutFlight,
} from './sessionListLayoutFlight';

// The browser's layout engine is the boundary: jsdom computes no boxes and runs no animations.
const boxes = new Map<Element, { x: number; y: number; width: number; height: number }>();
function place(element: Element, y: number): void {
    boxes.set(element, { x: 0, y, width: 260, height: 32 });
}
const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ id: '', cancel() {} }) as unknown as Animation);

function row(key: string): HTMLElement {
    const element = document.createElement('div');
    element.setAttribute(SESSION_LIST_FLIGHT_ATTRIBUTE, key);
    element.getBoundingClientRect = () => {
        const box = boxes.get(element) ?? { x: 0, y: 0, width: 0, height: 0 };
        return { ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON() {} } as DOMRect;
    };
    (element as unknown as { animate: typeof animate }).animate = animate;
    (element as unknown as { getAnimations: () => Animation[] }).getAnimations = () => [];
    return element;
}

afterEach(() => {
    document.body.innerHTML = '';
    boxes.clear();
    animate.mockClear();
});

describe('Projects ↔ Recent glide (P5 §6 FLIP)', () => {
    it('glides a row that kept its key from where it was, fades in what is new, and plays once', () => {
        const kept = row('session:a');
        const leaving = row('header:project:x');
        document.body.append(kept, leaving);
        place(kept, 200);
        place(leaving, 168);
        captureSessionListLayoutFlight('recent_activity');

        // Recent commits: the session moves up, the project header is gone, a date band arrives.
        leaving.remove();
        const arriving = row('header:today');
        document.body.append(arriving);
        place(kept, 64);
        place(arriving, 32);
        playSessionListLayoutFlight('recent_activity');

        const glide = animate.mock.calls.find(([frames]) => String(frames[0]?.transform).includes('translate(0px, 136px)'));
        expect(glide?.[1]).toEqual(expect.objectContaining({ duration: 220 }));
        const fade = animate.mock.calls.find(([frames]) => frames[0]?.opacity === 0);
        expect(fade).toBeDefined();
        expect(animate).toHaveBeenCalledTimes(2);

        // The capture is spent: a later commit does not glide again.
        animate.mockClear();
        playSessionListLayoutFlight('recent_activity');
        expect(animate).not.toHaveBeenCalled();
    });

    it('waits for the layout it captured for, so an unrelated list change does not spend the capture', () => {
        const kept = row('session:a');
        document.body.append(kept);
        place(kept, 200);
        captureSessionListLayoutFlight('projects');
        place(kept, 100);
        playSessionListLayoutFlight('recent_activity');
        expect(animate).not.toHaveBeenCalled();
        playSessionListLayoutFlight('projects');
        expect(animate).toHaveBeenCalledTimes(1);
    });

    it('glides the rows a drop moved in whichever layout commits it, and plays once', () => {
        const rest = row('session:b');
        const dropped = row('session:a');
        document.body.append(rest, dropped);
        place(rest, 64);
        place(dropped, 96);
        captureSessionListPlacementFlight();

        // The drop commits: the dropped row leaves the gap it filled and the row below closes up.
        place(dropped, 32);
        place(rest, 128);
        playSessionListLayoutFlight('projects');

        expect(animate).toHaveBeenCalledTimes(2);
        expect(animate.mock.calls.some(([frames]) => String(frames[0]?.transform).includes('translate(0px, 64px)'))).toBe(true);
        animate.mockClear();
        playSessionListLayoutFlight('projects');
        expect(animate).not.toHaveBeenCalled();
    });
});
