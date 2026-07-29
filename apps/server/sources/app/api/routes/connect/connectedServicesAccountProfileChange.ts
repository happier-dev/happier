import { randomUUID } from "node:crypto";

import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { afterTx, type Tx } from "@/storage/inTx";
import { buildAccountConnectedServicesProjection } from "../account/connectedServicesProjection";

export async function recordConnectedServiceAccountProfileChange(params: Readonly<{
    tx: Tx;
    accountId: string;
}>): Promise<number> {
    const projection = await buildAccountConnectedServicesProjection({
        tx: params.tx,
        accountId: params.accountId,
        includeGroups: isServerFeatureEnabledForRequest("connectedServices.accountGroups", process.env),
    });
    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "self",
        hint: { connectedServices: true },
    });
    afterTx(params.tx, () => {
        const payload = buildUpdateAccountUpdate(
            params.accountId,
            projection,
            cursor,
            randomUUID(),
        );
        eventRouter.emitUpdate({
            userId: params.accountId,
            recipientFilter: { type: "user-machine-scoped-only" },
            payload,
        });
        eventRouter.emitUpdate({
            userId: params.accountId,
            recipientFilter: { type: "user-scoped-only" },
            payload,
        });
    });
    return cursor;
}
