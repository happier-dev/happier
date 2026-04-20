import { describe, expect, it } from 'vitest';

import { createInitialSessionSplitCanvasSnapshot } from '@/sync/domains/session/sessionSplitCanvasPersistence';
import {
    collectOpenSessionIds,
    reconcileSessionSplitCanvasRouteAnchor,
    reduceSessionSplitCanvasState,
    resolveSessionSplitCanvasState,
    runSessionSplitCanvasCommand,
} from './sessionSplitCanvasState';

describe('sessionSplitCanvasState', () => {
    it('opens a new session beside the focused leaf and focuses it', () => {
        const initial = resolveSessionSplitCanvasState({
            sessionId: 'sess_a',
            maxLeaves: 8,
        });

        const next = runSessionSplitCanvasCommand(initial, {
            type: 'openSessionInSplit',
            sessionId: 'sess_b',
            direction: 'right',
        });

        expect(next.focusedLeafId).toBe('session-leaf:sess_b');
        expect(next.root).toEqual(expect.objectContaining({
            kind: 'split',
            axis: 'row',
            first: expect.objectContaining({
                id: 'session-leaf:sess_a',
            }),
            second: expect.objectContaining({
                id: 'session-leaf:sess_b',
            }),
        }));
    });

    it('focuses an existing session instead of duplicating it', () => {
        const withSplit = runSessionSplitCanvasCommand(resolveSessionSplitCanvasState({
            sessionId: 'sess_a',
            maxLeaves: 8,
        }), {
            type: 'openSessionInSplit',
            sessionId: 'sess_b',
            direction: 'down',
        });

        const next = runSessionSplitCanvasCommand(withSplit, {
            type: 'openSessionInSplit',
            sessionId: 'sess_b',
            direction: 'right',
        });

        expect(next.focusedLeafId).toBe('session-leaf:sess_b');
        expect(JSON.stringify(next.root)).toBe(JSON.stringify(withSplit.root));
    });

    it('keeps the current split tree intact when the route anchor changes to a session that is already open', () => {
        const withSplit = runSessionSplitCanvasCommand(resolveSessionSplitCanvasState({
            sessionId: 'sess_a',
            maxLeaves: 8,
        }), {
            type: 'openSessionInSplit',
            sessionId: 'sess_b',
            direction: 'right',
        });

        const next = reconcileSessionSplitCanvasRouteAnchor(withSplit, 'sess_b');

        expect(next.focusedLeafId).toBe('session-leaf:sess_b');
        expect(next.root).toEqual(expect.objectContaining({
            kind: 'split',
            first: expect.objectContaining({ id: 'session-leaf:sess_a' }),
            second: expect.objectContaining({ id: 'session-leaf:sess_b' }),
        }));
    });

    it('replaces a restored single-leaf snapshot with the current route anchor instead of auto-splitting', () => {
        const restored = resolveSessionSplitCanvasState({
            sessionId: 'sess_a',
            persistedSnapshot: createInitialSessionSplitCanvasSnapshot({
                sessionId: 'sess_b',
                maxLeaves: 8,
            }),
        });

        expect(restored.focusedLeafId).toBe('session-leaf:sess_a');
        expect(collectOpenSessionIds(restored)).toEqual(['sess_a']);
        expect(restored.root).toEqual(expect.objectContaining({
            kind: 'leaf',
            id: 'session-leaf:sess_a',
            payload: {
                sessionId: 'sess_a',
            },
        }));
    });

    it('preserves the persisted focused leaf when the route anchor is already present in a restored split snapshot', () => {
        const restored = resolveSessionSplitCanvasState({
            sessionId: 'sess_a',
            persistedSnapshot: {
                version: 1,
                root: {
                    id: 'split-root',
                    kind: 'split',
                    axis: 'row',
                    ratio: 0.5,
                    first: {
                        id: 'session-leaf:sess_a',
                        kind: 'leaf',
                        leafKind: 'session',
                        payload: {
                            sessionId: 'sess_a',
                        },
                    },
                    second: {
                        id: 'session-leaf:sess_b',
                        kind: 'leaf',
                        leafKind: 'session',
                        payload: {
                            sessionId: 'sess_b',
                        },
                    },
                },
                focusedLeafId: 'session-leaf:sess_b',
                maximizedLeafId: null,
                maxLeaves: 8,
            },
        });

        expect(collectOpenSessionIds(restored)).toEqual(['sess_a', 'sess_b']);
        expect(restored.focusedLeafId).toBe('session-leaf:sess_b');
    });

    it('opens the requested route anchor in a new split leaf when capacity is available', () => {
        const withSplit = runSessionSplitCanvasCommand(resolveSessionSplitCanvasState({
            sessionId: 'sess_a',
            maxLeaves: 3,
        }), {
            type: 'openSessionInSplit',
            sessionId: 'sess_b',
            direction: 'right',
        });

        const next = reconcileSessionSplitCanvasRouteAnchor(withSplit, 'sess_c', {
            previousRouteSessionId: 'sess_a',
        });

        expect(next.focusedLeafId).toBe('session-leaf:sess_c');
        expect(collectOpenSessionIds(next)).toEqual(['sess_a', 'sess_b', 'sess_c']);
    });

    it('replaces the previous route-owner leaf when the route anchor changes at the max leaf limit', () => {
        const withSplit = runSessionSplitCanvasCommand(resolveSessionSplitCanvasState({
            sessionId: 'sess_a',
            maxLeaves: 2,
        }), {
            type: 'openSessionInSplit',
            sessionId: 'sess_b',
            direction: 'right',
        });

        const next = reconcileSessionSplitCanvasRouteAnchor(withSplit, 'sess_c', {
            previousRouteSessionId: 'sess_a',
        });

        expect(next.focusedLeafId).toBe('session-leaf:sess_c');
        expect(collectOpenSessionIds(next)).toEqual(['sess_c', 'sess_b']);
        expect(next.root).toEqual(expect.objectContaining({
            kind: 'split',
            first: expect.objectContaining({ id: 'session-leaf:sess_c' }),
            second: expect.objectContaining({ id: 'session-leaf:sess_b' }),
        }));
    });

    it('allows closing the route-owner leaf when another session leaf remains', () => {
        const withSplit = runSessionSplitCanvasCommand(resolveSessionSplitCanvasState({
            sessionId: 'sess_a',
            maxLeaves: 2,
        }), {
            type: 'openSessionInSplit',
            sessionId: 'sess_b',
            direction: 'right',
        });

        const next = reduceSessionSplitCanvasState(withSplit, {
            type: 'closeLeaf',
            leafId: 'session-leaf:sess_a',
        }, {
            routeSessionId: 'sess_a',
        });

        expect(collectOpenSessionIds(next)).toEqual(['sess_b']);
        expect(next.focusedLeafId).toBe('session-leaf:sess_b');
        expect(next.root).toEqual(expect.objectContaining({
            kind: 'leaf',
            id: 'session-leaf:sess_b',
            payload: {
                sessionId: 'sess_b',
            },
        }));
    });
});
