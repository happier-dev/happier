import type { SessionRuntimeActivitySnapshot } from '@happier-dev/protocol';

import { aggregateSessionRuntimeActivityContributions } from './aggregate';
import {
    SessionRuntimeActivityContributionSchema,
    type RuntimeActivityApplicability,
    type RuntimeActivitySlot,
    type SessionRuntimeActivity,
    type SessionRuntimeActivityContribution,
    type SessionRuntimeActivityContributionHandle,
    type SessionRuntimeActivitySnapshotPublisher,
} from './types';

type SlotState = {
    contribution: SessionRuntimeActivityContribution;
    epoch: number;
    disposed: boolean;
};

type PublisherBinding = {
    epoch: number;
    publisher: SessionRuntimeActivitySnapshotPublisher;
};

const IDLE_CONTRIBUTION: SessionRuntimeActivityContribution = Object.freeze({
    state: 'idle',
    activeCount: 0,
});
const UNKNOWN_CONTRIBUTION: SessionRuntimeActivityContribution = Object.freeze({
    state: 'unknown',
    activeCount: 0,
});

export function createSessionRuntimeActivity(
    applicability: RuntimeActivityApplicability,
): SessionRuntimeActivity {
    const slots: Record<RuntimeActivitySlot, SlotState> = {
        agentRuntime: {
            contribution: applicability === 'not_applicable'
                ? IDLE_CONTRIBUTION
                : UNKNOWN_CONTRIBUTION,
            epoch: 0,
            disposed: applicability !== 'supported',
        },
        executionRuns: {
            contribution: IDLE_CONTRIBUTION,
            epoch: 0,
            disposed: false,
        },
    };
    const knownPublishers = new Set<SessionRuntimeActivitySnapshotPublisher>();
    const closedPublishers = new WeakSet<SessionRuntimeActivitySnapshotPublisher>();
    const publisherReofferUnsubscribers = new WeakMap<
        SessionRuntimeActivitySnapshotPublisher,
        () => void
    >();
    let phase: 'active' | 'disposed' = 'active';
    let desiredSnapshot: SessionRuntimeActivitySnapshot = computeDesiredSnapshot();
    let acceptedSnapshot: SessionRuntimeActivitySnapshot | null = null;
    let binding: PublisherBinding | null = null;
    let bindingEpoch = 0;
    let serialTail = Promise.resolve();
    let inFlightBoundaryOperation: Promise<void> | null = null;
    let disposalPromise: Promise<void> | null = null;

    function computeDesiredSnapshot(): SessionRuntimeActivitySnapshot {
        const aggregate = aggregateSessionRuntimeActivityContributions([
            slots.agentRuntime.contribution,
            slots.executionRuns.contribution,
        ]);
        return aggregate;
    }

    const enqueue = (operation: () => Promise<void>): Promise<void> => {
        const result = serialTail.then(async () => {
            const boundaryOperation = operation();
            inFlightBoundaryOperation = boundaryOperation;
            try {
                await boundaryOperation;
            } finally {
                if (inFlightBoundaryOperation === boundaryOperation) {
                    inFlightBoundaryOperation = null;
                }
            }
        });
        serialTail = result.catch(() => {});
        return result;
    };

    const closePublisher = async (publisher: SessionRuntimeActivitySnapshotPublisher): Promise<void> => {
        if (closedPublishers.has(publisher)) return;
        closedPublishers.add(publisher);
        publisherReofferUnsubscribers.get(publisher)?.();
        publisherReofferUnsubscribers.delete(publisher);
        try {
            await publisher.close();
        } finally {
            knownPublishers.delete(publisher);
        }
    };

    const ensureActive = (): void => {
        if (phase === 'disposed') {
            throw new Error('Session runtime activity is disposed');
        }
    };

    const snapshotsEqual = (
        first: SessionRuntimeActivitySnapshot,
        second: SessionRuntimeActivitySnapshot,
    ): boolean => first.state === second.state && first.activeCount === second.activeCount;

    const enqueueSemanticOffer = (
        offeredSnapshot: SessionRuntimeActivitySnapshot,
        epoch: number,
    ): Promise<void> => enqueue(async () => {
        const currentBinding = binding;
        if (phase === 'disposed'
            || currentBinding === null
            || currentBinding.epoch !== epoch
            || bindingEpoch !== epoch
            || (acceptedSnapshot !== null && snapshotsEqual(acceptedSnapshot, offeredSnapshot))) {
            return;
        }
        await currentBinding.publisher.publish(offeredSnapshot);
        acceptedSnapshot = offeredSnapshot;
    });

    const applyContribution = (
        slot: RuntimeActivitySlot,
        handleEpoch: number,
        nextContribution: SessionRuntimeActivityContribution,
    ): Promise<void> => {
        ensureActive();
        const state = slots[slot];
        if (state.disposed || state.epoch !== handleEpoch) {
            throw new Error(`Session runtime activity ${slot} handle is disposed`);
        }
        const parsed = SessionRuntimeActivityContributionSchema.safeParse(nextContribution);
        if (!parsed.success) return Promise.reject(parsed.error);
        state.contribution = Object.freeze({ ...parsed.data });
        desiredSnapshot = computeDesiredSnapshot();
        return binding !== null
            ? enqueueSemanticOffer(desiredSnapshot, bindingEpoch)
            : Promise.resolve();
    };

    const createHandle = (slot: RuntimeActivitySlot): SessionRuntimeActivityContributionHandle => {
        const state = slots[slot];
        const handleEpoch = state.epoch;
        return Object.freeze({
            report: (snapshot) => applyContribution(slot, handleEpoch, snapshot),
            markUnknown: () => applyContribution(slot, handleEpoch, UNKNOWN_CONTRIBUTION),
            dispose: async () => {
                ensureActive();
                if (state.disposed || state.epoch !== handleEpoch) return;
                state.disposed = true;
                state.epoch += 1;
            },
        });
    };

    const agentRuntimeContributionHandle = applicability === 'supported'
        ? createHandle('agentRuntime')
        : null;
    const executionRunsContributionHandle = createHandle('executionRuns');

    return Object.freeze({
        applicability,
        agentRuntimeContributionHandle,
        executionRunsContributionHandle,
        bindPublisher(publisher) {
            ensureActive();
            if (closedPublishers.has(publisher)) {
                throw new Error('Session runtime activity publisher handle is already closed');
            }
            bindingEpoch += 1;
            const requestedEpoch = bindingEpoch;
            const startedOldBoundaryOperation = inFlightBoundaryOperation;
            knownPublishers.add(publisher);

            return enqueue(async () => {
                if (phase === 'disposed' || bindingEpoch !== requestedEpoch) {
                    await closePublisher(publisher);
                    return;
                }
                const oldBinding = binding;
                let firstError: unknown;
                if (startedOldBoundaryOperation !== null) {
                    try {
                        await startedOldBoundaryOperation;
                    } catch (error) {
                        firstError = error;
                    }
                }
                if (oldBinding !== null && oldBinding.publisher !== publisher) {
                    try {
                        await closePublisher(oldBinding.publisher);
                    } catch (error) {
                        firstError ??= error;
                    }
                }
                binding = { epoch: requestedEpoch, publisher };
                const unsubscribeReoffer = publisher.subscribeDesiredReoffer?.(() => enqueue(async () => {
                    const currentBinding = binding;
                    if (phase === 'disposed'
                        || currentBinding?.epoch !== requestedEpoch
                        || currentBinding.publisher !== publisher
                        || bindingEpoch !== requestedEpoch) return;
                    const offeredSnapshot = desiredSnapshot;
                    acceptedSnapshot = null;
                    await publisher.publish(offeredSnapshot);
                    acceptedSnapshot = offeredSnapshot;
                }));
                if (unsubscribeReoffer) {
                    publisherReofferUnsubscribers.set(publisher, unsubscribeReoffer);
                }
                acceptedSnapshot = null;
                try {
                    await publisher.publish(desiredSnapshot);
                    acceptedSnapshot = desiredSnapshot;
                } catch (error) {
                    firstError ??= error;
                }
                if (firstError !== undefined) throw firstError;
            });
        },
        dispose() {
            if (disposalPromise !== null) return disposalPromise;
            phase = 'disposed';
            bindingEpoch += 1;
            slots.agentRuntime.epoch += 1;
            slots.executionRuns.epoch += 1;
            disposalPromise = enqueue(async () => {
                let firstError: unknown;
                for (const publisher of knownPublishers) {
                    try {
                        await closePublisher(publisher);
                    } catch (error) {
                        firstError ??= error;
                    }
                }
                binding = null;
                if (firstError !== undefined) throw firstError;
            });
            return disposalPromise;
        },
    });
}
