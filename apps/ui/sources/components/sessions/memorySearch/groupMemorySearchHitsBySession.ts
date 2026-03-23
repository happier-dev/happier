import type { MemorySearchHitV1 } from '@happier-dev/protocol';

export type MemorySearchHitSessionGroup = Readonly<{
    sessionId: string;
    sessionLabel: string;
    hits: readonly MemorySearchHitV1[];
}>;

export function groupMemorySearchHitsBySession(args: Readonly<{
    hits: readonly MemorySearchHitV1[];
    sessionLabelById: ReadonlyMap<string, string>;
}>): readonly MemorySearchHitSessionGroup[] {
    const groups = new Map<string, { sessionId: string; sessionLabel: string; hits: MemorySearchHitV1[] }>();
    const ordered: Array<{ sessionId: string; sessionLabel: string; hits: MemorySearchHitV1[] }> = [];

    for (const hit of args.hits) {
        const sessionId = String(hit.sessionId ?? '').trim();
        if (!sessionId) continue;

        let group = groups.get(sessionId);
        if (!group) {
            const sessionLabel = String(args.sessionLabelById.get(sessionId) ?? sessionId).trim() || sessionId;
            group = { sessionId, sessionLabel, hits: [] };
            groups.set(sessionId, group);
            ordered.push(group);
        }
        group.hits.push(hit);
    }

    return ordered;
}
