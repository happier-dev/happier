import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

export type WorkflowRunGroup = {
    header: Extract<SessionListIndexItem, { type: 'header' }>;
    rows: Array<Extract<SessionListIndexItem, { type: 'workflow_run' }>>;
};

/** Runs follow the last existing occurrence of their group; new groups retain Run input order. */
export function mergeWorkflowRunGroups(
    items: SessionListIndexItem[],
    runGroups: ReadonlyMap<string, WorkflowRunGroup>,
): SessionListIndexItem[] {
    if (runGroups.size === 0) return items;

    const lastIndexByGroupKey = new Map<string, number>();
    for (let index = 0; index < items.length; index += 1) {
        const groupKey = items[index]!.groupKey;
        if (groupKey !== undefined) lastIndexByGroupKey.set(groupKey, index);
    }

    const remainingGroups = new Map(runGroups);
    const output: SessionListIndexItem[] = [];
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        output.push(item);
        const groupKey = item.groupKey;
        if (groupKey === undefined) continue;
        const group = remainingGroups.get(groupKey);
        if (group && lastIndexByGroupKey.get(groupKey) === index) {
            for (const row of group.rows) output.push(row);
            remainingGroups.delete(groupKey);
        }
    }
    for (const group of remainingGroups.values()) {
        output.push(group.header);
        for (const row of group.rows) output.push(row);
    }
    return output;
}
