import type { MachineOperationProtocolCapabilityNameV1 } from "@happier-dev/protocol";

import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { inTx } from "@/storage/inTx";

import { resolveCurrentClaimablePluginMachineMaterializationTx } from "./operations";

export type CurrentPluginMaterializationCallerV1 = Readonly<{
    pluginId: string;
}>;

/**
 * The one owner of "this exact signed caller is the server's current
 * materialization of the plugin it names". Callers compose the verified
 * signed installation publisher identity with the caller-supplied
 * `PluginMachineMaterializationRefV1`; this owner never trusts the caller
 * string by itself — it must name the proven machine, match a durable
 * materialization row of that Account and machine installation, and resolve
 * to the current claimable generation.
 *
 * Webhook daemon delivery and the plugin permission HTTP branch both consume
 * this owner instead of keeping similar-but-different inline copies.
 */
export async function authenticateCurrentPluginMaterializationCallerV1(params: Readonly<{
    accountId: string;
    caller: Readonly<{
        pluginId: string;
        machineId: string;
        materializationId: string;
    }>;
    publisher: Readonly<{ machineId: string; installationId: string }>;
    requiredMachineOperationCapability?: MachineOperationProtocolCapabilityNameV1;
}>): Promise<CurrentPluginMaterializationCallerV1 | null> {
    if (params.caller.machineId !== params.publisher.machineId) return null;
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    return await inTx(async (tx) => {
        const row = await tx.pluginMachineMaterialization.findUnique({
            where: {
                machineId_materializationId: {
                    machineId: params.caller.machineId,
                    materializationId: params.caller.materializationId,
                },
            },
            select: {
                accountId: true,
                pluginId: true,
                version: true,
                machine: { select: { installationId: true } },
            },
        });
        if (
            !row
            || row.accountId !== params.accountId
            || row.pluginId !== params.caller.pluginId
            || row.machine.installationId !== params.publisher.installationId
        ) return null;
        const current = await resolveCurrentClaimablePluginMachineMaterializationTx({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            machineId: params.caller.machineId,
            machineInstallationId: params.publisher.installationId,
            materializationId: params.caller.materializationId,
            pluginId: row.pluginId,
            version: row.version,
            ...(params.requiredMachineOperationCapability
                ? { requiredMachineOperationCapability: params.requiredMachineOperationCapability }
                : {}),
        });
        return current.kind === "current" ? { pluginId: row.pluginId } : null;
    });
}
