import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

import { automationPortableQueryChunks } from "./automationPortableQueryChunks";

export type AutomationRetiredTriggerProjectionItem = Readonly<{
    id: string;
    automationId: string;
    kind: "schedule" | "pluginEvent" | "sessionLifecycle";
    revision: number;
    retiredAt: Date;
}>;

/**
 * Batch-loads the minimal read-only trigger tombstones shown beside a current
 * Automation definition. Mutable authoring continues to consume only the
 * live `triggers[]` relation; historical cause detail remains Run-owned.
 */
export async function loadAutomationRetiredTriggerProjections(params: Readonly<{
    automationIds: readonly string[];
    tx?: Tx;
}>): Promise<ReadonlyMap<string, readonly AutomationRetiredTriggerProjectionItem[]>> {
    const result = new Map<string, AutomationRetiredTriggerProjectionItem[]>();
    for (const automationId of params.automationIds) result.set(automationId, []);
    if (params.automationIds.length === 0) return result;

    const client = params.tx ?? db;
    const pages = await Promise.all(automationPortableQueryChunks({
        values: params.automationIds,
        bindingsPerValue: 1,
    }).map((automationIds) => client.automationTrigger.findMany({
        where: {
            automationId: { in: [...automationIds] },
            deletedAt: { not: null },
        },
        select: {
            id: true,
            automationId: true,
            kind: true,
            revision: true,
            deletedAt: true,
        },
        orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
    })));

    for (const row of pages.flat()) {
        if (row.deletedAt === null) continue;
        result.get(row.automationId)?.push({
            id: row.id,
            automationId: row.automationId,
            kind: row.kind,
            revision: row.revision,
            retiredAt: row.deletedAt,
        });
    }
    return result;
}
