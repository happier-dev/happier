import * as React from 'react';
import type { DeploymentReadControllerV1, DeploymentReadDemandV1, DeploymentReadLeaseV1, DeploymentReadSnapshotV1,
    DeploymentReadPageFactsV1, DeploymentReadPageLeaseV1, DeploymentCollectionQueryV1 } from '@happier-dev/deployments';

const IDLE = Object.freeze({ status: 'idle' as const, value: null, failure: null });
const INACTIVE = Object.freeze({ mounted: false, visible: false, focused: false });

/** The controller spends private continuation state only for explicit navigation intent. */
function useDeploymentPage<T extends DeploymentReadPageFactsV1>(
    acquire: (() => DeploymentReadPageLeaseV1<T>) | null, demand: DeploymentReadDemandV1,
) {
    const lease = useDeploymentLeaseBinding(acquire);
    const read = useDeploymentSnapshot<T>(lease, demand);
    const nextPage = React.useCallback(() => lease?.nextPage(), [lease]);
    const previousPage = React.useCallback(() => lease?.previousPage(), [lease]);
    return { ...read, hasNextPage: read.snapshot.status === 'ready' && (read.snapshot.value?.hasNextPage ?? false),
        hasPreviousPage: read.snapshot.value?.hasPreviousPage ?? false, nextPage, previousPage };
}

function useDeploymentLeaseBinding<L extends DeploymentReadLeaseV1<unknown>>(acquire: (() => L) | null) {
    const [binding, setBinding] = React.useState<Readonly<{
        acquire: typeof acquire; lease: L | null;
    }> | null>(null);
    // Acquire only after commit: abandoned/StrictMode renders own no demand.
    React.useEffect(() => {
        const lease = acquire?.() ?? null;
        setBinding({ acquire, lease });
        return () => { lease?.release(); };
    }, [acquire]);
    // A changed resource cannot briefly disclose the previous resource's body.
    return binding?.acquire === acquire ? binding.lease : null;
}

/** React owns presentation demand; the shared controller owns all records and reads. */
function useDeploymentSnapshot<T>(lease: DeploymentReadLeaseV1<T> | null, demand: DeploymentReadDemandV1) {
    React.useEffect(() => {
        lease?.setDemand({ mounted: demand.mounted, visible: demand.visible, focused: demand.focused });
        return () => { lease?.setDemand(INACTIVE); };
    }, [lease, demand.mounted, demand.visible, demand.focused]);
    const subscribe = React.useCallback((listener: () => void) => lease?.subscribe(listener) ?? (() => {}), [lease]);
    const getSnapshot = React.useCallback((): DeploymentReadSnapshotV1<T> => lease?.getSnapshot() ?? IDLE, [lease]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const refresh = React.useCallback(() => lease?.refresh({ supersede: true }) ?? Promise.resolve(), [lease]);
    return { snapshot, refresh };
}

function useDeploymentLease<T>(acquire: (() => DeploymentReadLeaseV1<T>) | null, demand: DeploymentReadDemandV1) {
    return useDeploymentSnapshot(useDeploymentLeaseBinding(acquire), demand);
}

export function useDeploymentCollection(controller: DeploymentReadControllerV1 | null, demand: DeploymentReadDemandV1,
    query: DeploymentCollectionQueryV1 = {}) {
    const environmentIds = query.environmentIds === undefined ? undefined : [...new Set(query.environmentIds)].sort();
    const environmentIdsKey = JSON.stringify(environmentIds);
    const previewPullRequestIds = query.previewPullRequestIds === undefined ? undefined : [...new Set(query.previewPullRequestIds)].sort();
    const previewPullRequestIdsKey = JSON.stringify(previewPullRequestIds);
    const acquire = React.useMemo(() => controller ? () =>
        controller.acquireCollection({ cursor: query.cursor, machineId: query.machineId, environmentIds,
            previewRepositoryId: query.previewRepositoryId, previewPullRequestIds,
            previewTemplateEnvironmentId: query.previewTemplateEnvironmentId }, INACTIVE) : null,
        // The canonical set key preserves the lease across equivalent inline vectors.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [controller, query.cursor, query.machineId, environmentIdsKey, query.previewRepositoryId, previewPullRequestIdsKey,
            query.previewTemplateEnvironmentId]);
    return useDeploymentPage(acquire, demand);
}
