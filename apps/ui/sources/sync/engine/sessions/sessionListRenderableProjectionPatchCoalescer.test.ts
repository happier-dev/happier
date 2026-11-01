import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { applySessionListRenderablePatch } from '@/sync/domains/session/listing/sessionListRenderable';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { SessionListRenderablePatch } from '@/sync/store/domains/sessionListRenderableStoreUpdate';
import { createSessionListRenderableProjectionPatchCoalescer } from './sessionListRenderableProjectionPatchCoalescer';

function buildRenderable(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('createSessionListRenderableProjectionPatchCoalescer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
    });

    afterEach(() => {
        vi.useRealTimers();
        syncPerformanceTelemetry.configure({ enabled: false });
    });

    it.each([
        ['leading patch', undefined],
        ['force-immediate patch', { forceImmediate: true }],
    ] as const)('clears %s leading state when a session is dropped', (_label, options) => {
        const renderables = new Map<string, SessionListRenderableSession>([
            ['s1', buildRenderable('s1')],
        ]);
        const appliedUpdatedAt: number[] = [];
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<number>({
            getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
            readRenderable: (sessionId) => renderables.get(sessionId),
            buildPatch: ({ payload }) => ({ updatedAt: payload }),
            applyPatches: (patches: SessionListRenderablePatch[]) => {
                for (const { sessionId, patch } of patches) {
                    const previous = renderables.get(sessionId);
                    if (!previous) continue;
                    const next = { ...previous, ...patch, id: previous.id };
                    renderables.set(sessionId, next);
                    appliedUpdatedAt.push(next.updatedAt);
                }
            },
        });

        coalescer.enqueue('s1', 2, options);
        coalescer.dropSessionIds(['s1']);
        coalescer.enqueue('s1', 3);

        expect(appliedUpdatedAt).toEqual([2, 3]);
    });

    it('drops coalesced patches that leave the renderable unchanged after all entries are applied', () => {
        const renderables = new Map<string, SessionListRenderableSession>([
            ['s1', buildRenderable('s1')],
        ]);
        const applyPatches = vi.fn((patches: SessionListRenderablePatch[]) => {
            for (const { sessionId, patch } of patches) {
                const previous = renderables.get(sessionId);
                if (!previous) continue;
                renderables.set(sessionId, { ...previous, ...patch, id: previous.id });
            }
        });
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<boolean>({
            getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
            readRenderable: (sessionId) => renderables.get(sessionId),
            buildPatch: ({ payload }) => ({ thinking: payload }),
            applyPatches,
        });

        // Reversible state can cancel out; lifecycle timestamps cannot regress.
        coalescer.enqueue('s1', true, { deferLeadingPatch: true });
        coalescer.enqueue('s1', false);
        vi.advanceTimersByTime(100);

        expect(applyPatches).not.toHaveBeenCalled();
        expect(renderables.get('s1')).toEqual(buildRenderable('s1'));
    });

    it('preserves the newest lifecycle timestamp when a queued patch arrives out of order', () => {
        const renderables = new Map<string, SessionListRenderableSession>([
            ['s1', buildRenderable('s1')],
        ]);
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<number>({
            getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
            readRenderable: (sessionId) => renderables.get(sessionId),
            buildPatch: ({ payload }) => ({ updatedAt: payload }),
            applyPatches: (patches) => {
                for (const { sessionId, patch } of patches) {
                    const previous = renderables.get(sessionId);
                    if (!previous) continue;
                    renderables.set(sessionId, applySessionListRenderablePatch(previous, patch));
                }
            },
        });

        coalescer.enqueue('s1', 3, { deferLeadingPatch: true });
        coalescer.enqueue('s1', 2);
        vi.advanceTimersByTime(100);

        expect(renderables.get('s1')?.updatedAt).toBe(3);
    });

    it('resets queued patches and leading windows without applying stale work', () => {
        const renderables = new Map<string, SessionListRenderableSession>([
            ['s1', buildRenderable('s1')],
        ]);
        const appliedUpdatedAt: number[] = [];
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<number>({
            getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
            readRenderable: (sessionId) => renderables.get(sessionId),
            buildPatch: ({ payload }) => ({ updatedAt: payload }),
            applyPatches: (patches) => {
                for (const { sessionId, patch } of patches) {
                    const previous = renderables.get(sessionId);
                    if (!previous) continue;
                    const next = { ...previous, ...patch, id: previous.id };
                    renderables.set(sessionId, next);
                    appliedUpdatedAt.push(next.updatedAt);
                }
            },
        });

        coalescer.enqueue('s1', 2, { deferLeadingPatch: true });
        coalescer.reset();
        vi.advanceTimersByTime(100);
        coalescer.enqueue('s1', 3);

        expect(appliedUpdatedAt).toEqual([3]);
    });

    it('records telemetry for coalesced patches suppressed as no-ops', () => {
        const renderables = new Map<string, SessionListRenderableSession>([
            ['s1', buildRenderable('s1')],
        ]);
        const applyPatches = vi.fn();
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();
        const coalescer = createSessionListRenderableProjectionPatchCoalescer<boolean>({
            getConfig: () => ({ enabled: true, windowMs: 100, maxBatchSize: 10 }),
            readRenderable: (sessionId) => renderables.get(sessionId),
            buildPatch: ({ payload }) => ({ thinking: payload }),
            applyPatches,
        });

        coalescer.enqueue('s1', true, { deferLeadingPatch: true });
        coalescer.enqueue('s1', false);
        vi.advanceTimersByTime(100);

        const suppressedEvent = syncPerformanceTelemetry.snapshot().events.find(
            (event) => event.name === 'sync.socket.sessions.projectionPatch.coalesce.suppressed',
        );
        expect(suppressedEvent?.fields).toEqual(expect.objectContaining({
            sessions: 1,
            entries: 2,
            noopSessions: 1,
            appliedSessions: 0,
        }));
        expect(applyPatches).not.toHaveBeenCalled();
    });
});
