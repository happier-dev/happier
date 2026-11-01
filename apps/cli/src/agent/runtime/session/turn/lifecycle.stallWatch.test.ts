import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import { createSessionTurnLifecycle } from './lifecycle';
import type { TurnStallNotice } from './stallWatch';

const STALL_WARN_MS = 15 * 60_000; // mirrors the production default threshold under test

function createStallWatchHarness(params: Readonly<{ stallWarnMs?: number }> = {}) {
    let nowMs = 1_000_000;
    const notices: TurnStallNotice[] = [];
    const mutations: SessionTurnMutationV1[] = [];
    const lifecycle = createSessionTurnLifecycle({
        sessionId: 'stall-watch',
        createId: () => 'stall-turn',
        now: () => nowMs,
        ...(params.stallWarnMs !== undefined ? { turnStallWarnMs: params.stallWarnMs } : {}),
        onTurnStallNotice: (notice) => {
            notices.push(notice);
        },
        enqueueSessionTurn: async (mutation) => {
            mutations.push(mutation);
        },
    });
    return {
        lifecycle,
        notices,
        mutations,
        advance(ms: number): void {
            nowMs += ms;
            vi.advanceTimersByTime(ms);
        },
    };
}

describe('SessionTurnLifecycle turn stall watch', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('notices a fully silent turn exactly once per episode with structured fields', async () => {
        const h = createStallWatchHarness({ stallWarnMs: STALL_WARN_MS });
        await h.lifecycle.beginTurn({ provider: 'claude', providerTurnId: 'provider-turn-1' });
        expect(vi.getTimerCount()).toBe(1);

        h.advance(STALL_WARN_MS);
        expect(h.notices).toEqual([{
            stallMs: STALL_WARN_MS,
            lastEventAgeMs: STALL_WARN_MS,
            provider: 'claude',
            providerTurnId: 'provider-turn-1',
            sessionId: 'stall-watch',
            turnId: 'session-turn:stall-turn',
        }]);

        h.advance(3_600_000);
        expect(h.notices).toHaveLength(1);
    });

    it('resets on provider message events and reports a new episode after the next silence', async () => {
        const h = createStallWatchHarness({ stallWarnMs: STALL_WARN_MS });
        await h.lifecycle.beginTurn({ provider: 'claude' });

        h.advance(STALL_WARN_MS - 300_000);
        h.lifecycle.observeProviderTurnEvent();
        h.advance(STALL_WARN_MS - 300_000);
        expect(h.notices).toHaveLength(0);

        h.advance(300_000);
        expect(h.notices).toHaveLength(1);

        h.lifecycle.observeProviderTurnEvent();
        h.advance(STALL_WARN_MS);
        expect(h.notices).toHaveLength(2);
        expect(h.notices[1]).toMatchObject({ stallMs: STALL_WARN_MS, provider: 'claude' });
    });

    it('does not reset or re-arm the stopwatch when steering an already-active turn', async () => {
        const h = createStallWatchHarness({ stallWarnMs: STALL_WARN_MS });
        await h.lifecycle.beginTurn({ provider: 'claude' });
        expect(vi.getTimerCount()).toBe(1);

        h.advance(STALL_WARN_MS - 300_000);
        await h.lifecycle.beginTurn({ provider: 'claude', providerTurnId: 'steer-1' });
        expect(vi.getTimerCount()).toBe(1);

        // The original silence window keeps running: the notice fires exactly
        // STALL_WARN_MS after the FIRST begin, not after the steer re-begin.
        h.advance(300_000);
        expect(h.notices).toHaveLength(1);
        expect(h.notices[0]).toMatchObject({
            stallMs: STALL_WARN_MS,
            lastEventAgeMs: STALL_WARN_MS,
            turnId: 'session-turn:stall-turn',
        });
        h.advance(STALL_WARN_MS);
        expect(h.notices).toHaveLength(1);
    });

    it('disarms the watch when the turn reaches a terminal state', async () => {
        const h = createStallWatchHarness({ stallWarnMs: STALL_WARN_MS });
        await h.lifecycle.beginTurn({ provider: 'claude' });
        await h.lifecycle.completeTurn({ provider: 'claude' });
        expect(vi.getTimerCount()).toBe(0);

        h.advance(100_000_000);
        expect(h.notices).toHaveLength(0);

        await h.lifecycle.beginTurn({ provider: 'claude' });
        await h.lifecycle.failTurn({ provider: 'claude' });
        await h.lifecycle.beginTurn({ provider: 'claude' });
        await h.lifecycle.cancelTurn();
        h.advance(100_000_000);
        expect(h.notices).toHaveLength(0);
    });

    it('does not reset on keepalive touches (anti false-witness regression, upstream #534)', async () => {
        const h = createStallWatchHarness({ stallWarnMs: STALL_WARN_MS });
        await h.lifecycle.beginTurn({ provider: 'claude' });

        h.advance(STALL_WARN_MS - 300_000);
        await h.lifecycle.touchActiveTurn({ force: true });
        h.advance(300_000);

        expect(h.notices).toHaveLength(1);
        expect(h.notices[0]).toMatchObject({ stallMs: STALL_WARN_MS, lastEventAgeMs: STALL_WARN_MS });
        h.advance(60_000);
        expect(h.notices).toHaveLength(1);
    });

    it('installs no timer at all when HAPPIER_TURN_STALL_WARN_MS=0', async () => {
        vi.stubEnv('HAPPIER_TURN_STALL_WARN_MS', '0');
        const h = createStallWatchHarness();
        await h.lifecycle.beginTurn({ provider: 'claude' });
        expect(vi.getTimerCount()).toBe(0);

        h.lifecycle.observeProviderTurnEvent();
        h.advance(100_000_000);
        expect(h.notices).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('fires exactly at the threshold and not one millisecond earlier', async () => {
        const h = createStallWatchHarness({ stallWarnMs: STALL_WARN_MS });
        await h.lifecycle.beginTurn({ provider: 'gemini' });

        h.advance(STALL_WARN_MS - 1);
        expect(h.notices).toHaveLength(0);
        h.advance(1);
        expect(h.notices).toHaveLength(1);
    });

    it('honors thresholds beyond the platform single-timer range', async () => {
        const stallWarnMs = 2_147_483_647 + 60_000;
        const h = createStallWatchHarness({ stallWarnMs });
        await h.lifecycle.beginTurn({ provider: 'claude' });

        h.advance(1);
        expect(h.notices).toHaveLength(0);
        h.advance(2_147_483_646);
        expect(h.notices).toHaveLength(0);
        h.advance(59_999);
        expect(h.notices).toHaveLength(0);
        h.advance(1);
        expect(h.notices).toEqual([expect.objectContaining({
            stallMs: stallWarnMs,
            lastEventAgeMs: stallWarnMs,
        })]);
    });

    it('arms and disarms through ACP lifecycle markers', async () => {
        const h = createStallWatchHarness({ stallWarnMs: STALL_WARN_MS });
        const started = h.lifecycle.observeAcpLifecycleMarker({
            provider: 'pi',
            body: { type: 'task_started', id: 'provider-turn-9' },
        });
        expect(vi.getTimerCount()).toBe(1);
        await started.pendingWrite;

        const completed = h.lifecycle.observeAcpLifecycleMarker({
            provider: 'pi',
            body: { type: 'task_complete', id: 'provider-turn-9' },
        });
        expect(vi.getTimerCount()).toBe(0);
        await completed.pendingWrite;

        h.advance(100_000_000);
        expect(h.notices).toHaveLength(0);
    });

    it('ignores provider events while no turn is active', async () => {
        const h = createStallWatchHarness({ stallWarnMs: STALL_WARN_MS });
        h.lifecycle.observeProviderTurnEvent();
        expect(vi.getTimerCount()).toBe(0);
        h.advance(STALL_WARN_MS);
        expect(h.notices).toHaveLength(0);
    });
});
