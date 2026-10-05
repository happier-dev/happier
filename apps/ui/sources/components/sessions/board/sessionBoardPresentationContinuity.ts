import { readSessionSurfaceNoteTextV1 } from '@happier-dev/protocol/sessions/board';

import type { SessionBoardItemProjection } from '@/sync/domains/session/board';

import type { SessionBoardPresentationPosition } from './SessionBoardContinuity';
import type { SessionBoardItemRect } from './sessionBoardMoveStrategy';

export function captureSessionBoardPresentationPosition(input: Readonly<{
    orderedItemIds: readonly string[];
    itemRects: ReadonlyMap<string, SessionBoardItemRect>;
    contentStartY: number;
    scrollOffset: number;
}>): SessionBoardPresentationPosition {
    const viewportTop = input.scrollOffset;
    for (const itemId of input.orderedItemIds) {
        const rect = input.itemRects.get(itemId);
        if (!rect) continue;
        const itemTop = input.contentStartY + rect.y;
        if (itemTop + rect.height > viewportTop) {
            return {
                anchorItemId: itemId,
                offsetWithinItem: viewportTop - itemTop,
                absoluteOffset: viewportTop,
            };
        }
    }
    return { anchorItemId: null, offsetWithinItem: 0, absoluteOffset: viewportTop };
}

export function resolveSessionBoardPresentationOffset(input: Readonly<{
    position: SessionBoardPresentationPosition;
    itemRects: ReadonlyMap<string, SessionBoardItemRect>;
    contentStartY: number;
}>): number {
    const anchor = input.position.anchorItemId
        ? input.itemRects.get(input.position.anchorItemId)
        : null;
    return Math.max(0, anchor
        ? input.contentStartY + anchor.y + input.position.offsetWithinItem
        : input.position.absoluteOffset);
}

function searchableItemText(item: SessionBoardItemProjection | undefined): string {
    if (item?.state.kind !== 'ready') return '';
    const source = item.state.item.source;
    const body = source.kind === 'declarative' ? readSessionSurfaceNoteTextV1(source.document) : '';
    return `${item.state.item.title}\n${body}`.toLocaleLowerCase();
}

/** Derives a mobile inventory from loaded bytes only; order and layout stay canonical. */
export function filterSessionBoardItemIds(input: Readonly<{
    orderedItemIds: readonly string[];
    itemsById: ReadonlyMap<string, SessionBoardItemProjection>;
    query: string;
}>): readonly string[] {
    const query = input.query.trim().toLocaleLowerCase();
    if (!query) return input.orderedItemIds;
    return input.orderedItemIds.filter((itemId) => searchableItemText(input.itemsById.get(itemId)).includes(query));
}
