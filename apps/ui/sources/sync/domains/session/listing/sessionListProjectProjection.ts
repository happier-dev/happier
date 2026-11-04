import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { areSessionListIndexItemsEqual, buildSessionListIndexNodeId, buildSessionListIndexFromViewData, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { buildSessionListViewData } from './sessionListViewData';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';

/** Complete the open Home's keyless associations through the existing grouping owner. */
export function projectSessionListAcceptedProjects(input: Readonly<{
    source: readonly SessionListIndexItem[];
    workspaceRefs: readonly WorkspaceRefV1[] | undefined;
    censusServerId: string;
    viewerAccountId?: string;
    layoutV1?: 'projects' | 'recent_activity';
    previousIndex?: readonly SessionListIndexItem[] | null;
    resolveSessionRow(serverId: string | null | undefined, sessionId: string): SessionListRenderableSession | null;
}>): readonly SessionListIndexItem[] {
    if (!input.workspaceRefs || !input.censusServerId) return input.source;
    const inHome = (serverId: string | undefined) => Boolean(serverId && areServerProfileIdentifiersEquivalent(serverId, input.censusServerId));
    const resolveProject = createSessionProjectKeyResolverV1(input.workspaceRefs, workspaceRefResolutionContextV1());
    const rows: Record<string, SessionListRenderableSession> = {};
    const executionWorkspaces = new Map<string, Extract<SessionListIndexItem, { type: 'session' }>['workspace']>();
    const machines: Record<string, MachineDisplayRenderable> = {};
    const missing: Array<{ item: Extract<SessionListIndexItem, { type: 'session' }>; header?: Extract<SessionListIndexItem, { type: 'header' }> }> = [];
    const projectsBySessionId = new Map<string, NonNullable<Extract<SessionListIndexItem, { type: 'session' }>['projectKey']>>();
    let changed = false;
    let header: Extract<SessionListIndexItem, { type: 'header' }> | undefined;
    let serverName: string | undefined;
    for (const item of input.source) {
        if (!inHome(item.serverId)) continue;
        serverName ??= item.serverName;
        if (item.type === 'header') {
            if (item.machine) machines[item.machine.id] = item.machine;
            if (item.headerKind !== 'server' && item.headerKind !== 'sessions') header = item;
            continue;
        }
        if (item.type !== 'session') continue;
        executionWorkspaces.set(item.sessionId, item.workspace);
        const row = input.resolveSessionRow(item.serverId, item.sessionId);
        if (!row) { missing.push({ item, header }); continue; }
        rows[row.id] = row;
        if (row.projectKey || item.projectKey) continue;
        const census = admitProjectWorkspaceCensusForSubject({
            subject: { kind: 'session', ownerAccountId: row.ownerAccountId, access: row.access, accessLevel: row.accessLevel },
            rowServerId: item.serverId ?? '', censusServerId: input.censusServerId,
            viewerAccountId: input.viewerAccountId, workspaceRefs: input.workspaceRefs, sessionProjectKeyResolver: resolveProject,
        });
        const result = census.sessionProjectKeyResolver?.(row.metadata, item.serverId ?? '');
        if (result?.kind === 'resolved') {
            projectsBySessionId.set(row.id, result.projectKey);
            if (projectGroupIdentityKey(result.projectKey) !== item.groupKey) changed = true;
        }
    }
    if (!changed) return input.source;
    if (input.layoutV1 === 'recent_activity') {
        const previousById = new Map(input.previousIndex?.map(item => [buildSessionListIndexNodeId(item), item]) ?? []);
        return input.source.map(item => {
            const projectKey = item.type === 'session' && inHome(item.serverId) ? projectsBySessionId.get(item.sessionId) : null;
            if (!projectKey) return item;
            const projected = { ...item, projectKey };
            const previous = previousById.get(buildSessionListIndexNodeId(item));
            return previous && areSessionListIndexItemsEqual(previous, projected) ? previous : projected;
        });
    }
    const rebuilt = buildSessionListIndexFromViewData(buildSessionListViewData(rows, machines, {
        layoutV1: 'projects', workspaceRefs: input.workspaceRefs,
        workspaceRefsServerId: input.censusServerId, viewerAccountId: input.viewerAccountId,
        sessionProjectKeyResolver: resolveProject,
        serverScope: { serverId: input.censusServerId, ...(serverName ? { serverName } : {}) },
    }).map(item => item.type === 'session'
        // Regrouping changes organization identity, never the base producer's execution target.
        ? { ...item, workspace: executionWorkspaces.get(item.session.id) } : item), input.previousIndex ?? input.source) ?? [];
    // Keep unresolved admitted members/frontiers in their existing group, independent of readable bodies.
    const blocks = new Map<string, SessionListIndexItem[]>();
    let key = '';
    for (const item of rebuilt) {
        if (item.type === 'header') key = item.groupKey ?? '';
        const block = blocks.get(key) ?? [];
        block.push(item); blocks.set(key, block);
    }
    for (const entry of missing) {
        const missingKey = entry.item.groupKey ?? '';
        const block = blocks.get(missingKey) ?? (entry.header ? [entry.header] : []);
        block.push(entry.item); blocks.set(missingKey, block);
    }
    const replacement = [...blocks.values()].flat();
    const result: SessionListIndexItem[] = [];
    let inserted = false;
    for (const item of input.source) {
        if (!inHome(item.serverId) || item.type === 'header' && item.headerKind === 'server') { result.push(item); continue; }
        if (!inserted) { result.push(...replacement); inserted = true; }
        if (item.type === 'workflow_run') result.push(item);
    }
    return result;
}
