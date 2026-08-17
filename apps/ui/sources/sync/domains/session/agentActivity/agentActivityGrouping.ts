/**
 * Which entries are containers rather than units of work — the ONE place that decides it.
 *
 * A workflow run is published alongside the agents it owns, each naming it as their parent. A
 * roster or a count that walked every entry would therefore report the box as well as its contents:
 * three agents reported as four units, and a row that says nothing its own children do not already
 * say.
 *
 * **A container is an entry that has members IN THIS LIST.** One signal decides it, and it is the
 * only one that can: another entry naming it as its parent. That is what makes double counting
 * possible, and it is therefore exactly what makes an entry a box rather than a unit of work.
 *
 * **A producer's own claim of members is deliberately NOT that signal.** A run that says it owns
 * five agents while naming none of them is still the only thing on the list that represents that
 * work — on a cold open no transcript has been derived yet — so treating its claim as containment
 * skips it from every count and reports a genuinely running workflow as zero live work. A container
 * that names no members has nothing to double count, so it stays a unit of work until something
 * else on the list speaks for it.
 */

export type AgentActivityGroupable = Readonly<{
    id: string;
    /** The unit this one belongs to, when it belongs to one. Grouping and layout only. */
    parentId?: string | null;
}>;

export function collectAgentActivityGroupingIds(
    entries: readonly AgentActivityGroupable[],
): ReadonlySet<string> {
    const groupings = new Set<string>();
    for (const entry of entries) {
        const parentId = entry.parentId?.trim();
        if (parentId) groupings.add(parentId);
    }
    return groupings;
}
