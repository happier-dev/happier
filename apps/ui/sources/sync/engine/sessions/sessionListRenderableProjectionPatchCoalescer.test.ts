import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { createSessionListRenderableProjectionPatchCoalescer } from './sessionListRenderableProjectionPatchCoalescer';

function renderable(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
    };
}

describe('createSessionListRenderableProjectionPatchCoalescer', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('clears immediate-only leading-window state when a session id is dropped', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const applied: Array<{ sessionId: string; patch: Readonly<{ updatedAt?: number }> }> = [];
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<number>({
            getConfig: () => ({ enabled: true, windowMs: 1_000, maxBatchSize: 10 }),
            readRenderable: (sessionId) => renderable(sessionId),
            buildPatch: ({ payload }) => ({ updatedAt: payload }),
            applyPatches: (patches) => {
                applied.push(...patches);
            },
        });

        coalescer.enqueue('session-1', 2, { forceImmediate: true });
        expect(applied.map((entry) => entry.patch.updatedAt)).toEqual([2]);

        coalescer.dropSessionIds(['session-1']);
        coalescer.enqueue('session-1', 3);

        expect(applied.map((entry) => entry.patch.updatedAt)).toEqual([2, 3]);
    });
});
