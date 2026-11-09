import { PluginWebhookEndpointCheckCorrespondenceResultV1Schema, type PluginWebhookEndpointCheckCorrespondenceInputV1, type PluginWebhookEndpointCheckCorrespondenceResultV1, type PluginWebhookEndpointSetupV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';

import type { Tx } from "@/storage/inTx";

import { resolveCurrentPluginWebhookContributionTxV1 } from "./currentContribution";
import { resolveCurrentPluginWebhookTargetTxV1 } from "./currentTarget";
import { createPluginWebhookCheckIdDigestV1 } from "./checkIdDigest";
import { projectPluginWebhookEndpointBindingAvailabilityV1, projectPluginWebhookEndpointReadinessV1 } from "./endpointReadiness";

const UNAVAILABLE = {
    kind: "unavailable",
    code: "endpoint_unavailable",
} as const satisfies PluginWebhookEndpointCheckCorrespondenceResultV1;

/**
 * The one predicate for "this endpoint row is the one that controller intent
 * names", independent of where the endpoint currently delivers.
 *
 * Correspondence and target convergence both need it and must never diverge on
 * it: correspondence adds the current-target predicates below, while
 * convergence deliberately omits them because the whole point of a move is
 * that the endpoint is not at the desired target yet. Keeping the shared facts
 * here is what stops a mutation from proving a weaker identity than a read.
 */
export function pluginWebhookEndpointControllerCorrespondenceWhereV1(params: Readonly<{
    accountId: string;
    webhookEndpointId: string;
    webhookContribution: Readonly<{ pluginId: string; localId: string }>;
    sourceInstanceId: string;
    setup: PluginWebhookEndpointSetupV1;
    contribution: Readonly<{ handlerActionLocalId: string | null; routingKind: string }>;
}>) {
    return {
        id: params.webhookEndpointId,
        accountId: params.accountId,
        pluginId: params.webhookContribution.pluginId,
        webhookContributionId: params.webhookContribution.localId,
        sourceInstanceId: params.sourceInstanceId,
        setupKind: params.setup.kind,
        checkId: params.setup.kind === "capabilityUrlV1" ? params.setup.checkId : "",
        checkIdDigest: createPluginWebhookCheckIdDigestV1(params.setup.kind === "capabilityUrlV1" ? params.setup.checkId : ""),
        providerInstallationId: params.setup.kind === "githubSharedInstallationV1"
            ? params.setup.installationId
            : null,
        handlerActionId: params.contribution.handlerActionLocalId,
        routingKind: params.contribution.routingKind,
    };
}

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
                ...pluginWebhookEndpointControllerCorrespondenceWhereV1({
                    accountId,
                    webhookEndpointId: input.webhookEndpointId,
                    webhookContribution: input.webhookContribution,
                    sourceInstanceId: input.sourceInstanceId,
                    setup: input.setup,
                    contribution,
                }),
                targetMachineId: input.targetMaterialization.machineId,
                targetMaterializationId: input.targetMaterialization.materializationId,
                targetMachineInstallationId: target.machineInstallationId,
                targetPluginVersion: target.pluginVersion,
            },
            select: {
                id: true,
                revision: true,
                enabled: true,
                revokedAt: true,
                providerConfirmedAt: true,
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
            ? {
                kind: "ready", webhookEndpointId: endpoint.id, revision: endpoint.revision,
                // The exact query above proves these nonsecret endpoint facts.
                // Returning them preserves the monitor's own binding checks
                // without granting it present-user endpoint administration.
                contribution: input.webhookContribution,
                targetMaterialization: input.targetMaterialization,
                sourceInstanceId: input.sourceInstanceId,
                ...(endpoint.revokedAt ? { revokedAt: endpoint.revokedAt.getTime() } : {}),
                readiness: projectPluginWebhookEndpointReadinessV1({
                    endpointEnabled: endpoint.enabled,
                    endpointRevokedAt: endpoint.revokedAt,
                    routeEnabled: endpoint.route.enabled,
                    routeRevokedAt: endpoint.route.revokedAt,
                    targetStatus: "current",
                    providerConfirmedAt: endpoint.providerConfirmedAt,
                    oneTimeCredentialDisclosureLost: false,
                    receiptOnly: input.setup.kind === "capabilityUrlV1",
                }),
            }
            : UNAVAILABLE);
    } catch {
        return UNAVAILABLE;
    }
}
