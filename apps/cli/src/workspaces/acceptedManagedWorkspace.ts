import { isDeepStrictEqual } from 'node:util';

import { isManagedWorkspaceRefV2, type ManagedWorkspaceRefV2, type WorkspaceAddressV2, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { projectRuntimeAccountRowsInput, readProjectAccountRows, type ProjectAccountRowsInput, type ProjectRuntimeAccountAccess } from './projectAccountRows';

/** A managed ref admits only its exact Home, controller installation, resource and root. */
export function matchesAcceptedManagedWorkspaceRef(
    ref: WorkspaceRefV1 | null | undefined,
    workspace: Extract<WorkspaceAddressV2, { kind: 'managed' }>,
): ref is ManagedWorkspaceRefV2 {
    return ref != null && isManagedWorkspaceRefV2(ref) && isDeepStrictEqual(workspaceAddressFromRefV2(ref), workspace);
}

/** Read the requester's referenced Project row through the existing Account row owner. */
export async function readManagedWorkspaceRefForAddress(
    runtime: ProjectRuntimeAccountAccess & Readonly<{ serverId: string; serverHttpBaseUrl: string }>,
    workspace: Extract<WorkspaceAddressV2, { kind: 'managed' }>,
    signal: AbortSignal,
    scope: 'workspace' | 'project' = 'workspace',
) {
    return await readManagedWorkspaceRefFromRows({
        ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId, signal,
    }, runtime.serverHttpBaseUrl, workspace, scope);
}

async function readManagedWorkspaceRefFromRows(
    rows: ProjectAccountRowsInput,
    serverHttpBaseUrl: string,
    workspace: Extract<WorkspaceAddressV2, { kind: 'managed' }>,
    scope: 'workspace' | 'project' = 'workspace',
) {
    const { workspaceRefs } = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => readProjectAccountRows({
        ...rows,
        selection: scope === 'project'
            ? { kinds: ['workspace-ref'], serverId: workspace.serverId }
            : { key: { kind: 'workspace-ref', serverId: workspace.serverId, id: workspace.workspaceId } },
    }));
    const ref = workspaceRefs.find(candidate => candidate.id === workspace.workspaceId) ?? null;
    return { ref, workspaceRefs };
}

export async function readAcceptedManagedWorkspaceRefFromRows(
    rows: ProjectAccountRowsInput,
    serverHttpBaseUrl: string,
    workspace: Extract<WorkspaceAddressV2, { kind: 'managed' }>,
    scope?: 'workspace' | 'project',
) {
    const { ref, workspaceRefs } = await readManagedWorkspaceRefFromRows(rows, serverHttpBaseUrl, workspace, scope);
    return matchesAcceptedManagedWorkspaceRef(ref, workspace) ? { ref, workspaceRefs } : null;
}

/** Resolve the requester's accepted exact address before any provider access. */
export async function readAcceptedManagedWorkspaceRef(
    runtime: Parameters<typeof readManagedWorkspaceRefForAddress>[0],
    workspace: Parameters<typeof readManagedWorkspaceRefForAddress>[1],
    signal: AbortSignal,
    scope?: Parameters<typeof readManagedWorkspaceRefForAddress>[3],
) {
    return await readAcceptedManagedWorkspaceRefFromRows({
        ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId, signal,
    }, runtime.serverHttpBaseUrl, workspace, scope);
}
