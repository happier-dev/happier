import type { Tx } from "@/storage/inTx";

export type PluginWebhookAccountEncryptionTransitionInventoryV1 =
    | Readonly<{ status: "empty" }>
    | Readonly<{ status: "payloads_present" }>;

/**
 * PEP-WEBHOOKS keeps payload-bearing deliveries in their existing envelope
 * until PEP1 authorizes a migration. Account mode transitions therefore need
 * this narrow, read-only inventory fence rather than a second migration path.
 */
export async function assertPluginWebhookPayloadsEmptyForAccountEncryptionTransitionInTx(
    tx: Tx,
    accountId: string,
): Promise<PluginWebhookAccountEncryptionTransitionInventoryV1> {
    const payload = await tx.pluginWebhookDelivery.findFirst({
        where: {
            accountId,
            payloadBytes: { gt: 0n },
        },
        select: { id: true },
    });
    return payload === null
        ? { status: "empty" }
        : { status: "payloads_present" };
}
