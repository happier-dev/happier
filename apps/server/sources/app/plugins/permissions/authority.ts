import type { PluginPermissionGrantAuthoritySourceV1 } from "@happier-dev/protocol";
import { db } from "@/storage/db";

export type PluginPermissionGrantAuthorityRequest = Readonly<{
    accountId: string;
    machineId?: string;
    installationId?: string;
}>;

export type TrustedPluginPermissionGrantAuthority = Readonly<{
    source: PluginPermissionGrantAuthoritySourceV1;
}>;

export type ResolvePluginPermissionGrantAuthority = (
    request: PluginPermissionGrantAuthorityRequest,
) => Promise<TrustedPluginPermissionGrantAuthority | null> | TrustedPluginPermissionGrantAuthority | null;

export const resolveDefaultPluginPermissionGrantAuthority: ResolvePluginPermissionGrantAuthority = async (request) => {
    if (
        !request.machineId
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
        source: {
            kind: "machine_installation",
            machineId: request.machineId,
            installationId: machine.installationId,
        },
    };
};
