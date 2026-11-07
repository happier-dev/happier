import type { SessionOrganizationLabel } from '@happier-dev/protocol';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { compareSessionFolderWorkspaceRefs, resolveDurableWorkspaceRefForSessionListHeader, type SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';
import { buildSessionListViewData, type SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionProjectAssignments } from '@/sync/domains/session/organization/projectAssignment';
import { resolveServerWorkspaceDisplay } from '@/sync/domains/session/organization/workspaceDisplay';
import type { SessionProjectMoveTarget } from '../move-sheet/SessionProjectMoveSheet';

/** Called on picker open with the unfiltered server snapshot, independently of collapse/date views. */
export function resolveSessionProjectMoveTargets(params: Readonly<{
    items: readonly SessionListViewItem[];
    serverId: string;
    assignments: SessionProjectAssignments;
    labels: Readonly<Record<string, SessionOrganizationLabel>>;
    currentWorkspace?: SessionFolderWorkspaceRefV1;
}>): SessionProjectMoveTarget[] {
    const sessions: Record<string, SessionListRenderableSession> = {};
    const machines: Record<string, MachineDisplayRenderable> = {};
    for (const item of params.items) {
        if (item.serverId !== params.serverId) continue;
        if (item.type === 'session' && !item.session.owner) sessions[item.session.id] = item.session;
        else if (item.type === 'header' && item.machine) machines[item.machine.id] = item.machine;
    }
    const options = { groupInactiveSessionsByProject: true, sectionModeV1: 'single' as const, serverScope: { serverId: params.serverId } };
    const headers = [
        ...buildSessionListViewData(sessions, machines, options),
        ...buildSessionListViewData(sessions, machines, { ...options, projectAssignmentsBySessionKey: params.assignments }),
    ];
    const targets = new Map<string, SessionProjectMoveTarget>();
    for (const header of headers) {
        if (header.type !== 'header' || header.headerKind !== 'project') continue;
        const workspace = resolveDurableWorkspaceRefForSessionListHeader(header);
        if (workspace?.t !== 'workspaceScope' || !workspace.machineId) continue;
        const id = `${params.serverId}:${header.workspaceKey}`;
        const display = resolveServerWorkspaceDisplay(params.labels, params.serverId, header.workspaceKey);
        targets.set(id, { id, title: display.label ?? header.title,
            subtitle: `${header.subtitle ?? workspace.machineId} · ${workspace.rootPath}`,
            machineId: workspace.machineId, rootPath: workspace.rootPath,
            disabled: Boolean(params.currentWorkspace && compareSessionFolderWorkspaceRefs(params.currentWorkspace, workspace)),
        });
    }
    return [...targets.values()].sort((a, b) => a.title.localeCompare(b.title) || a.subtitle.localeCompare(b.subtitle));
}
