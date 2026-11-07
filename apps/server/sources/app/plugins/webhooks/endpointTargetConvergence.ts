import { PluginWebhookEndpointConvergeTargetResultV1Schema, type PluginWebhookEndpointConvergeTargetInputV1, type PluginWebhookEndpointConvergeTargetResultV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';

import type { Tx } from "@/storage/inTx";

import { markPluginWebhookAccountChangedInTxV1 } from "./accountChange";
import { resolveCurrentPluginWebhookContributionTxV1 } from "./currentContribution";
import { resolveCurrentPluginWebhookRoutingTargetTxV1, resolveCurrentPluginWebhookTargetTxV1 } from "./currentTarget";
import { pluginWebhookEndpointControllerCorrespondenceWhereV1 } from "./endpointCorrespondence";
import { projectPluginWebhookEndpointBindingAvailabilityV1 } from "./endpointReadiness";

const UNAVAILABLE = {
    kind: "unavailable",
    code: "endpoint_unavailable",
} as const satisfies PluginWebhookEndpointConvergeTargetResultV1;

/**
 * Sole owner of plugin-driven generic webhook endpoint target convergence.
 *
 * A feature owner such as Channels holds a durable connection authority that
 * already names where an endpoint it owns must deliver. Moving the endpoint
 * there is not present-user administration and cannot be expressed by the two
 * incumbent operations: `checkCorrespondence` observes and never mutates, and
 * present-user `retarget` needs a present user plus an expected endpoint
 * revision the feature owner has no authority over — an unrelated credential
 * rotation or administration write moves that revision and turns a correct
 * retry into a permanent conflict.
 *
 * This operation therefore replaces the read → retarget → recheck chain with
 * one transaction that proves exactly what the feature owner can prove and
 * orders the move by the controller's own intent epoch:
 *
 * - the endpoint must still correspond to the declared contribution, source
 *   instance, stable setup identity, verifier/routing kind, and handler that
 *   its controller ensured it with, and must still be usable (enabled, not
 *   revoked, on a live route);
 * - the desired target must resolve as a current claimable materialization of
 *   that same contribution for this Account;
 * - a strictly lower intent epoch is refused as `superseded`, so a late retry
 *   of a transfer that a newer transfer already replaced can never drag
 *   delivery back to a retired target;
 * - an equal epoch already at the desired target is an observational rejoin
 *   with no write, which is what makes a lost response safe to retry;
 * - anything else advances the endpoint atomically under its observed
 *   revision.
 *
 * Deliberately absent: the endpoint's *current* target is never required to be
 * resolvable. The reason a controller converges is usually that the machine it
 * used to point at is gone, and requiring the retired placement to still be
 * current would make exactly that case unrepairable. Present-user `retarget`
 * remains the only way to move an endpoint to a target its controller intent
 * does not name.
 */
export async function convergeCurrentPluginWebhookEndpointTargetTxV1(params: Readonly<{
    tx: Tx;
    serverIdentityId: string;
    accountId: string;
    input: PluginWebhookEndpointConvergeTargetInputV1;
}>): Promise<PluginWebhookEndpointConvergeTargetResultV1> {
    const { tx, accountId, input } = params;
    const routingTarget = "desiredTargetRouting" in input ? await resolveCurrentPluginWebhookRoutingTargetTxV1({
        tx,
        serverIdentityId: params.serverIdentityId,
        accountId,
        routing: input.desiredTargetRouting,
        contribution: input.webhookContribution,
    }) : null;
    const target = "desiredTargetMaterialization" in input ? await resolveCurrentPluginWebhookTargetTxV1({
        tx,
        serverIdentityId: params.serverIdentityId,
        accountId,
        target: input.desiredTargetMaterialization,
    }) : routingTarget?.target;
    if (!target) return UNAVAILABLE;
    const contribution = routingTarget?.contribution ?? await resolveCurrentPluginWebhookContributionTxV1({
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
            route: { verifierKind: contribution.verifierKind },
        },
        select: {
            id: true,
            revision: true,
            enabled: true,
            revokedAt: true,
            releasedAt: true,
            targetIntentEpoch: true,
            targetMachineId: true,
            targetMachineInstallationId: true,
            targetMaterializationId: true,
            targetPluginVersion: true,
            route: { select: { enabled: true, revokedAt: true } },
        },
    });
    if (!endpoint || endpoint.releasedAt !== null) return UNAVAILABLE;
    // The desired target was just proved claimable, so the only availability
    // question left is whether the binding itself may still deliver at all.
    const availability = projectPluginWebhookEndpointBindingAvailabilityV1({
        endpointEnabled: endpoint.enabled,
        endpointRevokedAt: endpoint.revokedAt,
        routeEnabled: endpoint.route.enabled,
        routeRevokedAt: endpoint.route.revokedAt,
        targetStatus: "current",
    });
    if (availability !== "available") return UNAVAILABLE;

    const currentIntentEpoch = endpoint.targetIntentEpoch;
    if (currentIntentEpoch !== null && currentIntentEpoch > input.targetIntentEpoch) {
        return PluginWebhookEndpointConvergeTargetResultV1Schema.parse({
            kind: "superseded",
            webhookEndpointId: endpoint.id,
            currentTargetIntentEpoch: currentIntentEpoch,
        });
    }

    const alreadyAtDesiredTarget = endpoint.targetMachineId === target.materialization.machineId
        && endpoint.targetMaterializationId === target.materialization.materializationId
        && endpoint.targetMachineInstallationId === target.machineInstallationId
        && endpoint.targetPluginVersion === target.pluginVersion;
    if (currentIntentEpoch === input.targetIntentEpoch && alreadyAtDesiredTarget) {
        // The exact intent this request carries is already satisfied. A lost
        // response replays these same bytes and rejoins the authoritative
        // state instead of writing a second revision.
        return PluginWebhookEndpointConvergeTargetResultV1Schema.parse({
            kind: "converged",
            webhookEndpointId: endpoint.id,
            revision: endpoint.revision,
            targetMaterialization: target.materialization,
            targetIntentEpoch: input.targetIntentEpoch,
        });
    }
    if (currentIntentEpoch === input.targetIntentEpoch
        && !("desiredTargetRouting" in input && endpoint.targetMachineId === target.materialization.machineId)) {
        // One controller epoch names exactly one desired target. Reusing that
        // epoch for another Machine or exact materialization is not a retry.
        // Routing intent owns the Machine, so a new current installation on
        // that same Machine is a refresh of the same desired placement.
        return UNAVAILABLE;
    }

    const updated = await tx.pluginWebhookEndpoint.updateMany({
        where: { id: endpoint.id, accountId, revision: endpoint.revision },
        data: {
            // Retained rows keep their frozen target; the bounded
            // `delivery.movePending` operation is still the only way to move
            // an already-admitted row. It selects by difference from the
            // endpoint's current target rather than from these facts, which
            // remain the bounded prior-placement record this operation owes
            // its audit trail.
            ...(alreadyAtDesiredTarget ? {} : {
                previousTargetMachineId: endpoint.targetMachineId,
                previousTargetMachineInstallationId: endpoint.targetMachineInstallationId,
                previousTargetMaterializationId: endpoint.targetMaterializationId,
                previousTargetPluginVersion: endpoint.targetPluginVersion,
            }),
            targetMachineId: target.materialization.machineId,
            targetMachineInstallationId: target.machineInstallationId,
            targetMaterializationId: target.materialization.materializationId,
            targetPluginVersion: target.pluginVersion,
            targetIntentEpoch: input.targetIntentEpoch,
            revision: { increment: 1 },
        },
    });
    // Losing this compare-and-swap means the endpoint moved under us. The
    // caller re-reads its own intent and retries rather than being told a
    // move happened that did not.
    if (updated.count !== 1) return UNAVAILABLE;
    await markPluginWebhookAccountChangedInTxV1(tx, {
        accountId,
        pluginId: input.webhookContribution.pluginId,
    });
    return PluginWebhookEndpointConvergeTargetResultV1Schema.parse({
        kind: "converged",
        webhookEndpointId: endpoint.id,
        revision: endpoint.revision + 1,
        targetMaterialization: target.materialization,
        targetIntentEpoch: input.targetIntentEpoch,
    });
}
