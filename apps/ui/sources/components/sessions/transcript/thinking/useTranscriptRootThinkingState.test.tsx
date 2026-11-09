import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';

import { useTranscriptRootThinkingState } from './useTranscriptRootThinkingState';

afterEach(() => {
    vi.useRealTimers();
    standardCleanup();
});

const thinkingDelta = (thinking: string): NormalizedMessage => ({
    id: 'think-live', seq: 1, localId: null, createdAt: 10, isSidechain: false, role: 'agent',
    content: [{ type: 'thinking', thinking, uuid: 'think-live', parentUUID: null }],
} as unknown as NormalizedMessage);

describe('useTranscriptRootThinkingState', () => {
    it('keeps the transcript root quiet per thinking delta and still settles stale thinking on time', async () => {
        const staleMs = settingsDefaults.transcriptThinkingPulseStaleMs;
        expect(staleMs).toBeGreaterThan(0);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        vi.setSystemTime(1_000_000);
        const previous = storage.getState();
        const sessionId = 'thinking-root';
        storage.getState().applySessions([createSessionFixture({ id: sessionId, thinking: true })]);
        storage.getState().applyMessages(sessionId, [thinkingDelta('step')]);
        const thinkingId = storage.getState().sessionMessages[sessionId]?.latestThinkingMessageId ?? null;
        expect(thinkingId).not.toBeNull();
        const counts = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counts);
            return useTranscriptRootThinkingState({ latestCommittedActivityKey: thinkingId, sessionId, sessionThinking: true });
        });
        try {
            expect(hook.getCurrent()).toBe(thinkingId);
            counts.reset();
            // Deltas inside the stale window move the deadline; the displayed fact is unchanged.
            let thinking = 'step';
            for (let delta = 0; delta < 5; delta++) {
                thinking += ` ${delta}`;
                await act(async () => {
                    vi.advanceTimersByTime(Math.floor(staleMs / 2));
                    storage.getState().applyMessages(sessionId, [thinkingDelta(thinking)]);
                });
            }
            expect(hook.getCurrent()).toBe(thinkingId);
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });

            // Freshness: the pulse still goes stale exactly one window after the LAST delta.
            await act(async () => { vi.advanceTimersByTime(staleMs - 1); });
            expect(hook.getCurrent()).toBe(thinkingId);
            await act(async () => { vi.advanceTimersByTime(2); });
            expect(hook.getCurrent()).toBeNull();

            // And resumes when thinking streams again.
            await act(async () => { storage.getState().applyMessages(sessionId, [thinkingDelta(`${thinking} resumed`)]); });
            expect(hook.getCurrent()).toBe(thinkingId);
        } finally {
            await hook.unmount();
            storage.setState(previous, true);
        }
    });
});
