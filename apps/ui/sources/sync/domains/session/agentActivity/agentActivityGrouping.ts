/**
 * Which entries are containers rather than units of work — the ONE place that decides it.
 *
 * The CLI publishes the run it synthesizes around two or more plain subagents (`implicit:agent-activity`,
 * titled "Agent activity") as an entry with those subagents as its children. A roster or a count that
 * walked every entry would therefore show and count the group as well as its members: three subagents
 * reported as four agents, and a row that says nothing its own children do not already say.
 *
 * **A container is an entry that has members IN THIS LIST.** One signal decides it, and it is the
 * only one that can: another entry naming it as its parent. That is what makes double counting
 * possible, and it is therefore exactly what makes an entry a box rather than a unit of work.
 *
 * **The producer's own claim of members is deliberately NOT that signal, and this is a fix.** The
 * count-only workflow headline reports `totalAgents` and never a name, so its run entries used to
 * declare themselves containers on the producer's word alone (a since-deleted `isGrouping` flag).
 * Nothing else in the list represented that work — the headline names no agents, and on a cold open
 * no transcript has been derived yet — so a genuinely running workflow was skipped by the shared
 * counter and reported `live: 0`: no composer chip, `0` in the session header, `0` on the Agents tab
 * badge and `0` on the session-list row, while both rosters drew the same run as a live panel. PLAN
 * §4.6 is explicit that running work is always visible, so the run stays a unit of work until
 * something else on the list speaks for it. A container that names no members has nothing to double
 * count.
 *
 * The producer's number survives, at `AgentActivityCountable.liveAgentComplement`, and answers the
 * other question: not *which* agents a run has (unanswerable, and the mistake above) but *how many*,
 * which is what lets a surface say "1 workflow, 5 agents" instead of understating a five-agent
 * workflow as one nameless unit.
 *
 * The consequence, stated rather than discovered later: on the count-only path a run whose agents
 * reach the roster only through local transcript derivation is DRAWN beside them, so the roster
 * shows a run panel and its own agents as unlinked rows. That errs towards showing work that exists;
 * the alternative erred towards silence about work that is running, and silence is the failure this
 * rule exists to prevent. It is a trade about what is drawn, not about what is said: those rows
 * carry the run they were launched under, so `deriveAgentActivityCounts` attributes them to it and
 * no surface describes the same agents twice. `deriveAgentActivityEntries.test.ts` pins both halves.
 */

export type AgentActivityGroupable = Readonly<{
    id: string;
    /** The unit this one belongs to, when it belongs to one. Grouping and layout only (N-USAGE). */
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
