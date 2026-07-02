import type {
    PluginPermissionCapabilityV1,
    PluginPermissionDeclarationV1,
    PluginPermissionGrantAuthoritySourceV1,
    PluginPermissionGrantTargetScopeV1,
} from "@happier-dev/protocol";
import { isReservedHappierPluginId } from "@happier-dev/protocol";

import { createSqlPluginInstallationManifestProjectionStore } from "@/app/plugins/installations/storage";
import { db } from "@/storage/db";

export type PluginPermissionGrantAuthorityRequest = Readonly<{
    accountId: string;
    machineId?: string;
    pluginId: string;
    capability: PluginPermissionCapabilityV1;
    targetScope: PluginPermissionGrantTargetScopeV1;
}>;

export type TrustedPluginPermissionGrantAuthority = Readonly<{
    pluginId: string;
    source: PluginPermissionGrantAuthoritySourceV1;
    optionalPermissions: readonly PluginPermissionDeclarationV1[];
}>;

export type ResolvePluginPermissionGrantAuthority = (
    request: PluginPermissionGrantAuthorityRequest,
) => Promise<TrustedPluginPermissionGrantAuthority | null> | TrustedPluginPermissionGrantAuthority | null;

const REVIEW_COMMENT_DIRECT_WRITE_PERMISSION = Object.freeze({
    capability: "reviews.comments.write.direct",
    reason: "Write approved review comments directly when the user grants direct-write authority.",
} satisfies PluginPermissionDeclarationV1);

const TRUSTED_BUNDLED_PLUGIN_OPTIONAL_PERMISSIONS = new Map<string, readonly PluginPermissionDeclarationV1[]>([
    ["happier.review.coderabbit", [REVIEW_COMMENT_DIRECT_WRITE_PERMISSION]],
    ["happier.review.deepsec", [REVIEW_COMMENT_DIRECT_WRITE_PERMISSION]],
]);

export function isBundledPluginPermissionGrantAuthority(pluginId: string): boolean {
    return TRUSTED_BUNDLED_PLUGIN_OPTIONAL_PERMISSIONS.has(pluginId);
}

export const resolveBundledPluginPermissionGrantAuthority: ResolvePluginPermissionGrantAuthority = (request) => {
    const optionalPermissions = TRUSTED_BUNDLED_PLUGIN_OPTIONAL_PERMISSIONS.get(request.pluginId);
    if (!optionalPermissions) {
        return null;
    }
    return {
        pluginId: request.pluginId,
        source: { kind: "bundled" },
        optionalPermissions,
    };
};

export const resolveDefaultPluginPermissionGrantAuthority: ResolvePluginPermissionGrantAuthority = async (request) => {
    const bundled = resolveBundledPluginPermissionGrantAuthority(request);
    if (bundled) {
        return bundled;
    }
    if (isReservedHappierPluginId(request.pluginId)) {
        return null;
    }
    if (!request.machineId) {
        return null;
    }

    const projection = await createSqlPluginInstallationManifestProjectionStore().getEnabled({
        accountId: request.accountId,
        machineId: request.machineId,
        pluginId: request.pluginId,
    });
    if (!projection) {
        return null;
    }
    const machine = await db.machine.findFirst({
        where: {
            accountId: request.accountId,
            id: projection.machineId,
            revokedAt: null,
            replacedByMachineId: null,
        },
        select: {
            installationId: true,
        },
    });
    if (!machine?.installationId) {
        return null;
    }
    return {
        pluginId: projection.pluginId,
        source: {
            kind: "machine_installation",
            machineId: projection.machineId,
            installationId: machine.installationId,
        },
        optionalPermissions: projection.optionalPermissions,
    };
};

export function authorityDeclaresOptionalCapability(
    authority: TrustedPluginPermissionGrantAuthority,
    capability: PluginPermissionCapabilityV1,
): boolean {
    return authority.optionalPermissions.some((permission) => permission.capability === capability);
}
