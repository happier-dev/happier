import * as React from 'react';
import type { DeploymentReadSnapshotV1, DeploymentActivityV1 } from '@happier-dev/deployments';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useDeploymentAccountController } from '@/components/projects/deployments/useDeploymentProject';
import { useDeploymentActivity } from '@/components/projects/deployments/useDeploymentReads';

export type DeploymentDestinationSignalValue = Readonly<{
    kind: 'deploymentAttentionCount';
    /** Missing on boolean-only peers; never count a partial Environment page. */
    count: number | null;
    snapshot: DeploymentReadSnapshotV1<DeploymentActivityV1>;
    refresh(): Promise<void>;
}>;

/** One shared Account activity lease for Projects and deployment destination badge leaves. */
export function useDeploymentDestinationSignal(presented: boolean): DeploymentDestinationSignalValue {
    const lifetime = useActiveServerAccountScopeLifetime();
    const demand = React.useMemo(() => ({ mounted: true, visible: presented, focused: presented }), [presented]);
    const controller = useDeploymentAccountController(lifetime, true, demand);
    const read = useDeploymentActivity(controller, demand);
    return React.useMemo(() => ({ kind: 'deploymentAttentionCount',
        count: read.snapshot.value?.attentionCount ?? null, snapshot: read.snapshot, refresh: read.refresh,
    }), [read.snapshot, read.refresh]);
}
