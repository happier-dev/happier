import {
    PluginWebhookEndpointCheckCorrespondenceResultV1Schema,
    type PluginWebhookEndpointCheckCorrespondenceInputV1,
    type PluginWebhookEndpointCheckCorrespondenceResultV1,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";

import { resolveCurrentPluginWebhookContributionTxV1 } from "./currentContribution";
import { resolveCurrentPluginWebhookTargetTxV1 } from "./currentTarget";

const UNAVAILABLE = {
    kind: "unavailable",
    code: "endpoint_unavailable",
} as const satisfies PluginWebhookEndpointCheckCorrespondenceResultV1;

/**
 * Sole owner of generic webhook endpoint correspondence.
 *
 * It answers one bounded question inside the caller's transaction: does this
 * exact endpoint still correspond to the declared webhook contribution, the
 * claimed target materialization, the routing source instance, and the setup
 * identity it was ensured with? Both the plugin-surface Action adapter and the
 * present-user Automation durable-push writer consume this owner, so there is
 * no second correspondence decision-maker. Caller authentication stays with
 * each consumer's own principal boundary; correspondence never derives it.
 */
export async function checkCurrentPluginWebhookEndpointCorrespondenceTxV1(params: Readonly<{
    tx: Tx;
    serverIdentityId: string;
    accountId: string;
    input: PluginWebhookEndpointCheckCorrespondenceInputV1;
}>): Promise<PluginWebhookEndpointCheckCorrespondenceResultV1> {
    const { tx, accountId, input } = params;
    try {
        const target = await resolveCurrentPluginWebhookTargetTxV1({
            tx,
            serverIdentityId: params.serverIdentityId,
            accountId,
            target: input.targetMaterialization,
        });
        if (!target) return UNAVAILABLE;
        const contribution = await resolveCurrentPluginWebhookContributionTxV1({
            tx,
            accountId,
            contribution: input.webhookContribution,
            target,
        });
        if (!contribution) return UNAVAILABLE;
        const endpoint = await tx.pluginWebhookEndpoint.findFirst({
            where: {
                id: input.webhookEndpointId,
                accountId,
                pluginId: input.webhookContribution.pluginId,
                webhookContributionId: input.webhookContribution.localId,
                sourceInstanceId: input.sourceInstanceId,
                setupKind: input.setup.kind,
                providerInstallationId: input.setup.kind === "githubSharedInstallationV1"
                    ? input.setup.installationId
                    : null,
                targetMachineId: input.targetMaterialization.machineId,
                targetMaterializationId: input.targetMaterialization.materializationId,
                targetMachineInstallationId: target.machineInstallationId,
                targetPluginVersion: target.pluginVersion,
                handlerActionId: contribution.handlerActionLocalId,
                routingKind: contribution.routingKind,
                enabled: true,
                revokedAt: null,
                route: { enabled: true, revokedAt: null },
            },
            select: { id: true, revision: true },
        });
        return PluginWebhookEndpointCheckCorrespondenceResultV1Schema.parse(endpoint
            ? { kind: "ready", webhookEndpointId: endpoint.id, revision: endpoint.revision }
            : UNAVAILABLE);
    } catch {
        return UNAVAILABLE;
    }
}
