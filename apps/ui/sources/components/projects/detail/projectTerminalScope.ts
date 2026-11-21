import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { resolveWorkspaceRefByAddress, resolveWorkspaceRefById, sameWorkspaceProject } from '@/sync/domains/workspaces/workspaceRefs';
import { parseProjectPaneScopeId } from './projectPaneScope';
import type { DaemonTerminalListEntryV1 } from '@happier-dev/protocol/daemon/terminal';
import type { SessionTerminalMemberV1 } from '@happier-dev/protocol/terminal/workspace';
import * as React from 'react';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

/** Keep Account withdrawal reactive even when the retained terminal is hidden. */
export function useProjectTerminalScope(scopeId: string, selected?: WorkspaceAddressV2): ProjectTerminalScope | null {
    const select = React.useMemo(() => {
        let previous: ProjectTerminalScope | null = null;
        return (state: ReturnType<typeof storage.getState>) => {
            previous = retainDeep(previous, selected ? resolveProjectTerminalScope(scopeId, selected, state) : null);
            return previous;
        };
    }, [scopeId, selected]);
    return storage(select);
}

export type ProjectTerminalScope = Readonly<{
    scope: ServerAccountScope;
    workspace: WorkspaceAddressV2;
    machineId: string;
    lifetime: ActiveServerAccountScopeLifetime;
}>;

/** Presentation/process key qualified by the actual requester and captured checkout. */
export function buildProjectTerminalKey(scope: ServerAccountScope, workspace: WorkspaceAddressV2, terminalId: string): string {
    // The accepted Workspace id names the checkout; its exact root travels in the
    // admitted address and is rechecked by the daemon, not copied into the key budget.
    return ['project-terminal', scope.serverId, scope.accountId, resolveWorkspaceSyncExecutionMachineIdV1(workspace), workspace.workspaceId,
        terminalId].map(encodeURIComponent).join(':');
}

/** One Project member's key: a Shell keeps the checkout it was opened in, else the Project's own. */
export function buildProjectMemberTerminalKey(authority: Pick<ProjectTerminalScope, 'scope' | 'workspace'>, member: SessionTerminalMemberV1): string {
    const workspace = member.target.kind === 'workspace_shell' || member.target.kind === 'terminal_view'
        ? member.target.workspace ?? authority.workspace : authority.workspace;
    return buildProjectTerminalKey(authority.scope, workspace, member.id);
}

/** Decode the producer's own key, then resolve its accepted checkout through the Project owner. */
export function resolveRunningProjectTerminalMember(scopeId: string, authority: ProjectTerminalScope, entry: DaemonTerminalListEntryV1): SessionTerminalMemberV1 | null {
    if (entry.ended) return null;
    const parts = entry.terminalKey.split(':');
    if (parts.length !== 6 || parts[0] !== 'project-terminal') return null;
    let workspaceId: string;
    let memberId: string;
    try { workspaceId = decodeURIComponent(parts[4]); memberId = decodeURIComponent(parts[5]); }
    catch { return null; }
    if (!memberId.trim()) return null;
    const checkout = resolveProjectTerminalScope(scopeId, { ...authority.workspace, workspaceId, rootPath: entry.cwd });
    return checkout && entry.terminalKey === buildProjectTerminalKey(authority.scope, checkout.workspace, memberId)
        ? { id: memberId, target: { kind: 'workspace_shell', workspace: checkout.workspace } } : null;
}

/** Resolve the incumbent pane against the current Account's accepted checkouts, never a path guess. */
export function resolveProjectTerminalScope(scopeId: string, selected?: WorkspaceAddressV2,
    state = storage.getState()): ProjectTerminalScope | null {
    const identity = parseProjectPaneScopeId(scopeId);
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!identity || !lifetime?.isCurrent()
        || !areServerProfileIdentifiersEquivalent(identity.serverId, lifetime.scope.serverId)) return null;
    const rows = readCurrentProjectAccountRows(state);
    if (!rows || rows.status !== 'ready') return null;
    const project = resolveWorkspaceRefById(rows.workspaceRefs, identity.workspaceRefId, identity.serverId);
    if (project.kind !== 'resolved') return null;
    const address = selected ?? workspaceAddressFromRefV2(project.ref);
    const checkout = resolveWorkspaceRefByAddress(rows.workspaceRefs, address);
    if (checkout.kind !== 'resolved' || !sameWorkspaceProject(checkout.ref, project.ref)) return null;
    const workspace = workspaceAddressFromRefV2(checkout.ref);
    return { scope: lifetime.scope, workspace, machineId: resolveWorkspaceSyncExecutionMachineIdV1(workspace), lifetime };
}
