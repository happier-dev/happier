import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { useHasUnreadMessages, useSessionListRowsByServerId } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';

afterEach(() => {
    standardCleanup();
});

const chunk = (text: string, updatedAtMs: number): NormalizedMessage => ({
    id: 'stream-segment', localId: 'stream-segment', createdAt: 2_000, seq: 11,
    role: 'agent', isSidechain: false, content: [{ type: 'text', text, uuid: 'stream-segment', parentUUID: null }],
    meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant',
        segmentLocalId: 'stream-segment', segmentState: 'streaming', startedAtMs: 1, updatedAtMs } },
} as unknown as NormalizedMessage);

describe('streaming Session list row', () => {
    it('keeps the streaming row, its neighbours and the unread badge quiet per text and thinking delta', async () => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const session = createSessionFixture({ id: 'stream-row', serverId, seq: 10, lastViewedSessionSeq: 10, active: true, thinking: true });
        const neighbor = createSessionFixture({ id: 'stream-row-neighbor', serverId });
        storage.setState({
            sessions: { ...previous.sessions, [session.id]: session, [neighbor.id]: neighbor },
            sessionListRowsByServerId: { ...previous.sessionListRowsByServerId, [serverId]: {
                [session.id]: buildSessionListRenderableFromSession(session),
                [neighbor.id]: buildSessionListRenderableFromSession(neighbor),
            } },
        });
        // The segment's arrival is a real row fact (new activity); text growth after it is not.
        storage.getState().applyMessages(session.id, [chunk('Starting', 2)]);
        const rowCounts = createRenderCommitCounter();
        const badgeCounts = createRenderCommitCounter();
        const serverIds = [serverId];
        const rows = await renderHook(() => {
            useRenderCommitCounter(rowCounts);
            return useSessionListRowsByServerId(serverIds);
        });
        const badge = await renderHook(() => {
            useRenderCommitCounter(badgeCounts);
            return useHasUnreadMessages(session.id);
        });
        try {
            const initialRows = rows.getCurrent();
            const initialBadge = badge.getCurrent();
            rowCounts.reset(); badgeCounts.reset();
            let text = 'Starting';
            for (let delta = 0; delta < 6; delta++) {
                text += ` token${delta}`;
                await act(async () => { storage.getState().applyMessages(session.id, [chunk(text, 3 + delta)]); });
            }
            expect(rows.getCurrent()[serverId]?.[session.id]).toBe(initialRows[serverId]?.[session.id]);
            expect(rows.getCurrent()[serverId]?.[neighbor.id]).toBe(initialRows[serverId]?.[neighbor.id]);
            expect(badge.getCurrent()).toBe(initialBadge);
            expect({ rows: rowCounts.read(), badge: badgeCounts.read() }).toEqual({
                rows: { renders: 0, commits: 0 }, badge: { renders: 0, commits: 0 },
            });
            // Thinking deltas: the thinking row's arrival is structural; growth after it is not a row fact.
            const think = (thinking: string) => ({ id: 'think-live', seq: 12, localId: null, createdAt: 2_001, isSidechain: false,
                role: 'agent', content: [{ type: 'thinking', thinking, uuid: 'think-live', parentUUID: null }] } as unknown as NormalizedMessage);
            await act(async () => { storage.getState().applyMessages(session.id, [think('Considering')]); });
            const thinkingRows = rows.getCurrent();
            rowCounts.reset(); badgeCounts.reset();
            let thinking = 'Considering';
            for (let delta = 0; delta < 6; delta++) {
                thinking += ` step${delta}`;
                await act(async () => { storage.getState().applyMessages(session.id, [think(thinking)]); });
            }
            expect(rows.getCurrent()[serverId]?.[session.id]).toBe(thinkingRows[serverId]?.[session.id]);
            expect({ rows: rowCounts.read(), badge: badgeCounts.read() }).toEqual({
                rows: { renders: 0, commits: 0 }, badge: { renders: 0, commits: 0 },
            });
        } finally {
            await rows.unmount(); await badge.unmount();
            storage.setState(previous);
        }
    });
});
