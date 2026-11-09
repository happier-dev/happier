import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionStatus } from '@/utils/sessions/sessionUtils';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';

import { useSessionAgentActivityRoster } from './useSessionAgentActivity';

afterEach(() => {
    standardCleanup();
});

const chunk = (text: string, updatedAtMs: number): NormalizedMessage => ({
    id: 'stream-segment', localId: 'stream-segment', createdAt: 20, seq: 2,
    role: 'agent', isSidechain: false, content: [{ type: 'text', text, uuid: 'stream-segment', parentUUID: null }],
    meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant',
        segmentLocalId: 'stream-segment', segmentState: 'streaming', startedAtMs: 1, updatedAtMs } },
} as unknown as NormalizedMessage);

const toolCall = (id: string, seq: number): NormalizedMessage => ({
    id, seq, localId: null, createdAt: 30 + seq, isSidechain: false, role: 'agent',
    content: [{ type: 'tool-call', id: `call-${id}`, name: 'Bash', input: { command: 'ls' }, description: null, uuid: id, parentUUID: null }],
} as unknown as NormalizedMessage);

/**
 * Readers that present tool, request or status facts, never the streamed text, must not re-render
 * per text delta; a structural transcript change still reaches them.
 */
describe('streaming-quiet transcript readers', () => {
    async function measure<T>(sessionId: string, useReader: () => T) {
        const previous = storage.getState();
        storage.getState().applySessions([createSessionFixture({ id: sessionId, thinking: true, active: true })]);
        storage.getState().applyMessages(sessionId, [chunk('Starting', 2)]);
        const counts = createRenderCommitCounter();
        const hook = await renderHook(() => { useRenderCommitCounter(counts); return useReader(); });
        try {
            counts.reset();
            let text = 'Starting';
            for (let delta = 0; delta < 5; delta++) {
                text += ` token${delta}`;
                await act(async () => { storage.getState().applyMessages(sessionId, [chunk(text, 3 + delta)]); });
            }
            const perTextDelta = counts.read();
            counts.reset();
            await act(async () => { storage.getState().applyMessages(sessionId, [toolCall('tool-1', 3)]); });
            return { perTextDelta, structural: counts.read().renders > 0 };
        } finally {
            await hook.unmount();
            storage.setState(previous, true);
        }
    }

    it('agent roster (messages + reducer readers) stays quiet per text delta', async () => {
        const sessionId = 'quiet-roster';
        expect(await measure(sessionId, () => useSessionAgentActivityRoster({ sessionId })))
            .toEqual({ perTextDelta: { renders: 0, commits: 0 }, structural: true });
    });

    it('session status (pending-request status) stays quiet per text delta', async () => {
        const sessionId = 'quiet-status';
        expect(await measure(sessionId, () => useSessionStatus(storage.getState().sessions[sessionId] ?? null)))
            .toEqual({ perTextDelta: { renders: 0, commits: 0 }, structural: true });
    });
});
