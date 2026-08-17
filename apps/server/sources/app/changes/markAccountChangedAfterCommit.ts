import { inTx } from "@/storage/inTx";

import { markAccountChanged } from "./markAccountChanged";

type MarkAccountChangedParams = Readonly<{
    accountId: string;
    kind: Parameters<typeof markAccountChanged>[1]["kind"];
    entityId: string;
    hint?: unknown;
}>;

export async function markAccountChangedAfterCommit(params: MarkAccountChangedParams): Promise<number> {
    return await inTx(
        async (tx) => await markAccountChanged(tx, params),
        { isolationLevel: "ReadCommitted" },
    );
}
