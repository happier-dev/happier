import { describe, expect, it } from 'vitest';
import type { EntityDropDestination } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import { resolveSessionSurfaceKeyboardDestination } from './sessionSurfaceKeyboardDestination';
import { SessionSurfaceAnchorSchema } from './sessionBoardEntityBinding';

const destinations: EntityDropDestination[] = ['a', 'b', 'c', 'd'].flatMap(itemId => (['before', 'after'] as const).map(side => ({
    targetId: itemId, destination: { side, itemId }, admission: { status: 'refused' as const, reason: { code: 'same-position', message: 'No change' } },
})));
const readAnchor = (destination: EntityDropDestination) => {
    const parsed = SessionSurfaceAnchorSchema.safeParse(destination.destination);
    return parsed.success ? parsed.data : null;
};
describe('Session surface keyboard destinations', () => {
    it('stages from the current item, not the first mounted chooser target, and rebases the next arrow against live order', () => {
        const input = { itemKey: 'b', orderedKeys: ['a', 'b', 'c', 'd'], destinations, readAnchor, selected: null };
        const below = resolveSessionSurfaceKeyboardDestination({ ...input, direction: 'next' });
        expect(below?.destination).toEqual({ side: 'before', itemId: 'd' });
        expect(resolveSessionSurfaceKeyboardDestination({ ...input, selected: below, direction: 'previous' })).toBeNull();
        const removedAnchor = resolveSessionSurfaceKeyboardDestination({ ...input, orderedKeys: ['a', 'b', 'c'], selected: below, direction: 'previous' });
        expect(removedAnchor?.destination).toEqual({ side: 'before', itemId: 'a' });
    });
    it('never falls back to another surface or recreates a removed source', () => {
        const input = { itemKey: 'b', orderedKeys: ['a', 'b'], destinations, readAnchor, selected: null };
        expect(resolveSessionSurfaceKeyboardDestination({ ...input, itemKey: 'missing', direction: 'next' })).toBeNull();
        expect(resolveSessionSurfaceKeyboardDestination({ ...input, destinations: [], direction: 'previous' })).toBeNull();
    });
});
