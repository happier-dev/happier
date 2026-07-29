import type {
    PluginPermissionCapabilityV1,
    PluginPermissionGrantAuthoritySourceV1,
    PluginPermissionGrantTargetScopeV1,
} from "@happier-dev/protocol";
import {
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";

export type PluginPermissionGrantAuthorityRequest = Readonly<{
    accountId: string;
    machineId?: string;
    installationId?: string;
    pluginId: string;
    capability: PluginPermissionCapabilityV1;
    targetScope: PluginPermissionGrantTargetScopeV1;
}>;

export type TrustedPluginPermissionGrantAuthority = Readonly<{
    pluginId: string;
    source: PluginPermissionGrantAuthoritySourceV1;
}>;

export type ResolvePluginPermissionGrantAuthority = (
    request: PluginPermissionGrantAuthorityRequest,
) => Promise<TrustedPluginPermissionGrantAuthority | null> | TrustedPluginPermissionGrantAuthority | null;

export const resolveDefaultPluginPermissionGrantAuthority: ResolvePluginPermissionGrantAuthority = async (request) => {
    if (
        request.capability !== REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1
        || request.targetScope.kind !== "project"
        || !request.machineId
        || !request.installationId
    ) {
        return null;
    }

    const machine = await db.machine.findFirst({
        where: {
            accountId: request.accountId,
            id: request.machineId,
            installationId: request.installationId,
            revokedAt: null,
            replacedByMachineId: null,
        },
        select: {
            installationId: true,
        },
    });
    if (machine?.installationId !== request.installationId) {
        return null;
    }
    return {
        pluginId: request.pluginId,
        source: {
            kind: "machine_installation",
            machineId: request.machineId,
            installationId: machine.installationId,
        },
    };
};
