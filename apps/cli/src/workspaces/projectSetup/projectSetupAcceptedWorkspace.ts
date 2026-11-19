import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectWorkspaceRefV1, resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readProjectAccountRows, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';

export type ProjectSetupWorkspaceAddress = Readonly<WorkspaceAddressV1>;
export type ProjectSetupAcceptedAssociation = Readonly<{ workspace: WorkspaceRefV1; project: Readonly<{ serverId: string; projectId: string }> }>;
export type ProjectSetupAcceptedWorkspace = Readonly<{ workspace: WorkspaceRefV1; project: ProjectSetupAcceptedAssociation['project'] | null }>;
type ProjectSetupAcceptedWorkspaceInput = ProjectAccountRowsInput & Readonly<{
    address: Omit<ProjectSetupWorkspaceAddress, 'workspaceId'> & Readonly<{ workspaceId?: string }>;
    serverId: string;
    serverHttpBaseUrl: string;
    signal?: AbortSignal;
}>;

export function resolveProjectSetupAcceptedWorkspace(input: ProjectSetupAcceptedWorkspaceInput & Readonly<{
    allowUnassociated: true;
    allowProjectless: true;
}>): Promise<ProjectSetupAcceptedWorkspace | null>;
export function resolveProjectSetupAcceptedWorkspace(input: ProjectSetupAcceptedWorkspaceInput & Readonly<{
    allowUnassociated: true;
}>): Promise<ProjectSetupAcceptedAssociation | null>;
export function resolveProjectSetupAcceptedWorkspace(input: ProjectAccountRowsInput & Readonly<{
    address: ProjectSetupWorkspaceAddress;
    serverId: string;
    serverHttpBaseUrl: string;
    signal?: AbortSignal;
}>): Promise<ProjectSetupAcceptedAssociation>;
export async function resolveProjectSetupAcceptedWorkspace(input: ProjectSetupAcceptedWorkspaceInput & Readonly<{
    allowUnassociated?: true;
    allowProjectless?: true;
}>): Promise<ProjectSetupAcceptedWorkspace | null> {
    const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    if (!await isServerProfileHomeIdentity(input.serverId, input.address.serverId)) return fail('server_scope_mismatch');
    const homeServerId = await resolveServerProfileHomeIdentityId(input.serverId) ?? input.serverId;
    let workspaceRefs: readonly WorkspaceRefV1[];
    try {
        const binding = input.authorization?.binding;
        const admission = binding?.deploymentPreparationAdmission;
        // Repository Apply signs its scratch checkout census for the portable Home.
        // Ordinary Project reads still include retained qualifiers to detect alias ambiguity.
        const qualifiers = binding && input.address.workspaceId === undefined
            && admission?.operation === 'template' && admission.mode === 'apply' && admission.workspace
            ? [binding.serverIdentityId]
            : [...new Set([input.serverId, homeServerId, input.address.serverId])];
        const snapshots = await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => Promise.all(qualifiers.map(serverId => readProjectAccountRows({
            ...input, serverId: input.serverId,
            selection: input.address.workspaceId
                ? { key: { kind: 'workspace-ref', serverId, id: input.address.workspaceId } }
                : { kinds: ['workspace-ref'], serverId },
            ...(input.signal ? { signal: input.signal } : {}),
        }))));
        workspaceRefs = snapshots.flatMap(snapshot => snapshot.workspaceRefs);
    } catch (error) {
        if (!input.signal?.aborted && input.allowUnassociated && input.address.workspaceId === undefined
            && error instanceof Error && 'code' in error && error.code === 'project_account_rows_unsupported') return null;
        if (input.signal?.aborted) return fail('cancelled');
        throw error;
    }
    const context = { normalizeServerId: (id: string) => id === input.serverId ? homeServerId : id };
    const resolved = resolveWorkspaceRefV1(workspaceRefs, input.address, context);
    if (resolved.kind !== 'resolved') {
        // Only a cold root lookup may discover an ordinary, unassociated folder.
        // A known checkout identity becoming unavailable is still a refusal.
        if (resolved.kind === 'missing' && input.allowUnassociated && input.address.workspaceId === undefined) return null;
        if (input.address.workspaceId === undefined) return fail(resolved.kind === 'ambiguous' ? 'project_workspace_ambiguous' : 'project_workspace_unavailable');
        const identity = resolveWorkspaceRefV1(workspaceRefs, { serverId: input.serverId, id: input.address.workspaceId }, context);
        return fail(identity.kind === 'resolved' ? 'project_workspace_changed' : 'project_workspace_unavailable');
    }
    const workspace = resolved.ref;
    // A cold root lookup only opts into a Project when it already has a stable anchor.
    if (!workspace.projectKey && input.address.workspaceId === undefined) {
        if (input.allowProjectless) return { workspace, project: null };
        if (input.allowUnassociated) return null;
        return fail('project_workspace_unavailable');
    }
    const { serverId, projectKey } = projectWorkspaceRefV1(workspace);
    return { workspace, project: { serverId, projectId: projectKey } };
}
