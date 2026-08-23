import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
    createTriageRefreshCoordinator,
    type TriageRefreshCoordinatorV1,
    type TriageRefreshPassInputV1,
    type TriageRefreshPassOutcomeV1,
} from './refreshCoordinator.js';
import { TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS } from './refreshEligibility.js';

const NOW_MS = 1_700_000_000_000;
const INSTANCE_A = '11111111-2222-4333-8444-555555555555';
const INSTANCE_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';

type PendingPass = Readonly<{
    input: TriageRefreshPassInputV1;
    settle: (outcome: TriageRefreshPassOutcomeV1) => void;
}>;

type Harness = Readonly<{
    coordinator: TriageRefreshCoordinatorV1;
    passes: readonly PendingPass[];
    advanceMs(deltaMs: number): void;
}>;

function createHarness(options: Readonly<{ random?: () => number }> = {}): Harness {
    let nowMs = NOW_MS;
    const passes: PendingPass[] = [];
    const coordinator = createTriageRefreshCoordinator({
        runPass: (input) => new Promise<TriageRefreshPassOutcomeV1>((resolve) => {
            passes.push({ input, settle: resolve });
        }),
        nowMs: () => nowMs,
        ...(options.random ? { random: options.random } : {}),
    });
    return {
        coordinator,
        passes,
        advanceMs(deltaMs) {
            nowMs += deltaMs;
        },
    };
}

function transientFailure(overrides: Partial<TriageSourceFailureV1> = {}): TriageRefreshPassOutcomeV1 {
    return { kind: 'failed', failure: { class: 'transient', code: 'source-busy', ...overrides } };
}

describe('triage refresh coordinator', () => {
    it('starts one initial scan only after an explicit refresh producer asks', async () => {
        const harness = createHarness();
        expect(harness.passes).toHaveLength(0);

        const request = harness.coordinator.request({
            sourceInstanceId: INSTANCE_A,
            trigger: 'manual',
        });
        expect(request.disposition).toBe('started');
        expect(harness.passes).toHaveLength(1);
        // A pass is given an instance and a cancellation signal — never a
        // checkpoint, cursor, resume token, or persisted scan state.
        expect(Object.keys(harness.passes[0]!.input).sort()).toEqual(['signal', 'sourceInstanceId']);
        expect(harness.passes[0]!.input.sourceInstanceId).toBe(INSTANCE_A);

        harness.passes[0]!.settle({ kind: 'completed' });
        await request.settled;
    });

    it('settles a request only when its own provider pass has finished', async () => {
        const harness = createHarness();
        const request = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'manual' });
        let settled = false;
        void request.settled.then(() => { settled = true; });

        // Drain every microtask an early resolution could have hidden behind.
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();

        // This is what keeps one pass per instance in flight. The sole producer
        // of `request` is the list-window store's refresh cycle, which awaits
        // this promise for every configured instance before it returns; the
        // store's own coalesced scheduler then cannot start the next cycle
        // until it does. A promise that resolved before the provider answered
        // would let the next cycle re-enter this slot while its pass is still
        // running — reintroducing exactly the concurrency this coordinator no
        // longer arbitrates, and leaving the second pass to overwrite the first
        // one's abort controller and pacing state.
        expect(settled).toBe(false);
        expect(harness.passes).toHaveLength(1);

        harness.passes[0]!.settle({ kind: 'completed' });
        await request.settled;
        expect(settled).toBe(true);
    });

    it('collapses a mount focus visibility and recent-activity burst into one provider read', async () => {
        const harness = createHarness();
        const first = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' });
        expect(first.disposition).toBe('started');

        // The interval is measured from the read *start*, so it is already
        // running while the first pass is in flight: a burst is refused by the
        // one pacing rule rather than by a second single-flight mechanism.
        for (let burst = 0; burst < 3; burst += 1) {
            const suppressedDuringPass = harness.coordinator.request({
                sourceInstanceId: INSTANCE_A,
                trigger: 'view',
            });
            expect(suppressedDuringPass.disposition).toBe('blocked');
            expect(suppressedDuringPass.blocked).toEqual({
                reason: 'minimumInterval',
                nextEligibleAtMs: NOW_MS + TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS,
            });
        }
        expect(harness.passes).toHaveLength(1);

        harness.passes[0]!.settle({ kind: 'completed' });
        await first.settled;

        harness.advanceMs(TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS - 1);
        const suppressed = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' });
        expect(suppressed.disposition).toBe('blocked');
        expect(suppressed.blocked).toEqual({
            reason: 'minimumInterval',
            nextEligibleAtMs: NOW_MS + TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS,
        });
        expect(harness.passes).toHaveLength(1);

        harness.advanceMs(1);
        expect(harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' }).disposition)
            .toBe('started');
        expect(harness.passes).toHaveLength(2);
    });

    it('paces each configured source instance independently', () => {
        const harness = createHarness();
        harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' });
        const other = harness.coordinator.request({ sourceInstanceId: INSTANCE_B, trigger: 'view' });
        expect(other.disposition).toBe('started');
        expect(harness.passes.map((pass) => pass.input.sourceInstanceId)).toEqual([INSTANCE_A, INSTANCE_B]);
    });

    it('honours a source-stated retry deadline against a later manual Refresh', async () => {
        const harness = createHarness();
        const view = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' });

        harness.passes[0]!.settle(transientFailure({
            class: 'rateLimit',
            code: 'secondary-limit',
            retryNotBeforeMs: NOW_MS + 60_000,
        }));
        await view.settled;
        expect(harness.passes).toHaveLength(1);

        // Manual Refresh bypasses our own minimum interval but never the
        // provider's own deadline.
        const blocked = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'manual' });
        expect(blocked.disposition).toBe('blocked');
        expect(blocked.blocked).toEqual({
            reason: 'sourceRetryDeadline',
            nextEligibleAtMs: NOW_MS + 60_000,
        });
        expect(harness.passes).toHaveLength(1);

        harness.advanceMs(60_000);
        expect(harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'manual' }).disposition)
            .toBe('started');
        expect(harness.passes).toHaveLength(2);
    });

    it('clears process-local failure pacing after a completed walk', async () => {
        const harness = createHarness({ random: () => 1 });
        const failing = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'manual' });
        harness.passes[0]!.settle(transientFailure());
        await failing.settled;

        expect(harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'manual' }).blocked)
            .toEqual({ reason: 'failureBackoff', nextEligibleAtMs: NOW_MS + 5_000 });

        harness.advanceMs(5_000);
        const recovering = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'manual' });
        expect(recovering.disposition).toBe('started');
        harness.passes[1]!.settle({ kind: 'completed' });
        await recovering.settled;

        // The next failure starts the ceiling over rather than continuing the
        // pre-recovery sequence.
        const afterRecovery = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'manual' });
        harness.passes[2]!.settle(transientFailure());
        await afterRecovery.settled;
        expect(harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'manual' }).blocked)
            .toEqual({ reason: 'failureBackoff', nextEligibleAtMs: NOW_MS + 5_000 + 5_000 });
    });

    it('measures the minimum interval from the provider read start', async () => {
        const harness = createHarness();
        const view = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' });
        harness.advanceMs(TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS + 1);
        harness.passes[0]!.settle({ kind: 'completed' });
        await view.settled;

        expect(harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' }).disposition)
            .toBe('started');
    });

    it('aborts shared provider work on retirement and drops its late result', async () => {
        const harness = createHarness();
        const view = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' });
        expect(harness.passes[0]!.input.signal.aborted).toBe(false);

        harness.coordinator.retire(INSTANCE_A);
        expect(harness.passes[0]!.input.signal.aborted).toBe(true);

        harness.passes[0]!.settle(transientFailure());
        await view.settled;

        // The retired instance's late failure cannot pace a later explicit
        // refresh of the same id. `manual` is the discriminating trigger here:
        // it bypasses the shared interval but still honours a failure backoff,
        // so a retained deadline would refuse it.
        expect(harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'manual' }).disposition)
            .toBe('started');
        expect(harness.passes).toHaveLength(2);
    });

    it('forgets every pacing fact when the process is replaced', async () => {
        const harness = createHarness({ random: () => 1 });
        const failing = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' });
        harness.passes[0]!.settle(transientFailure());
        await failing.settled;
        expect(harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' }).disposition)
            .toBe('blocked');

        // A restarted process has no last-read fact, no backoff, and no
        // continuation: the next trigger starts an initial pass.
        const restarted = createHarness({ random: () => 1 });
        expect(restarted.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' }).disposition)
            .toBe('started');
    });

    it('refuses new provider work once disposed', () => {
        const harness = createHarness();
        const view = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'view' });
        expect(view.disposition).toBe('started');

        harness.coordinator.dispose();
        expect(harness.passes[0]!.input.signal.aborted).toBe(true);

        const afterDispose = harness.coordinator.request({ sourceInstanceId: INSTANCE_A, trigger: 'manual' });
        expect(afterDispose.disposition).toBe('blocked');
        expect(afterDispose.blocked).toEqual({ reason: 'retired' });
        expect(harness.passes).toHaveLength(1);
    });
});
