import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

export type SessionSubagentGroupModel = Readonly<{
    key: string;
    label: string | null;
    items: readonly SessionSubagent[];
}>;

export function groupSessionSubagents(subagents: readonly SessionSubagent[]): readonly SessionSubagentGroupModel[] {
    const orderedKeys: string[] = [];
    const groups = new Map<string, SessionSubagent[]>();

    for (const subagent of subagents) {
        const key = subagent.display.groupKey?.trim() || '__ungrouped__';
        if (!groups.has(key)) {
            groups.set(key, []);
            orderedKeys.push(key);
        }
        groups.get(key)!.push(subagent);
    }

    return orderedKeys.map((key) => {
        const items = groups.get(key) ?? [];
        return {
            key,
            label: key === '__ungrouped__' ? null : (items[0]?.display.groupLabel?.trim() || key),
            items,
        };
    });
}
