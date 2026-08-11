import { resolveAgentActivitySectionId } from './agentActivitySectionModel';

/**
 * How a surface splits agent work into "runs I will draw as a panel" and "rows I will list".
 *
 * One rule, shared by the compact work-state surface and the Agents pane, for exactly the reason
 * the unification exists: a run drawn as a panel already contains its members, so a surface that
 * also listed them flat would show the same work twice — and two surfaces that each decided that
 * for themselves would eventually decide it differently.
 *
 * `parentId` is read here for grouping and layout only, never for numeric rollup (N-USAGE).
 */

type PartitionableEntry = Readonly<{
    id: string;
    kind: string;
    status: Parameters<typeof resolveAgentActivitySectionId>[0];
    parentId?: string | null;
}>;

export type AgentActivityRunPartition<TEntry> = Readonly<{
    /** Live `workflow_run` entries, in input order. Each is drawn as its own panel. */
    runEntries: readonly TEntry[];
    /**
     * Everything the surface should list: every entry that is not itself drawn as a panel and is
     * not a member of one.
     *
     * A TERMINAL run is listed. It is not drawn as a panel — a finished run is history, and history
     * belongs in the ordered list with everything else that just happened — but it is the only row
     * that can state the run-level outcome, so removing it left a workflow that failed before
     * naming an agent counted in `failed` and visible nowhere (§4.7).
     */
    listedEntries: readonly TEntry[];
}>;

export function partitionAgentActivityRuns<TEntry extends PartitionableEntry>(
    entries: readonly TEntry[],
    options?: Readonly<{
        /** Restrict the whole partition to work in flight. The compact surface does; the pane does not. */
        liveOnly?: boolean;
    }>,
): AgentActivityRunPartition<TEntry> {
    const scoped = options?.liveOnly === true
        ? entries.filter((entry) => resolveAgentActivitySectionId(entry.status) === 'working')
        : entries;
    // A run is drawn as a panel only while it is in flight: a finished run and its agents belong to
    // the terminal list, where they are ordered by recency with everything else that just happened.
    const runEntries = scoped.filter((entry) => (
        entry.kind === 'workflow_run' && resolveAgentActivitySectionId(entry.status) === 'working'
    ));
    if (runEntries.length === 0) return { runEntries, listedEntries: scoped };
    const drawnRunIds = new Set(runEntries.map((entry) => entry.id));
    const isFolded = (entry: TEntry): boolean => (
        drawnRunIds.has(entry.id)
        || (entry.parentId != null && drawnRunIds.has(entry.parentId))
    );
    return { runEntries, listedEntries: scoped.filter((entry) => !isFolded(entry)) };
}
