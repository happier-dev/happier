import type { HappierStagedMoveKeyIntent } from '@happier-dev/plugin-ui/presentation';

import type { TreeDropResult } from '@/components/ui/treeDragDrop';

import type {
    SessionListTreeDragSource,
    SessionListTreeModel,
    SessionListTreeRowMetadata,
} from '../drop-resolution/sessionListTreeTypes';

/**
 * The staged keyboard move of a Session-list row (DnD lab KS), as a pure walk over the list's own
 * tree: ↑/↓ choose the gap above or below a neighbouring row, → puts it under the row just above
 * the chosen gap, ← steps back out and, from a line, to the top level. It only proposes a place;
 * the same domain resolver that admits a pointer drop admits or refuses it, and the docked release
 * preview says which.
 */
export type SessionListStagedMoveState = Readonly<{
    /** Gap index among the candidate rows: gap i sits before candidate i; the last gap after them all. */
    slot: number;
    originSlot: number;
    mode: 'line' | 'under' | 'top-level';
}>;

export type SessionListStagedPlace =
    | Readonly<{ kind: 'origin' }>
    | Readonly<{ kind: 'line'; slot: number }>
    | Readonly<{ kind: 'under'; rowId: string }>
    | Readonly<{ kind: 'top-level' }>;

type Input = Readonly<{ tree: SessionListTreeModel; source: SessionListTreeDragSource }>;

function candidateRows(input: Input): SessionListTreeRowMetadata[] {
    const sourceMetadata = input.source.metadata as SessionListTreeRowMetadata;
    return Array.from(input.tree.rowMetadataById.values())
        .filter((row) => row.rowId !== input.source.id
            && !input.source.excludedDescendantIds.has(row.rowId)
            && row.kind !== 'workspace-root'
            && row.rootId === sourceMetadata.rootId)
        .sort((a, b) => a.itemIndex - b.itemIndex);
}

function placeOf(input: Input, state: SessionListStagedMoveState): SessionListStagedPlace {
    if (state.mode === 'top-level') return { kind: 'top-level' };
    if (state.mode === 'under') {
        const above = candidateRows(input)[state.slot - 1];
        return above ? { kind: 'under', rowId: above.rowId } : { kind: 'origin' };
    }
    return state.slot === state.originSlot ? { kind: 'origin' } : { kind: 'line', slot: state.slot };
}

export function beginSessionListStagedMove(input: Input): SessionListStagedMoveState & Readonly<{ place: SessionListStagedPlace }> {
    const sourceIndex = (input.source.metadata as SessionListTreeRowMetadata).itemIndex;
    const rows = candidateRows(input);
    const after = rows.findIndex((row) => row.itemIndex > sourceIndex);
    const originSlot = after < 0 ? rows.length : after;
    const state: SessionListStagedMoveState = { slot: originSlot, originSlot, mode: 'line' };
    return { ...state, place: placeOf(input, state) };
}

export function stepSessionListStagedMove(input: Input & Readonly<{
    state: SessionListStagedMoveState;
    intent: Extract<HappierStagedMoveKeyIntent, 'previous' | 'next' | 'in' | 'out'>;
}>): SessionListStagedMoveState & Readonly<{ place: SessionListStagedPlace }> {
    const { state } = input;
    const rows = candidateRows(input);
    let next: SessionListStagedMoveState = state;
    switch (input.intent) {
        case 'previous':
        case 'next': {
            const slot = Math.max(0, Math.min(rows.length, state.slot + (input.intent === 'next' ? 1 : -1)));
            next = { ...state, slot, mode: 'line' };
            break;
        }
        case 'in':
            if (state.mode === 'line' && rows[state.slot - 1]) next = { ...state, mode: 'under' };
            break;
        case 'out':
            if (state.mode === 'under') next = { ...state, mode: 'line' };
            else if (state.mode === 'line' && rootContainer(input)) next = { ...state, mode: 'top-level' };
            break;
    }
    return { ...next, place: placeOf(input, next) };
}

function rootContainer(input: Input) {
    const rootId = (input.source.metadata as SessionListTreeRowMetadata).rootId;
    return input.tree.containerMetadataById.get(rootId) ?? null;
}

/** The tree instruction for the staged place, or `null` while it is where it started. */
export function resolveSessionListStagedMoveResult(input: Input & Readonly<{ state: SessionListStagedMoveState }>): TreeDropResult | null {
    const place = placeOf(input, input.state);
    const rows = candidateRows(input);
    switch (place.kind) {
        case 'origin':
            return null;
        case 'top-level': {
            const container = rootContainer(input);
            return container
                ? { instruction: { kind: 'move-to-root', containerId: container.containerId, rootId: container.rootId, depth: container.depth }, visual: { kind: 'none' } }
                : null;
        }
        case 'under': {
            const row = input.tree.rowMetadataById.get(place.rowId);
            if (!row) return null;
            return {
                instruction: {
                    kind: 'nest-into',
                    targetId: row.rowId,
                    containerId: row.childContainerId ?? row.containerId,
                    parentId: row.rowId,
                    depth: row.folderDepth + 1,
                },
                visual: { kind: 'outline', targetId: row.rowId },
            };
        }
        case 'line': {
            // Read the gap from the side the person travelled: "below Relay" going down, "above Fix" going up.
            const below = place.slot > input.state.originSlot;
            const row = below ? rows[place.slot - 1] : rows[place.slot];
            if (!row) return null;
            return {
                instruction: {
                    kind: below ? 'reorder-after' : 'reorder-before',
                    targetId: row.rowId,
                    containerId: row.containerId,
                    parentId: row.parentRowId,
                    depth: row.folderDepth,
                },
                visual: { kind: 'line', targetId: row.rowId, edge: below ? 'bottom' : 'top', depth: row.folderDepth },
            };
        }
    }
}
