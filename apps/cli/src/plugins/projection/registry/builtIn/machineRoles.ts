import { isDeepStrictEqual } from 'node:util';
import { machineRoleCatalogFromPluginsV1, resolveActiveMachineRolesV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';

import type { ResolvedMachineRoleContribution, ResolvedPluginEnablement } from '../types';

/**
 * The daemon's applied Machine role set (P03-ROLES-POLICY `MachineRolesRuntime`), bound once by
 * the daemon. Only the daemon runs plugin daemon entries and background services, so other
 * processes have no binding and keep every plugin's activation as before.
 */
let readAppliedMachineRoles: (() => unknown) | null = null;

/** Returns the release; a later binding replaces an earlier one. */
export function bindMachineRoleAdmission(read: () => unknown): () => void {
    readAppliedMachineRoles = read;
    return () => {
        if (readAppliedMachineRoles === read) readAppliedMachineRoles = null;
    };
}

/**
 * Folds plugin `machineRoles` into the bundled admission fact: `inactiveMachineRoleIds` lists the
 * plugin's roles that are off on this Machine. The plugin stays admitted (Actions, notifications, UI
 * and its roles still list); the activation owner never starts those roles' background services and
 * does not activate the plugin automatically for them. The one decision is
 * `resolveActiveMachineRolesV1` over the admitted (summary) declarations.
 */
export function applyMachineRoleAdmission(params: Readonly<{
    pluginEnablementById: Readonly<Record<string, ResolvedPluginEnablement>>;
    machineRoles: readonly ResolvedMachineRoleContribution[];
}>): Readonly<Record<string, ResolvedPluginEnablement>> {
    const read = readAppliedMachineRoles;
    if (!read || params.machineRoles.length === 0) return params.pluginEnablementById;
    const declarations = params.machineRoles.map(entry => ({ pluginId: entry.pluginId, declaration: entry.definition }));
    const active = resolveActiveMachineRolesV1(read(), machineRoleCatalogFromPluginsV1(declarations));
    const roleIdsByPluginId = new Map<string, string[]>();
    for (const { pluginId, declaration } of declarations) {
        roleIdsByPluginId.set(pluginId, [...roleIdsByPluginId.get(pluginId) ?? [], `${pluginId}/${declaration.id}`]);
    }
    let next: Record<string, ResolvedPluginEnablement> | null = null;
    for (const [pluginId, roleIds] of roleIdsByPluginId) {
        const fact = params.pluginEnablementById[pluginId];
        if (!fact?.enabled) continue;
        const { inactiveMachineRoleIds: _previous, ...base } = fact;
        const inactive = roleIds.filter(id => !active.has(id)).sort();
        const updated: ResolvedPluginEnablement = inactive.length === 0
            ? base : { ...base, inactiveMachineRoleIds: Object.freeze(inactive) };
        if (isDeepStrictEqual(updated, fact)) continue;
        next ??= { ...params.pluginEnablementById };
        next[pluginId] = Object.freeze(updated);
    }
    return next ? Object.freeze(next) : params.pluginEnablementById;
}
