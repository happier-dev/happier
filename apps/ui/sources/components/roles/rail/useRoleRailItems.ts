import * as React from 'react';

import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleEnginePresentation } from '@/components/roles/catalog/useRoleEnginePresentation';
import { describeRolePurpose } from '@/sync/domains/roles/roleCatalog';

import type { RoleRailItem } from './rolesRailTypes';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import type { WorkflowRoleV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';

/** The reader's enabled roles as rail rows, read when the rail opens. */
export function useRoleRailItems(workflowRoles?: readonly WorkflowRoleV1[], serverId?: string | null): ReadonlyArray<RoleRailItem> {
    const catalog = useRoleCatalog(serverId);
    const presentEngine = useRoleEnginePresentation(serverId);
    return React.useMemo(() => [...new Set([...catalog.entries.map(entry => entry.roleId), ...(workflowRoles ?? []).map(role => role.roleId)])]
        .flatMap((roleId) => {
            const entry = catalog.entries.find(candidate => candidate.roleId === roleId);
            const resolved = resolveRoleSelectionV1({ roleId, settingsRoles: entry ? { [roleId]: entry.role } : {},
                settingsOverrides: entry?.override ? { [roleId]: entry.override } : {}, workflowRoles });
            if (!resolved.ok || !resolved.selection.enabled) return [];
            const role = resolved.selection;
            const engine = presentEngine(role.engine);
            return {
                roleId,
                name: role.name,
                purpose: describeRolePurpose(role),
                ...(engine.label ? { engineLabel: engine.label } : {}),
                ...(engine.icon ? { engineIcon: engine.icon } : {}),
                ...(role.engine ? { agentTargetKey: role.engine.agentTargetKey } : {}),
            };
        }), [catalog.entries, presentEngine, workflowRoles]);
}
