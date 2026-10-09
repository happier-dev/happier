import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { resolveWorkspaceRefByAddress, resolveWorkspaceRefById, sameWorkspaceProject } from '@/sync/domains/workspaces/workspaceRefs';
import { parseProjectPaneScopeId } from './projectPaneScope';

export type ProjectTerminalScope = Readonly<{
    scope: ServerAccountScope;
    workspace: WorkspaceAddressV1;
    lifetime: ActiveServerAccountScopeLifetime;
}>;

/** Presentation/process key qualified by the actual requester and captured checkout. */
export function buildProjectTerminalKey(scope: ServerAccountScope, workspace: WorkspaceAddressV1, terminalId: string): string {
    // The accepted Workspace id names the checkout; its exact root travels in the
    // admitted address and is rechecked by the daemon, not copied into the key budget.
    return ['project-terminal', scope.serverId, scope.accountId, workspace.machineId, workspace.workspaceId,
        terminalId].map(encodeURIComponent).join(':');
}

/** Resolve the incumbent pane against the current Account's accepted checkouts, never a path guess. */
export function resolveProjectTerminalScope(scopeId: string, selected?: WorkspaceAddressV1): ProjectTerminalScope | null {
    const identity = parseProjectPaneScopeId(scopeId);
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!identity || !lifetime?.isCurrent()
        || !areServerProfileIdentifiersEquivalent(identity.serverId, lifetime.scope.serverId)) return null;
    const rows = readCurrentProjectAccountRows(storage.getState());
    if (!rows || rows.status !== 'ready') return null;
    const project = resolveWorkspaceRefById(rows.workspaceRefs, identity.workspaceRefId, identity.serverId);
    if (project.kind !== 'resolved') return null;
    const address = selected ?? { serverId: project.ref.serverId, workspaceId: project.ref.id,
        machineId: project.ref.machineId, rootPath: project.ref.rootPath };
    const checkout = resolveWorkspaceRefByAddress(rows.workspaceRefs, address);
    if (checkout.kind !== 'resolved' || !sameWorkspaceProject(checkout.ref, project.ref)) return null;
    return { scope: lifetime.scope, workspace: { serverId: checkout.ref.serverId, workspaceId: checkout.ref.id,
        machineId: checkout.ref.machineId, rootPath: checkout.ref.rootPath }, lifetime };
}
