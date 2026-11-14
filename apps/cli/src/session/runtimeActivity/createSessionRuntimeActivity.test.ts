import { describe, expect, it, vi } from 'vitest';

import { createSessionRuntimeActivity } from './createSessionRuntimeActivity';
import type {
    SessionRuntimeActivity,
    SessionRuntimeActivitySnapshotPublisher,
} from './types';

const idle = { state: 'idle', activeCount: 0 } as const;
const activeAgent = {
    state: 'active',
    activeCount: 1,
} as const;
const activeExecution = {
    state: 'active',
    activeCount: 2,
} as const;

function createPublisher(overrides: Partial<SessionRuntimeActivitySnapshotPublisher> = {}) {
    return {
        publish: vi.fn(overrides.publish ?? (async () => {})),
        close: vi.fn(overrides.close ?? (async () => {})),
        ...(overrides.subscribeDesiredReoffer
            ? { subscribeDesiredReoffer: overrides.subscribeDesiredReoffer }
            : {}),
    } satisfies SessionRuntimeActivitySnapshotPublisher;
}

async function bind(
    activity: SessionRuntimeActivity,
    publisher: SessionRuntimeActivitySnapshotPublisher,
): Promise<void> {
    await activity.bindPublisher(publisher);
}

describe('createSessionRuntimeActivity', () => {
    it.each([
        ['supported', true, { state: 'unknown', activeCount: 0 }],
        ['unavailable', false, { state: 'unknown', activeCount: 0 }],
        ['not_applicable', false, { state: 'idle', activeCount: 0 }],
    ] as const)(
        'uses applicability %s as the sole agent-runtime binding decision',
        async (applicability, hasProducer, baseline) => {
            const activity = createSessionRuntimeActivity(applicability);
            const publisher = createPublisher();

            expect(activity.agentRuntimeContributionHandle !== null).toBe(hasProducer);
            await bind(activity, publisher);
            expect(publisher.publish).toHaveBeenLastCalledWith(baseline);
        },
    );

    it('owns only fixed agentRuntime and executionRuns handles with active-over-unknown aggregation', async () => {
        const activity = createSessionRuntimeActivity('supported');
        const publisher = createPublisher();
        await bind(activity, publisher);
        const agent = activity.agentRuntimeContributionHandle;
        if (!agent) throw new Error('supported Activity did not expose its fixed agentRuntime handle');

        await activity.executionRunsContributionHandle.report(activeExecution, 'execution active');
        expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 2 });
        await agent.report(activeAgent, 'agent active');
        expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 3 });
    });

    it('offers the new current-runtime baseline without predecessor state or attach provenance', async () => {
        const activity = createSessionRuntimeActivity('supported');
        const publisher = createPublisher();

        await activity.bindPublisher(publisher);
        expect(publisher.publish).toHaveBeenCalledOnce();
        expect(publisher.publish).toHaveBeenCalledWith({ state: 'unknown', activeCount: 0 });
    });

    it('fences late producer callbacks and closes each replaced publisher once', async () => {
        const activity = createSessionRuntimeActivity('supported');
        const firstPublisher = createPublisher();
        const successorPublisher = createPublisher();
        await bind(activity, firstPublisher);
        const agent = activity.agentRuntimeContributionHandle;
        if (!agent) throw new Error('supported Activity did not expose its fixed agentRuntime handle');
        await agent.report(activeAgent, 'current producer');

        await activity.bindPublisher(successorPublisher);
        expect(firstPublisher.close).toHaveBeenCalledOnce();
        expect(successorPublisher.publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 1 });
        await agent.dispose();
        await agent.dispose();
        expect(() => agent.report(idle, 'late callback')).toThrow(/disposed/i);
        expect(successorPublisher.publish).toHaveBeenCalledOnce();

        await activity.dispose();
        await activity.dispose();
        expect(firstPublisher.close).toHaveBeenCalledOnce();
        expect(successorPublisher.close).toHaveBeenCalledOnce();
    });
});
