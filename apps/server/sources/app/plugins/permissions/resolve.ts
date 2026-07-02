import type {
    PluginPermissionCapabilityV1,
    PluginPermissionGrantTargetScopeV1,
    PluginPermissionGrantV1,
} from "@happier-dev/protocol";

import {
    authorityDeclaresOptionalCapability,
    resolveDefaultPluginPermissionGrantAuthority,
} from "./authority";
import { createSqlPluginPermissionGrantStore } from "./storage";

export async function resolveTrustedPluginPermissionGrants(params: Readonly<{
    accountId: string;
    machineId?: string;
    pluginId: string;
    capability: PluginPermissionCapabilityV1;
    targetScope?: PluginPermissionGrantTargetScopeV1 | null;
}>): Promise<readonly PluginPermissionGrantV1[]> {
    if (!params.targetScope) return [];
    const authority = await resolveDefaultPluginPermissionGrantAuthority({
        accountId: params.accountId,
        machineId: params.machineId,
        pluginId: params.pluginId,
        capability: params.capability,
        targetScope: params.targetScope,
    });
    if (!authority || authority.pluginId !== params.pluginId || !authorityDeclaresOptionalCapability(authority, params.capability)) {
        return [];
    }
    const store = createSqlPluginPermissionGrantStore();
    const result = await store.list({
        accountId: params.accountId,
        pluginId: params.pluginId,
        capability: params.capability,
        targetScope: params.targetScope,
        authoritySource: authority.source,
        includeRevoked: false,
        includeResolvedRequests: false,
        limit: 50,
    });
    return result.grants;
}

export async function hasTrustedPluginPermissionGrant(params: Readonly<{
    accountId: string;
    machineId?: string;
    pluginId: string;
    capability: PluginPermissionCapabilityV1;
    targetScope?: PluginPermissionGrantTargetScopeV1 | null;
}>): Promise<boolean> {
    return (await resolveTrustedPluginPermissionGrants(params)).length > 0;
}
