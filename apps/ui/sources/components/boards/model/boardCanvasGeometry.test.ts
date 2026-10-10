import { describe, expect, it } from 'vitest';

import {
    BOARD_CANVAS_METRICS,
    moveBoardCardByKeyboard,
    resolveBoardCanvasColumnCount,
    resolveBoardCanvasPositions,
    resolveBoardCardDrop,
} from './boardCanvasGeometry';

const step = BOARD_CANVAS_METRICS.gridStepPx;

describe('board canvas geometry', () => {
    it('lands a dropped card exactly where it was released when snapping is off, and on the grid when on', () => {
        expect(resolveBoardCardDrop({ origin: { x: 10, y: 20 }, translation: { x: 31, y: 7 }, snap: false }))
            .toEqual({ x: 41, y: 27 });
        expect(resolveBoardCardDrop({ origin: { x: 10, y: 20 }, translation: { x: 31, y: 7 }, snap: true }))
            .toEqual({ x: Math.round(41 / step) * step, y: Math.round(27 / step) * step });
    });

    it('with snapping off, holding Shift snaps this one drop to the grid', () => {
        expect(resolveBoardCardDrop({ origin: { x: 10, y: 20 }, translation: { x: 31, y: 7 }, snap: false, snapOnce: true }))
            .toEqual({ x: Math.round(41 / step) * step, y: Math.round(27 / step) * step });
    });

    it('never places a card above or left of the canvas origin', () => {
        expect(resolveBoardCardDrop({ origin: { x: 10, y: 10 }, translation: { x: -400, y: -400 }, snap: true }))
            .toEqual({ x: 0, y: 0 });
    });

    it('moves a focused card one snap-grid step per arrow key, from a free position onto the grid', () => {
        expect(moveBoardCardByKeyboard({ x: 0, y: 0 }, 'right')).toEqual({ x: step, y: 0 });
        expect(moveBoardCardByKeyboard({ x: step * 2, y: step }, 'up')).toEqual({ x: step * 2, y: 0 });
        expect(moveBoardCardByKeyboard({ x: 5, y: 5 }, 'down')).toEqual({ x: 0, y: step });
        expect(moveBoardCardByKeyboard({ x: 0, y: 0 }, 'left')).toEqual({ x: 0, y: 0 });
    });

    it('fits as many card columns as the width allows, at least one', () => {
        const slot = BOARD_CANVAS_METRICS.cardWidthPx + BOARD_CANVAS_METRICS.gapPx;
        expect(resolveBoardCanvasColumnCount(100)).toBe(1);
        expect(resolveBoardCanvasColumnCount(slot * 3)).toBe(3);
    });

    it('reserves the reproduction rectangles before flowing 17 filtered cards, including the taller saved variants', () => {
        const members = [{ key: 'workflow', width: 378, height: 88 }, { key: 'run', width: 378, height: 88 },
            { key: 'machine', width: 378, height: 64 }, { key: 'lead', width: 378, height: 64 },
            ...Array.from({ length: 17 }, (_, index) => ({ key: `filtered-${index}`, width: 378, height: 64 }))];
        const saved = { workflow: { x: 24, y: 0 }, run: { x: 0, y: 112 }, machine: { x: 424, y: 0 }, lead: { x: 424, y: 256 } };
        const input = { members, positionsByItemRef: saved, columnCount: 2, snap: true, previous: new Map() };
        const positions = resolveBoardCanvasPositions(input);
        for (const a of members) for (const b of members) {
            if (a.key === b.key) continue;
            const first = positions.get(a.key)!, second = positions.get(b.key)!;
            expect(first.x < second.x + b.width && second.x < first.x + a.width
                && first.y < second.y + b.height && second.y < first.y + a.height, `${a.key} / ${b.key}`).toBe(false);
        }
        for (const [key, point] of Object.entries(saved)) expect(positions.get(key)).toEqual(point);
        // Equivalent refresh inputs retain the whole position map and each point's identity.
        expect(resolveBoardCanvasPositions({ ...input, members: members.map(member => ({ ...member })),
            positionsByItemRef: { ...saved }, previous: positions })).toBe(positions);
        expect(resolveBoardCanvasPositions(input)).toEqual(positions);
        const inserted = resolveBoardCanvasPositions({ ...input,
            members: [...members, { key: 'arrival', width: 400, height: 64 }], previous: positions });
        for (const member of members) expect(inserted.get(member.key)).toBe(positions.get(member.key));
        const removed = resolveBoardCanvasPositions({ ...input, members: members.filter(member => member.key !== 'filtered-0'), previous: inserted });
        expect(removed).toEqual(resolveBoardCanvasPositions({ ...input,
            members: members.filter(member => member.key !== 'filtered-0'), previous: new Map() }));
    });

    it('compacts filtered automatic cards into balanced columns while preserving saved rectangles', () => {
        const members = Array.from({ length: 6 }, (_, index) => ({ key: `card-${index}`, width: 400, height: 64 }));
        const previous = new Map(members.map((member, index) => [member.key, { x: 0, y: 200 + index * 88 }]));
        const input = { members, positionsByItemRef: { 'card-0': { x: 424, y: 176 } }, columnCount: 2, snap: false, previous };
        const positions = resolveBoardCanvasPositions(input);
        expect(positions.get('card-0')).toEqual(input.positionsByItemRef['card-0']);
        expect(positions.get('card-1')).toEqual({ x: 0, y: 0 });
        expect(positions.get('card-2')).toEqual({ x: 424, y: 0 });
        expect(positions.get('card-3')).toEqual({ x: 0, y: 88 });
        expect(positions.get('card-4')).toEqual({ x: 424, y: 88 });
        expect(positions.get('card-5')).toEqual({ x: 0, y: 176 });
        expect(resolveBoardCanvasPositions({ ...input, previous: positions })).toBe(positions);
    });

    it('fits measured wide widgets and reflows a collision after a card grows, preserving the other column', () => {
        const input = { members: [{ key: 'a', width: 400, height: 64 }, { key: 'b', width: 400, height: 88 },
            { key: 'c', width: 400, height: 64 }, { key: 'wide', width: 824, height: 160 }],
            positionsByItemRef: {}, columnCount: 2, snap: true, previous: new Map() };
        const positions = resolveBoardCanvasPositions(input);
        expect(positions.get('a')).toEqual({ x: 0, y: 0 });
        expect(positions.get('b')).toEqual({ x: 432, y: 0 });
        expect(positions.get('c')).toEqual({ x: 0, y: 96 });
        expect(positions.get('wide')!.y).toBeGreaterThanOrEqual(184);
        const grown = resolveBoardCanvasPositions({ ...input, members: input.members.map(member => member.key === 'a'
            ? { ...member, height: 152 } : member), previous: positions });
        expect(grown.get('a')).toBe(positions.get('a'));
        expect(grown.get('b')).toBe(positions.get('b'));
        // The compact projection uses the earlier opening in the other column, not c's old slot.
        expect(grown.get('c')).toEqual({ x: 432, y: 120 });
        expect(grown.get('wide')!.y).toBeGreaterThanOrEqual(208);
        const free = resolveBoardCanvasPositions({ ...input, snap: false });
        expect(free.get('b')).toEqual({ x: 424, y: 0 });
        expect(free.get('c')).toEqual({ x: 0, y: 88 });
        expect(resolveBoardCanvasColumnCount(824, true)).toBe(1);
        expect(resolveBoardCanvasColumnCount(832, true)).toBe(2);
    });
});
