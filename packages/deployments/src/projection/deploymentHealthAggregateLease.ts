import type { DeploymentEnvironmentHealthAggregateV1 } from '@happier-dev/deployment-protocol/v1';
import { projectDeploymentHealthAggregateV1 } from './deploymentHealthAggregate.js';
import { createDeploymentProjectionV1 } from './deploymentStore.js';

/** Complete current owner facts; acquisition and cross-call ordering stay with the observer. */
export type DeploymentHealthAggregateSnapshotV1 = Parameters<typeof projectDeploymentHealthAggregateV1>[0];

/** One Environment/runtime-link fact consumed by the read carrier and P50 C1 adapter. */
export type DeploymentHealthAggregateLeaseV1 = Readonly<{
    snapshot(): DeploymentEnvironmentHealthAggregateV1;
    observe(listener: (aggregate: DeploymentEnvironmentHealthAggregateV1) => void): Readonly<{ dispose(): void }>;
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
    adopt(snapshot: DeploymentHealthAggregateSnapshotV1): void;
    dispose(): void;
}>;

/** Lifecycle around the canonical projector and existing keyed publication owner. No acquisition or timer. */
export function createDeploymentHealthAggregateLeaseV1(input: Readonly<{
    initial: DeploymentHealthAggregateSnapshotV1;
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>): DeploymentHealthAggregateLeaseV1 {
    const projection = createDeploymentProjectionV1();
    const retirement = new AbortController();
    const retirementSignal = AbortSignal.any([input.retirementSignal, retirement.signal]);
    const subscriptions = new Set<() => void>();
    const initial = input.initial;
    projection.publish({ status: 'ready', value: projectDeploymentHealthAggregateV1(initial), failure: null });
    const snapshot = () => projection.getSnapshot().value as DeploymentEnvironmentHealthAggregateV1;
    const dispose = () => {
        retirement.abort();
        for (const unsubscribe of subscriptions) unsubscribe();
        subscriptions.clear();
        input.retirementSignal.removeEventListener('abort', dispose);
    };
    const isCurrent = () => {
        if (retirementSignal.aborted) return false;
        if (!input.isCurrent()) { dispose(); return false; }
        return true;
    };
    input.retirementSignal.addEventListener('abort', dispose, { once: true });
    if (input.retirementSignal.aborted) dispose();
    return {
        snapshot, isCurrent, retirementSignal, dispose,
        observe(listener) {
            if (!isCurrent()) return { dispose() {} };
            const unsubscribe = projection.subscribe(() => { if (isCurrent()) listener(snapshot()); });
            subscriptions.add(unsubscribe);
            listener(snapshot());
            return { dispose() { subscriptions.delete(unsubscribe); unsubscribe(); } };
        },
        adopt(next) {
            if (!isCurrent()) return;
            if (next.environment.id !== initial.environment.id || next.environment.serverId !== initial.environment.serverId
                || next.environment.projectSourceId !== initial.environment.projectSourceId || next.targetLink.id !== initial.targetLink.id) {
                throw new Error('deployment_health_scope_mismatch');
            }
            const aggregate = projectDeploymentHealthAggregateV1(next, snapshot());
            projection.publish({ status: 'ready', value: aggregate, failure: null });
        },
    };
}
