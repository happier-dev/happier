import { z } from "zod/mini";
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { ProviderBrokerModelRouteGrantPayloadV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import type { Tx } from "@/storage/inTx";

/** Private custody on the existing key; neither usage history nor readiness owns its lifetime. */
const ExternalBrokerOperationSchema = z.strictObject({
    v: z.literal(1),
    operationId: z.string().check(z.uuid()),
    brokerMachineId: z.string().check(z.minLength(1)),
    brokerPlacementFingerprint: ProviderBrokerModelRouteGrantPayloadV1Schema.shape.brokerPlacementFingerprint,
    sourceBindingJson: z.string().check(z.minLength(1)),
});

export type ExternalBrokerOperation = z.infer<typeof ExternalBrokerOperationSchema>;

export function readExternalBrokerOperation(value: string): ExternalBrokerOperation | null {
    try {
        const parsed = ExternalBrokerOperationSchema.safeParse(JSON.parse(value));
        if (!parsed.success) return null;
        const source = readTeamCredentialSourceBinding(parsed.data.sourceBindingJson);
        if (!source.success) return null;
        return { ...parsed.data, sourceBindingJson: JSON.stringify(source.data) };
    } catch {
        return null;
    }
}

/** Called only with the exact Machine identity authenticated by the Machine socket owner. */
export async function retireExternalBrokerOperationInTx(tx: Tx, input: Readonly<{
    authenticatedAccountId: string;
    authenticatedMachineId: string;
    externalApiKeyId: string;
    operationId: string;
}>): Promise<Readonly<{ ok: true; retired: boolean }> | Readonly<{ ok: false; reasonCode: "resource_forbidden" }>> {
    const key = await tx.teamCredentialExternalApiKey.findUnique({
        where: { id: input.externalApiKeyId },
        select: { currentBrokerOperationJson: true, resource: { select: { custodianAccountId: true } } },
    });
    if (!key) return { ok: true, retired: false };
    if (key.resource.custodianAccountId !== input.authenticatedAccountId) {
        return { ok: false, reasonCode: "resource_forbidden" };
    }
    const operation = key.currentBrokerOperationJson === null
        ? null : readExternalBrokerOperation(key.currentBrokerOperationJson);
    if (!operation || operation.operationId !== input.operationId) return { ok: true, retired: false };
    if (operation.brokerMachineId !== input.authenticatedMachineId) {
        return { ok: false, reasonCode: "resource_forbidden" };
    }
    const retired = await tx.teamCredentialExternalApiKey.updateMany({
        where: { id: input.externalApiKeyId, currentBrokerOperationJson: key.currentBrokerOperationJson },
        data: { currentBrokerOperationJson: null },
    });
    return { ok: true, retired: retired.count === 1 };
}
