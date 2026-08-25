import {
    PluginWebhookEndpointCheckCorrespondenceResultV1Schema,
    type PluginWebhookEndpointCheckCorrespondenceInputV1,
    type PluginWebhookEndpointCheckCorrespondenceResultV1,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";

import { resolveCurrentPluginWebhookContributionTxV1 } from "./currentContribution";
import { resolveCurrentPluginWebhookTargetTxV1 } from "./currentTarget";
import { projectPluginWebhookEndpointBindingAvailabilityV1 } from "./endpointReadiness";

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
 * identity it was ensured with — and is it actually ready to deliver? Both the
 * plugin-surface Action adapter and the present-user Automation durable-push
 * writer consume this owner, so there is no second correspondence
 * decision-maker. Caller authentication stays with each consumer's own
 * principal boundary; correspondence never derives it.
 *
 * Availability comes from the one endpoint binding projection rather than from
 * a query predicate, so a feature connection can never be attached to a
 * revoked, disabled, or no-longer-targetable binding. Whether the user has
 * finished configuring the provider is deliberately not part of this answer:
 * that is setup attention carried by `readiness`, and gating persistence on it
 * would both block first-time authoring behind a delivery that cannot arrive
 * before the Automation exists and, once written, outlive the credential it
 * was observed under.
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
            },
            select: {
                id: true,
                revision: true,
                enabled: true,
                revokedAt: true,
                route: { select: { enabled: true, revokedAt: true } },
            },
        });
        if (!endpoint) return UNAVAILABLE;
        const availability = projectPluginWebhookEndpointBindingAvailabilityV1({
            endpointEnabled: endpoint.enabled,
            endpointRevokedAt: endpoint.revokedAt,
            routeEnabled: endpoint.route.enabled,
            routeRevokedAt: endpoint.route.revokedAt,
            // The resolver above plus the frozen installation/version predicates
            // already proved this endpoint's exact target is claimable now.
            targetStatus: "current",
        });
        return PluginWebhookEndpointCheckCorrespondenceResultV1Schema.parse(availability === "available"
            ? { kind: "ready", webhookEndpointId: endpoint.id, revision: endpoint.revision }
            : UNAVAILABLE);
    } catch {
        return UNAVAILABLE;
    }
}
