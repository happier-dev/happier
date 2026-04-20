import type {
    SplitCanvasAction,
    SplitCanvasDropTarget,
} from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import {
    createSessionSplitCanvasLeafNode,
    type SessionSplitCanvasLeafPayload,
} from '@/sync/domains/session/sessionSplitCanvasPersistence';
import {
    findSessionLeafIdBySessionId,
    type SessionSplitCanvasState,
} from './sessionSplitCanvasState';

function resolveDirectionalSplitAction(target: SplitCanvasDropTarget): Readonly<{
    axis: 'row' | 'column';
    placement: 'before' | 'after';
}> {
    switch (target.placement) {
        case 'left':
            return { axis: 'row', placement: 'before' };
        case 'right':
            return { axis: 'row', placement: 'after' };
        case 'up':
            return { axis: 'column', placement: 'before' };
        case 'down':
            return { axis: 'column', placement: 'after' };
        default:
            return { axis: 'row', placement: 'after' };
    }
}

export function planSessionSplitCanvasDropAction(input: Readonly<{
    state: SessionSplitCanvasState;
    droppedSessionId: string;
    routeSessionId: string;
    target: SplitCanvasDropTarget;
}>): SplitCanvasAction<SessionSplitCanvasLeafPayload> | null {
    const existingLeafId = findSessionLeafIdBySessionId(input.state, input.droppedSessionId);
    if (existingLeafId) {
        return {
            type: 'focusLeaf',
            leafId: existingLeafId,
        };
    }

    if (input.target.placement === 'center') {
        const targetLeafSessionId = collectSplitCanvasLeaves(input.state.root)
            .find((leaf) => leaf.id === input.target.leafId)
            ?.payload.sessionId ?? null;
        if (!targetLeafSessionId) {
            return null;
        }
        if (targetLeafSessionId === input.routeSessionId) {
            return {
                type: 'splitLeaf',
                targetLeafId: input.target.leafId,
                axis: 'row',
                placement: 'after',
                newLeaf: createSessionSplitCanvasLeafNode(input.droppedSessionId),
            };
        }
        return {
            type: 'replaceLeaf',
            leafId: input.target.leafId,
            nextLeaf: createSessionSplitCanvasLeafNode(input.droppedSessionId),
        };
    }

    const nextAction = resolveDirectionalSplitAction(input.target);
    return {
        type: 'splitLeaf',
        targetLeafId: input.target.leafId,
        axis: nextAction.axis,
        placement: nextAction.placement,
        newLeaf: createSessionSplitCanvasLeafNode(input.droppedSessionId),
    };
}
