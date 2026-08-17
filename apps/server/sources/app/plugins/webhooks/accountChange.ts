import { buildPluginDomainAccountChangeEntityId } from "@happier-dev/protocol/changes";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import type { Tx } from "@/storage/inTx";

/**
 * Webhook state is re-read from its canonical endpoint and queue owners. The
 * AccountChange only invalidates that bounded plugin domain; it never carries
 * delivery content or credential material.
 */
export async function markPluginWebhookAccountChangedInTxV1(
    tx: Tx,
    params: Readonly<{ accountId: string; pluginId: string }>,
): Promise<number> {
    const hint = { pluginDomain: "webhook" as const, pluginId: params.pluginId };
    return await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "pluginDomain",
        entityId: buildPluginDomainAccountChangeEntityId(hint),
        hint,
    });
}

/**
 * Credential custody belongs to a route, which may be shared by more than
 * one Account endpoint. Resolve the bounded affected Accounts in the same
 * transaction instead of giving credential readers a second change owner.
 */
export async function markPluginWebhookRouteAccountsChangedInTxV1(
    tx: Tx,
    routeId: string,
): Promise<void> {
    const endpoints = await tx.pluginWebhookEndpoint.findMany({
        where: { routeId },
        select: { accountId: true, pluginId: true },
    });
    const marks = new Map<string, Readonly<{ accountId: string; pluginId: string }>>();
    for (const endpoint of endpoints) {
        if (endpoint.accountId === null || endpoint.pluginId === null) continue;
        marks.set(`${endpoint.accountId}\u0000${endpoint.pluginId}`, {
            accountId: endpoint.accountId,
            pluginId: endpoint.pluginId,
        });
    }
    for (const mark of marks.values()) {
        await markPluginWebhookAccountChangedInTxV1(tx, mark);
    }
}
