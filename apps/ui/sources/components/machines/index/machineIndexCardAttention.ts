import * as React from 'react';

import type { MachineAttentionEntry } from '@/components/machines/attention/collectMachineAttention';

type CardAttentionItem = Readonly<{ key: string; reason: unknown }>;
const NO_CARD_ATTENTION: ReadonlyMap<string, MachineAttentionEntry> = new Map();

function sameStatements(left: ReadonlyMap<string, MachineAttentionEntry>, right: ReadonlyMap<string, MachineAttentionEntry>): boolean {
    if (left.size !== right.size) return false;
    for (const [key, entry] of left) if (right.get(key) !== entry) return false;
    return true;
}

/**
 * The reason each displayed card states above the dashboard (grid only). A read/access reason keeps its
 * existing priority over resource attention. It publishes only a changed statement: the index anatomy
 * (and so every Collection row) is keyed on this map, and Machine list publications rebuild the sections
 * far more often than a card's statement changes.
 */
export function useMachineIndexCardAttention<Item extends CardAttentionItem>(
    grid: boolean,
    subjects: readonly MachineAttentionEntry[],
    sections: readonly Readonly<{ items: readonly Item[] }>[],
    machineKey: (item: Item) => string | null,
): ReadonlyMap<string, MachineAttentionEntry> {
    const published = React.useRef(NO_CARD_ATTENTION);
    const next = React.useMemo(() => {
        if (!grid) return NO_CARD_ATTENTION;
        const stated = new Map<string, MachineAttentionEntry>();
        const byMachine = new Map(subjects.map(entry => [entry.key, entry]));
        for (const section of sections) {
            for (const item of section.items) {
                if (item.reason !== null) continue;
                const key = machineKey(item);
                const entry = key === null ? undefined : byMachine.get(key);
                if (entry) stated.set(item.key, entry);
            }
        }
        return stated;
    }, [grid, machineKey, sections, subjects]);
    if (next !== published.current && !sameStatements(next, published.current)) published.current = next;
    return published.current;
}
