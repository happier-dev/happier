import { createDeploymentProjectionV1 } from '../projection/deploymentStore.js';
import type { DeploymentReadLeaseV1, DeploymentReadSnapshotV1 } from './deploymentReadControllerTypes.js';

/** A narrow subscriber over the same admitted read, without another loader or timer. */
export function createDeploymentReadFactLeaseV1<T, U>(source: DeploymentReadLeaseV1<T>, select: (value: T) => U): DeploymentReadLeaseV1<U> {
    const projection = createDeploymentProjectionV1();
    const publish = () => {
        const snapshot = source.getSnapshot();
        projection.publish({ ...snapshot, value: snapshot.value === null ? null : select(snapshot.value) });
    };
    publish();
    const unsubscribe = source.subscribe(publish);
    return {
        getSnapshot: () => projection.getSnapshot() as DeploymentReadSnapshotV1<U>,
        subscribe: projection.subscribe,
        refresh: options => source.refresh(options),
        setDemand(demand) { source.setDemand(demand); publish(); },
        release() { unsubscribe(); source.release(); projection.clear(); },
    };
}
