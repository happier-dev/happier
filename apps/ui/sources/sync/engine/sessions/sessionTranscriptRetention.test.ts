import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createSessionTranscriptRetentionController,
    planSessionTranscriptEviction,
} from './sessionTranscriptRetention';

const MINUTE_MS = 60_000;

describe('planSessionTranscriptEviction', () => {
    const baseInput = {
        nowMs: 100 * MINUTE_MS,
        recentKeepCount: 2,
        graceMs: 3 * MINUTE_MS,
    };

    it('never plans eviction for protected sessions, regardless of recency', () => {
        const plan = planSessionTranscriptEviction({
            ...baseInput,
            hydratedSessionIds: ['s-mounted', 's-old'],
            protectedSessionIds: new Set(['s-mounted', 's-old']),
            lastViewedAtBySessionId: {},
            idleSinceAtBySessionId: new Map([
                ['s-mounted', 0],
                ['s-old', 0],
            ]),
        });

        expect(plan.evictSessionIds).toEqual([]);
        expect(plan.nextSweepDelayMs).toBeNull();
    });

    it('keeps the K most-recently-viewed unprotected sessions without counting protected ones against K', () => {
        const plan = planSessionTranscriptEviction({
            ...baseInput,
            hydratedSessionIds: ['s-protected', 's-recent-1', 's-recent-2', 's-stale'],
            protectedSessionIds: new Set(['s-protected']),
            lastViewedAtBySessionId: {
                's-protected': 99 * MINUTE_MS,
                's-recent-1': 90 * MINUTE_MS,
                's-recent-2': 80 * MINUTE_MS,
                's-stale': 10 * MINUTE_MS,
            },
            idleSinceAtBySessionId: new Map([
                ['s-recent-1', 90 * MINUTE_MS],
                ['s-recent-2', 80 * MINUTE_MS],
                ['s-stale', 10 * MINUTE_MS],
            ]),
        });

        // K=2 beyond the protected session: s-recent-1 and s-recent-2 survive.
        expect(plan.evictSessionIds).toEqual(['s-stale']);
    });

    it('ranks never-viewed sessions below viewed ones', () => {
        const plan = planSessionTranscriptEviction({
            ...baseInput,
            recentKeepCount: 1,
            hydratedSessionIds: ['s-viewed', 's-never-viewed'],
            protectedSessionIds: new Set(),
            lastViewedAtBySessionId: { 's-viewed': 50 * MINUTE_MS },
            idleSinceAtBySessionId: new Map([
                ['s-viewed', 50 * MINUTE_MS],
                ['s-never-viewed', 10 * MINUTE_MS],
            ]),
        });

        expect(plan.evictSessionIds).toEqual(['s-never-viewed']);
    });

    it('defers candidates still inside the grace period and reports when to re-sweep', () => {
        const plan = planSessionTranscriptEviction({
            ...baseInput,
            recentKeepCount: 0,
            hydratedSessionIds: ['s-fresh-release'],
            protectedSessionIds: new Set(),
            lastViewedAtBySessionId: {},
            idleSinceAtBySessionId: new Map([
                // Released one minute ago; grace is three minutes.
                ['s-fresh-release', 99 * MINUTE_MS],
            ]),
        });

        expect(plan.evictSessionIds).toEqual([]);
        expect(plan.deferredSessionIds).toEqual(['s-fresh-release']);
        expect(plan.nextSweepDelayMs).toBe(2 * MINUTE_MS);
    });

    it('evicts candidates once the grace period has elapsed since last view/release', () => {
        const plan = planSessionTranscriptEviction({
            ...baseInput,
            recentKeepCount: 0,
            hydratedSessionIds: ['s-idle'],
            protectedSessionIds: new Set(),
            lastViewedAtBySessionId: { 's-idle': 10 * MINUTE_MS },
            idleSinceAtBySessionId: new Map([
                ['s-idle', 97 * MINUTE_MS],
            ]),
        });

        expect(plan.evictSessionIds).toEqual(['s-idle']);
        expect(plan.deferredSessionIds).toEqual([]);
        expect(plan.nextSweepDelayMs).toBeNull();
    });
});

describe('createSessionTranscriptRetentionController', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    type Harness = ReturnType<typeof createHarness>;

    function createHarness(tuning?: Partial<{ recentKeepCount: number; graceMs: number; sweepDebounceMs: number }>) {
        const hydrated = new Set<string>();
        const protectedIds = new Set<string>();
        const lastViewedAt: Record<string, number> = {};
        const evicted: string[] = [];
        let hydratedReads = 0;

        const controller = createSessionTranscriptRetentionController({
            readHydratedSessionIds: () => {
                hydratedReads += 1;
                return Array.from(hydrated);
            },
            readProtectedSessionIds: () => new Set(protectedIds),
            readLastViewedAtBySessionId: () => ({ ...lastViewedAt }),
            evictSessionTranscript: (sessionId) => {
                evicted.push(sessionId);
                hydrated.delete(sessionId);
            },
            tuning: {
                recentKeepCount: 0,
                graceMs: 3 * MINUTE_MS,
                sweepDebounceMs: 1_000,
                ...tuning,
            },
        });

        return {
            controller,
            hydrated,
            protectedIds,
            lastViewedAt,
            evicted,
            readHydratedReads: () => hydratedReads,
        };
    }

    function releaseSession(harness: Harness, sessionId: string) {
        harness.protectedIds.delete(sessionId);
        harness.controller.scheduleSweep();
    }

    it('evicts an unprotected hydrated session after the grace period without further triggers', () => {
        const harness = createHarness();
        harness.hydrated.add('s1');
        harness.protectedIds.add('s1');

        releaseSession(harness, 's1');
        // Debounced sweep stamps the release; nothing evicted yet.
        vi.advanceTimersByTime(1_000);
        expect(harness.evicted).toEqual([]);

        // The controller self-schedules the grace follow-up; no external trigger needed.
        vi.advanceTimersByTime(3 * MINUTE_MS);
        expect(harness.evicted).toEqual(['s1']);
    });

    it('coalesces rapid triggers into a single sweep', () => {
        const harness = createHarness();
        harness.hydrated.add('s1');

        for (let i = 0; i < 5; i += 1) {
            harness.controller.scheduleSweep();
        }
        expect(harness.readHydratedReads()).toBe(0);

        vi.advanceTimersByTime(1_000);
        expect(harness.readHydratedReads()).toBe(1);
    });

    it('never evicts a session that is protected again by sweep time', () => {
        const harness = createHarness();
        harness.hydrated.add('s1');

        releaseSession(harness, 's1');
        vi.advanceTimersByTime(1_000);

        // Re-mounted (e.g. user navigated back) before the grace elapsed.
        harness.protectedIds.add('s1');
        vi.advanceTimersByTime(10 * MINUTE_MS);
        expect(harness.evicted).toEqual([]);

        // Releasing again restarts a fresh grace window.
        releaseSession(harness, 's1');
        vi.advanceTimersByTime(1_000);
        expect(harness.evicted).toEqual([]);
        vi.advanceTimersByTime(3 * MINUTE_MS);
        expect(harness.evicted).toEqual(['s1']);
    });

    it('respects the recent-keep count across navigation', () => {
        const harness = createHarness({ recentKeepCount: 2, graceMs: 0 });
        for (const [index, sessionId] of ['s1', 's2', 's3', 's4'].entries()) {
            harness.hydrated.add(sessionId);
            harness.lastViewedAt[sessionId] = (index + 1) * MINUTE_MS;
        }
        harness.protectedIds.add('s4');

        // All last-viewed timestamps are in the past by sweep time.
        vi.setSystemTime(10 * MINUTE_MS);
        harness.controller.scheduleSweep();
        vi.advanceTimersByTime(1_000);

        // s4 mounted; keep the 2 most recently viewed of the rest (s3, s2); evict s1.
        expect(harness.evicted).toEqual(['s1']);
    });

    it('dispose cancels pending sweeps and grace follow-ups', () => {
        const harness = createHarness();
        harness.hydrated.add('s1');

        releaseSession(harness, 's1');
        vi.advanceTimersByTime(1_000);
        harness.controller.dispose();

        vi.advanceTimersByTime(30 * MINUTE_MS);
        expect(harness.evicted).toEqual([]);
    });
});
