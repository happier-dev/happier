import type {
    PluginPermissionCapabilityV1,
    PluginPermissionGrantTargetScopeV1,
    PluginPermissionSubjectV1,
    PluginPermissionGrantV1,
} from "@happier-dev/protocol";

import { resolveDefaultPluginPermissionGrantAuthority } from "./authority";
import { createSqlPluginPermissionGrantStore } from "./storage";

export async function resolveTrustedPluginPermissionGrants(params: Readonly<{
    accountId: string;
    machineId?: string;
    installationId?: string;
    pluginId: string;
    capability: PluginPermissionCapabilityV1;
    targetScope?: PluginPermissionGrantTargetScopeV1 | null;
    subject: PluginPermissionSubjectV1;
}>): Promise<readonly PluginPermissionGrantV1[]> {
    if (!params.targetScope) return [];
    const authority = await resolveDefaultPluginPermissionGrantAuthority({
        accountId: params.accountId,
        machineId: params.machineId,
        installationId: params.installationId,
    });
    if (!authority) {
        return [];
    }
    const store = createSqlPluginPermissionGrantStore();
    const result = await store.list({
        accountId: params.accountId,
        pluginId: params.pluginId,
        capability: params.capability,
        targetScope: params.targetScope,
        subject: params.subject,
        authoritySource: authority.source,
        includeRevoked: false,
        includeResolvedRequests: false,
        limit: 50,
    });
    return result.grants;
}
