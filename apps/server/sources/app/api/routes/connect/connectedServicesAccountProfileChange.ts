import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { afterTx, type Tx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { buildAccountConnectedServicesProjection } from "../account/connectedServicesProfileProjection";

export async function recordConnectedServiceAccountProfileChange(
    tx: Tx,
    params: Readonly<{ accountId: string }>,
): Promise<number> {
    const projection = await buildAccountConnectedServicesProjection({
        tx,
        accountId: params.accountId,
        includeAntigravity: false,
    });
    const cursor = await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "self",
        hint: { connectedServices: true },
    });

    afterTx(tx, () => {
        const update = buildUpdateAccountUpdate(
            params.accountId,
            projection,
            cursor,
            randomKeyNaked(12),
        );
        // Released UI clients persist these passthrough rows and parse the cache
        // with a closed enum on reload. Updated readers refetch the negotiated
        // HTTP projection rather than adding new IDs to that legacy push shape.
        const payload = { ...update, body: { ...update.body, connectedServicesProfileChanged: true } };
        // Machine-scoped daemons are the canonical consumers that apply committed
        // group generations to live runtimes. UI-only projection left settings
        // changes invisible until each session independently encountered a failure.
        eventRouter.emitUpdate({
            userId: params.accountId,
            payload,
            recipientFilter: { type: "user-machine-scoped-only" },
        });
        eventRouter.emitUpdate({
            userId: params.accountId,
            payload,
            recipientFilter: { type: "user-scoped-only" },
        });
    });

    return cursor;
}
