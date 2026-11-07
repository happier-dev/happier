import { resolveCurrentClaimablePluginMachineMaterializationTx, resolveCurrentClaimablePluginMachineMaterializationsTx } from "@/app/plugins/availability/operations";
import type { Tx } from "@/storage/inTx";

import { resolveCurrentPluginWebhookClaimAuthoritiesTxV1 } from "./currentContribution";
import type { ResolvedPluginWebhookContributionV1, ResolvedPluginWebhookTargetV1 } from "./endpointStore";

/** Resolve placement through Availability and the current declaration, once. */
export async function resolveCurrentPluginWebhookRoutingTargetTxV1(params: Readonly<{
    tx: Tx;
    serverIdentityId: string;
    accountId: string;
    routing: Readonly<{ serverIdentityId: string; machineId: string }>;
    contribution: Readonly<{ pluginId: string; localId: string }>;
}>): Promise<Readonly<{
    target: ResolvedPluginWebhookTargetV1;
    contribution: ResolvedPluginWebhookContributionV1;
}> | null> {
    // The HTTP facade supplies this Home from the server identity owner.
    if (params.routing.serverIdentityId !== params.serverIdentityId) return null;
    const machine = await params.tx.machine.findFirst({
        where: { accountId: params.accountId, id: params.routing.machineId },
        select: { installationId: true },
    });
    if (!machine?.installationId) return null;
    const materializations = await resolveCurrentClaimablePluginMachineMaterializationsTx({
        tx: params.tx,
        accountId: params.accountId,
        serverIdentityId: params.serverIdentityId,
        machineId: params.routing.machineId,
        machineInstallationId: machine.installationId,
        pluginId: params.contribution.pluginId,
        requiredMachineOperationCapability: "pluginWebhookClaim",
    });
    const authorities = await resolveCurrentPluginWebhookClaimAuthoritiesTxV1({
        tx: params.tx,
        accountId: params.accountId,
        targets: materializations,
    });
    const authority = authorities.find((candidate) => candidate.contribution.localId === params.contribution.localId);
    if (!authority) return null;
    const materialization = materializations.find((candidate) => candidate.materializationId === authority.materializationId);
    if (!materialization) return null;
    return {
        target: {
            materialization: {
                machineId: materialization.machineId,
                materializationId: materialization.materializationId,
                pluginId: materialization.pluginId,
            },
            machineInstallationId: machine.installationId,
            pluginVersion: materialization.version,
        },
        contribution: authority.contribution,
    };
}

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
