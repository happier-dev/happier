import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/contracts/v1';
import type { DeploymentReadDemandV1, DeploymentReadSnapshotV1 } from '@happier-dev/deployments';
import { useDeploymentNoticeHeaders } from '@/hooks/inbox/useDeploymentNoticeHeaders';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';

export type EnvironmentHealthNotices = Readonly<{
    status: 'idle' | 'loading' | 'ready' | 'partial' | 'unavailable';
    /** Condition activity at publication time, never the current Service health authority. */
    items: readonly AccountNoticeArtifact[];
    retry(): void;
}>;
/** Publication-time conditions for the selected Environment. */
export function useEnvironmentHealthNotices(scope: ServerAccountScope | null, environmentId: string | null,
    read: DeploymentReadSnapshotV1<DeploymentEnvironmentDetailV1>, demand: DeploymentReadDemandV1): EnvironmentHealthNotices {
    const active = demand.mounted && demand.visible && demand.focused;
    const readable = read.value !== null;
    const { items, membership, failed, retry } = useDeploymentNoticeHeaders(scope, environmentId, active && readable);
    const status = !active ? 'idle' : read.status === 'unavailable' || failed ? 'unavailable'
        : !readable ? 'loading' : membership === 'idle' ? 'unavailable' : membership;
    return { status, items, retry };
}
