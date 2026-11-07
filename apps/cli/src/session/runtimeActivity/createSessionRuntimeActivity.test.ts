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

    it('aggregates an in-flight turn as active with no provider tasks and no execution runs', async () => {
        const activity = createSessionRuntimeActivity('not_applicable');
        const publisher = createPublisher();
        await bind(activity, publisher);
        expect(publisher.publish).toHaveBeenLastCalledWith(idle);

        await activity.turnActivityContributionHandle.report(
            { state: 'active', activeCount: 1 },
            'turn started',
        );

        expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 1 });
    });

    it('returns to idle once the in-flight turn ends and the other slots are idle', async () => {
        const activity = createSessionRuntimeActivity('not_applicable');
        const publisher = createPublisher();
        await bind(activity, publisher);
        await activity.turnActivityContributionHandle.report(
            { state: 'active', activeCount: 1 },
            'turn started',
        );

        await activity.turnActivityContributionHandle.report(idle, 'turn ended');

        expect(publisher.publish).toHaveBeenLastCalledWith(idle);
    });

    it('lets an active turn win over an unknown agent-runtime contribution', async () => {
        const activity = createSessionRuntimeActivity('supported');
        const publisher = createPublisher();
        await bind(activity, publisher);
        expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'unknown', activeCount: 0 });

        await activity.turnActivityContributionHandle.report(
            { state: 'active', activeCount: 1 },
            'turn started',
        );

        expect(publisher.publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 1 });
    });

    it('fences the turnActivity handle like the other fixed slots at disposal', async () => {
        const activity = createSessionRuntimeActivity('supported');
        const publisher = createPublisher();
        await bind(activity, publisher);
        const turn = activity.turnActivityContributionHandle;

        await turn.dispose();
        await turn.dispose();
        expect(() => turn.report(idle, 'late turn callback')).toThrow(/disposed/i);

        await activity.dispose();
        await activity.dispose();
        expect(publisher.close).toHaveBeenCalled();
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
