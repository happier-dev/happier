import { resolveCurrentClaimablePluginMachineMaterializationTx } from "@/app/plugins/availability/operations";
import type { Tx } from "@/storage/inTx";

import type { ResolvedPluginWebhookTargetV1 } from "./endpointStore";

/**
 * Canonical current-target resolver shared by endpoint lifecycle, endpoint
 * correspondence, and every transaction-scoped consumer. It answers only
 * whether one materialization is currently claimable as a webhook target for
 * this Account; it grants no delivery custody.
 */
export async function resolveCurrentPluginWebhookTargetTxV1(params: Readonly<{
    tx: Tx;
    serverIdentityId: string;
    accountId: string;
    target: ResolvedPluginWebhookTargetV1["materialization"];
}>): Promise<ResolvedPluginWebhookTargetV1 | null> {
    const row = await params.tx.pluginMachineMaterialization.findUnique({
        where: {
            machineId_materializationId: {
                machineId: params.target.machineId,
                materializationId: params.target.materializationId,
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
        || row.pluginId !== params.target.pluginId
        || row.machine.installationId === null
    ) return null;
    const current = await resolveCurrentClaimablePluginMachineMaterializationTx({
        tx: params.tx,
        accountId: params.accountId,
        serverIdentityId: params.serverIdentityId,
        machineId: params.target.machineId,
        machineInstallationId: row.machine.installationId,
        materializationId: params.target.materializationId,
        pluginId: params.target.pluginId,
        version: row.version,
        requiredMachineOperationCapability: "pluginWebhookClaim",
    });
    if (current.kind !== "current") return null;
    return {
        materialization: params.target,
        machineInstallationId: row.machine.installationId,
        pluginVersion: row.version,
    };
}
