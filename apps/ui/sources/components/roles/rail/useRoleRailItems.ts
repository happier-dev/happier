import * as React from 'react';

import { useRoleCatalog, type RoleCatalogState } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { describeRolePurpose } from '@/sync/domains/roles/roleCatalog';

import type { RoleRailItem } from './rolesRailTypes';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { WorkflowRoleV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import type { SessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';

/** The reader's enabled roles as rail rows, read when the rail opens. */
export function useRoleRailItems(
    workflowRoles?: readonly WorkflowRoleV1[],
    serverId?: string | null,
    sessionRoles?: SessionRolesV1,
    forSession = false,
): ReadonlyArray<RoleRailItem> {
    return useRoleRailCatalog(workflowRoles, serverId, sessionRoles, forSession).items;
}

/** A turned-off role is not offered at all; only a role that cannot resolve is "unavailable". */
function isTurnedOff(layer: Readonly<{ enabled?: boolean }> | undefined): boolean {
    return layer?.enabled === false;
}

/**
 * The open picker preserves the catalog's read state instead of calling an unresolved list empty.
 * The Orchestrator is the session it is turned on in (ORC §3.3, lab `editor-G3`), so only a live
 * session's own rail (`forSession`) offers it.
 */
export function useRoleRailCatalog(
    workflowRoles?: readonly WorkflowRoleV1[],
    serverId?: string | null,
    sessionRoles?: SessionRolesV1,
    forSession = false,
): Readonly<{
    items: ReadonlyArray<RoleRailItem>;
    status: RoleCatalogState['status'];
}> {
    const catalog = useRoleCatalog(serverId);
    const presentEngine = useRoleEnginePresentation(serverId);
    const items = React.useMemo(() => [...new Set([
        ...catalog.entries.map(entry => entry.roleId),
        ...Object.keys(sessionRoles?.sessionRoles ?? {}),
        ...(workflowRoles ?? []).map(role => role.roleId),
    ])]
        .flatMap((roleId): RoleRailItem[] => {
            if (roleId === 'orchestrator' && !forSession) return [];
            const entry = catalog.entries.find(candidate => candidate.roleId === roleId);
            const pin = workflowRoles?.find(candidate => candidate.roleId === roleId);
            const sessionRole = sessionRoles?.sessionRoles[roleId];
            const resolved = resolveRoleSelectionV1({ roleId, settingsRoles: entry ? { [roleId]: entry.role } : {},
                settingsOverrides: entry?.override ? { [roleId]: entry.override } : {}, sessionRoles, workflowRoles });
            if (!resolved.ok) {
                if ([entry?.role, sessionRole, pin && 'enabled' in pin ? pin : undefined].some(isTurnedOff)) return [];
                // Still named by whichever layer named it; an id no layer names stays findable as written.
                const name = (pin && 'name' in pin ? pin.name : undefined) ?? sessionRole?.name ?? entry?.role.name ?? roleId;
                return [{ roleId, name, purpose: '', unavailable: 'role' }];
            }
            if (!resolved.selection.enabled) return [];
            const role = resolved.selection;
            const engine = presentEngine(role.engine);
            return [{
                roleId,
                name: role.name,
                purpose: describeRolePurpose(role),
                ...(engine.label ? { engineLabel: engine.label } : {}),
                ...(engine.icon ? { engineIcon: engine.icon } : {}),
                ...(role.engine ? { agentTargetKey: role.engine.agentTargetKey } : {}),
                ...(role.engine && engine.unavailable ? { unavailable: 'engine' as const } : {}),
            }];
        }), [catalog.entries, forSession, presentEngine, sessionRoles, workflowRoles]);
    return React.useMemo(() => ({ items, status: catalog.status }), [items, catalog.status]);
}
