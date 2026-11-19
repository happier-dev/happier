import { isDeepStrictEqual } from 'node:util';

import { isManagedWorkspaceRefV2, type WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { projectRuntimeAccountRowsInput, readProjectAccountRows, type ProjectRuntimeAccountAccess } from './projectAccountRows';

/** Resolve the requester's accepted exact address before any provider access. */
export async function readAcceptedManagedWorkspaceRef(
    runtime: ProjectRuntimeAccountAccess & Readonly<{ serverId: string; serverHttpBaseUrl: string }>,
    workspace: Extract<WorkspaceAddressV2, { kind: 'managed' }>,
    signal: AbortSignal,
    scope: 'workspace' | 'project' = 'workspace',
) {
    const { workspaceRefs } = await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, () => readProjectAccountRows({
        ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId, signal,
        selection: scope === 'project'
            ? { kinds: ['workspace-ref'], serverId: workspace.serverId }
            : { key: { kind: 'workspace-ref', serverId: workspace.serverId, id: workspace.workspaceId } },
    }));
    const ref = workspaceRefs.find(candidate => candidate.id === workspace.workspaceId);
    return ref && isManagedWorkspaceRefV2(ref) && isDeepStrictEqual(workspaceAddressFromRefV2(ref), workspace)
        ? { ref, workspaceRefs } : null;
}
