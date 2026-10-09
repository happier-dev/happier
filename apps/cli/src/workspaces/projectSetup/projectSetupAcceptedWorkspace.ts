import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readProjectAccountRows, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';

export type ProjectSetupWorkspaceAddress = Readonly<WorkspaceAddressV1>;

export async function resolveProjectSetupAcceptedWorkspace(input: ProjectAccountRowsInput & Readonly<{
    address: ProjectSetupWorkspaceAddress;
    serverId: string;
    serverHttpBaseUrl: string;
    signal?: AbortSignal;
}>): Promise<Readonly<{ workspace: WorkspaceRefV1; project: Readonly<{ serverId: string; projectId: string }> }>> {
    const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    if (input.address.serverId !== input.serverId) return fail('server_scope_mismatch');
    let snapshot: Awaited<ReturnType<typeof readProjectAccountRows>>;
    try {
        snapshot = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => readProjectAccountRows({
            ...input, serverId: input.serverId,
            ...(input.signal ? { signal: input.signal } : {}),
        }));
    } catch { return fail(input.signal?.aborted ? 'cancelled' : 'project_workspace_unavailable'); }
    const resolved = resolveWorkspaceRefV1(snapshot.workspaceRefs, input.address);
    if (resolved.kind !== 'resolved') {
        const identity = resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId: input.serverId, id: input.address.workspaceId });
        return fail(identity.kind === 'resolved' && identity.ref.projectKey ? 'project_workspace_changed' : 'project_workspace_unavailable');
    }
    const workspace = resolved.ref;
    if (!workspace.projectKey) return fail('project_workspace_unavailable');
    return { workspace, project: { serverId: workspace.serverId, projectId: workspace.projectKey } };
}
