import { describe, expect, it } from 'vitest';

import { planSessionSplitCanvasDropAction } from './planSessionSplitCanvasDropAction';

describe('planSessionSplitCanvasDropAction', () => {
    it('opens a dragged session beside the route anchor for center drops instead of no-oping', () => {
        const state = {
            root: {
                id: 'route-leaf',
                kind: 'leaf',
                leafKind: 'session',
                payload: { sessionId: 'sess_route' },
            },
            focusedLeafId: 'route-leaf',
            maximizedLeafId: null,
            maxLeaves: 8,
        } as const;

        const action = planSessionSplitCanvasDropAction({
            state,
            droppedSessionId: 'sess_2',
            routeSessionId: 'sess_route',
            target: {
                leafId: 'route-leaf',
                placement: 'center',
            },
        });

        expect(action).toEqual(expect.objectContaining({
            type: 'splitLeaf',
            targetLeafId: 'route-leaf',
            axis: 'row',
            placement: 'after',
            newLeaf: expect.objectContaining({
                id: 'session-leaf:sess_2',
                payload: { sessionId: 'sess_2' },
            }),
        }));
    });

    it('replaces a non-route center-drop target based on leaf payload rather than leaf id format', () => {
        const state = {
            root: {
                id: 'custom-split-root',
                kind: 'split',
                axis: 'row',
                ratio: 0.5,
                first: {
                    id: 'custom-leaf-a',
                    kind: 'leaf',
                    leafKind: 'session',
                    payload: { sessionId: 'sess_1' },
                },
                second: {
                    id: 'custom-leaf-b',
                    kind: 'leaf',
                    leafKind: 'session',
                    payload: { sessionId: 'sess_2' },
                },
            },
            focusedLeafId: 'custom-leaf-b',
            maximizedLeafId: null,
            maxLeaves: 8,
        } as const;

        const action = planSessionSplitCanvasDropAction({
            state,
            droppedSessionId: 'sess_9',
            routeSessionId: 'sess_2',
            target: {
                leafId: 'custom-leaf-a',
                placement: 'center',
            },
        });

        expect(action).toEqual(expect.objectContaining({
            type: 'replaceLeaf',
            leafId: 'custom-leaf-a',
            nextLeaf: expect.objectContaining({
                id: 'session-leaf:sess_9',
                payload: { sessionId: 'sess_9' },
            }),
        }));
    });
});
