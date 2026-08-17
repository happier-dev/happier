import { buildAccountChangeWakeUpdate } from "@/app/events/eventPayloadBuilders";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";

/**
 * Content-free post-commit hint for the exact daemon that owns a frozen
 * delivery target. AccountChange remains the durable/current source; this
 * socket message only asks the existing claim loop to poll it sooner.
 */
export type PluginWebhookCommittedDeliveryWakeV1 = Readonly<{
    accountId: string;
    targetMachineId: string;
    accountChangeCursor: number;
}>;

export function emitPluginWebhookDeliveryCommittedWakeV1(
    params: PluginWebhookCommittedDeliveryWakeV1,
): void {
    eventRouter.emitUpdate({
        userId: params.accountId,
        payload: buildAccountChangeWakeUpdate(params.accountChangeCursor, randomKeyNaked(12)),
        recipientFilter: { type: "machine-only", machineId: params.targetMachineId },
    });
}
