import { describe, expect, it } from 'vitest';

import { resolveSessionBoardAnchoredPointerDrop, resolveSessionBoardKeyboardAnchor } from './sessionBoardMoveStrategy';

describe('resolveSessionBoardAnchoredPointerDrop', () => {
    const itemRects = new Map([
        ['one', { x: 0, y: 0, width: 100, height: 80 }],
        ['two', { x: 116, y: 0, width: 100, height: 80 }],
        ['three', { x: 0, y: 96, width: 100, height: 80 }],
        ['four', { x: 116, y: 96, width: 100, height: 80 }],
    ]);

    it('resolves an arbitrary grid jump to one semantic anchor', () => {
        expect(resolveSessionBoardAnchoredPointerDrop({
            draggedId: 'one',
            orderedIds: ['one', 'two', 'three', 'four'],
            itemRects,
            translationX: 140,
            translationY: 125,
            droppedInside: true,
        })).toEqual({ side: 'after', itemId: 'four' });
    });

    it('returns no write for an unchanged slot or a drop outside the Board', () => {
        expect(resolveSessionBoardAnchoredPointerDrop({
            draggedId: 'two',
            orderedIds: ['one', 'two', 'three', 'four'],
            itemRects,
            translationX: 0,
            translationY: 0,
            droppedInside: true,
        })).toBeNull();
        expect(resolveSessionBoardAnchoredPointerDrop({
            draggedId: 'two',
            orderedIds: ['one', 'two', 'three', 'four'],
            itemRects,
            translationX: 500,
            translationY: 500,
            droppedInside: false,
        })).toBeNull();
    });
});

describe('resolveSessionBoardKeyboardAnchor', () => {
    const orderedIds = ['one', 'two', 'three', 'four'];

    it('projects distant staged positions to current semantic anchors', () => {
        expect(resolveSessionBoardKeyboardAnchor({ draggedId: 'one', orderedIds, targetPosition: 4 }))
            .toEqual({ side: 'after', itemId: 'four' });
        expect(resolveSessionBoardKeyboardAnchor({ draggedId: 'four', orderedIds, targetPosition: 2 }))
            .toEqual({ side: 'before', itemId: 'two' });
    });

    it('refuses unchanged, absent and invalid positions', () => {
        expect(resolveSessionBoardKeyboardAnchor({ draggedId: 'two', orderedIds, targetPosition: 2 })).toBeNull();
        expect(resolveSessionBoardKeyboardAnchor({ draggedId: 'removed', orderedIds, targetPosition: 1 })).toBeNull();
        expect(resolveSessionBoardKeyboardAnchor({ draggedId: 'two', orderedIds, targetPosition: 0 })).toBeNull();
        expect(resolveSessionBoardKeyboardAnchor({ draggedId: 'two', orderedIds, targetPosition: 5 })).toBeNull();
        expect(resolveSessionBoardKeyboardAnchor({ draggedId: 'two', orderedIds, targetPosition: 1.5 })).toBeNull();
    });
});
