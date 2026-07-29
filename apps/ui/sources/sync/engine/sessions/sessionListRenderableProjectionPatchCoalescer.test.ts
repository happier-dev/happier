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

    it('drops coalesced patches that leave the renderable unchanged after all entries are applied', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const renderables = new Map<string, SessionListRenderableSession>([
            ['session-1', renderable('session-1')],
        ]);
        const applyPatches = vi.fn((patches: Array<{
            sessionId: string;
            patch: Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;
        }>) => {
            for (const { sessionId, patch } of patches) {
                const previous = renderables.get(sessionId);
                if (!previous) continue;
                renderables.set(sessionId, { ...previous, ...patch, id: previous.id });
            }
        });
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<number>({
            getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
            readRenderable: (sessionId) => renderables.get(sessionId),
            buildPatch: ({ payload }) => ({ updatedAt: payload }),
            applyPatches,
        });

        coalescer.enqueue('session-1', 2, { deferLeadingPatch: true });
        coalescer.enqueue('session-1', 1);
        vi.advanceTimersByTime(100);

        expect(applyPatches).not.toHaveBeenCalled();
        expect(renderables.get('session-1')).toEqual(renderable('session-1'));
    });
});
