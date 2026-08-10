import type { AgentActivityStatusV1 } from '@happier-dev/protocol';
import { AGENT_ACTIVITY_STATUSES_V1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, vars?: Record<string, unknown>) => (
            vars ? `${key}:${JSON.stringify(vars)}` : key
        ),
    });
});

const START = 1_000_000;

describe('agent activity staleness', () => {
    it('says nothing until 90 s of silence, then notes it, then escalates at 10 minutes', async () => {
        const { resolveAgentActivityStaleness } = await import('./agentActivityStaleness');
        const at = (offsetMs: number) => resolveAgentActivityStaleness({
            status: 'running',
            updatedAtMs: START,
            nowMs: START + offsetMs,
        });

        expect(at(0)).toBe('fresh');
        expect(at(89_999)).toBe('fresh');
        expect(at(90_000)).toBe('quiet');
        expect(at(599_999)).toBe('quiet');
        expect(at(600_000)).toBe('stale');
        expect(at(86_400_000)).toBe('stale');
    });

    it('makes no claim when nothing has told us when the entry last did anything', async () => {
        const { resolveAgentActivityStaleness, resolveAgentActivityElapsedFreezeAtMs } = await import('./agentActivityStaleness');
        const silentForADay = { status: 'running' as const, nowMs: START + 86_400_000 };

        // A roster that has not hydrated a sidechain knows only that it has not looked. Saying
        // "no update in 10 minutes" here would be a statement about our own hydration.
        expect(resolveAgentActivityStaleness({ ...silentForADay, updatedAtMs: null })).toBe('fresh');
        expect(resolveAgentActivityStaleness({ ...silentForADay, updatedAtMs: undefined })).toBe('fresh');
        expect(resolveAgentActivityStaleness({ ...silentForADay, updatedAtMs: Number.NaN })).toBe('fresh');
        expect(resolveAgentActivityElapsedFreezeAtMs({ status: 'running', updatedAtMs: null })).toBeNull();
    });

    it('never notices the silence of an entry that is silent by definition', async () => {
        const { resolveAgentActivityStaleness } = await import('./agentActivityStaleness');
        const longSilence = { updatedAtMs: START, nowMs: START + 3_600_000 };

        // An agent waiting on a person is not failing to report — and its clock must keep counting,
        // because how long it has been waiting for you is the datum that makes you act (4.7).
        expect(resolveAgentActivityStaleness({ ...longSilence, status: 'waiting' })).toBe('fresh');
        expect(resolveAgentActivityStaleness({ ...longSilence, status: 'blocked' })).toBe('fresh');
        expect(resolveAgentActivityStaleness({ ...longSilence, status: 'queued' })).toBe('fresh');
        // The two that do claim ongoing progress.
        expect(resolveAgentActivityStaleness({ ...longSilence, status: 'running' })).toBe('stale');
        expect(resolveAgentActivityStaleness({ ...longSilence, status: 'starting' })).toBe('stale');
    });

    it('never turns silence into an outcome, for any status in the vocabulary', async () => {
        const { resolveAgentActivityStaleness, resolveAgentActivityElapsedFreezeAtMs } = await import('./agentActivityStaleness');

        for (const status of AGENT_ACTIVITY_STATUSES_V1 as readonly AgentActivityStatusV1[]) {
            const staleness = resolveAgentActivityStaleness({
                status,
                updatedAtMs: START,
                nowMs: START + 86_400_000,
            });
            // The whole contract of 4.9.3 in one assertion: the answer is a presentation value, and
            // there is no path by which a quiet clock produces a status at all.
            expect(['fresh', 'quiet', 'stale']).toContain(staleness);
            expect(AGENT_ACTIVITY_STATUSES_V1 as readonly string[]).not.toContain(staleness);
        }

        // A finished entry is not "silent"; it is done. Neither the note nor the freeze applies.
        expect(resolveAgentActivityStaleness({
            status: 'running',
            updatedAtMs: START,
            endedAtMs: START + 5_000,
            nowMs: START + 86_400_000,
        })).toBe('fresh');
        expect(resolveAgentActivityElapsedFreezeAtMs({
            status: 'running',
            updatedAtMs: START,
            endedAtMs: START + 5_000,
        })).toBeNull();
    });

    it('freezes the clock exactly on the threshold, from the same rule as the note', async () => {
        const { AGENT_ACTIVITY_STALE_AFTER_MS, resolveAgentActivityElapsedFreezeAtMs } = await import('./agentActivityStaleness');

        // Derived from the silence rule, not from a resolved staleness value: the clock ticks every
        // second and the note every 30, so a clock waiting for the note would overshoot and then
        // jump backwards.
        expect(resolveAgentActivityElapsedFreezeAtMs({ status: 'running', updatedAtMs: START }))
            .toBe(START + AGENT_ACTIVITY_STALE_AFTER_MS);
        expect(resolveAgentActivityElapsedFreezeAtMs({ status: 'waiting', updatedAtMs: START })).toBeNull();
    });

    it('carries the state in a word, and states an observation rather than a conclusion', async () => {
        const { resolveAgentActivityStalenessNote } = await import('./agentActivityStaleness');

        expect(resolveAgentActivityStalenessNote('fresh')).toBeNull();
        expect(resolveAgentActivityStalenessNote('quiet')).toBe('session.agentActivity.staleness.quiet');
        // The threshold in the copy comes from the constant, so the sentence cannot start lying
        // when the constant moves.
        expect(resolveAgentActivityStalenessNote('stale')).toBe('session.agentActivity.staleness.stale:{"minutes":10}');
    });
});
