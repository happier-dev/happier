import type { AgentActivityKindV1, AgentActivityStatusV1 } from '@happier-dev/protocol';

/**
 * The merged agent-activity model: one unit of agent work, however it became known.
 *
 * Every surface in the program reads this — the Agents pane, the composer badge, the session-list
 * count, the transcript card — so the fields here are exactly what a surface may reason about, and
 * nothing that would let one surface tell a different story than another.
 *
 * It is deliberately a superset of the row's presentation contract
 * (`components/sessions/agentActivity/agentActivityRowEntry.ts`) minus `actions`: actions depend on
 * which routes resolve and which capabilities a host has, which is component knowledge, not sync
 * knowledge. A host attaches them; the merge never invents them.
 */

/**
 * Which source knew about this entry.
 *
 * Not decoration — it is the honest statement of what a surface may claim. A `headline` entry is
 * known to exist and to have a status; nothing has been loaded about it. A `local` entry is fully
 * derived from a transcript this client holds. `merged` is both.
 */
export type AgentActivityEntryProvenance = 'headline' | 'local' | 'merged';

/**
 * Whether the local detail sources have this entry.
 *
 * `unloaded` is the cold-open state R-3 exists to make renderable: the headline named the agent, the
 * transcript page holding it has not arrived, and the row still renders rather than being dropped
 * (INV-2). It is not an error and not a loading spinner for the roster — the roster is complete.
 */
export type AgentActivityEntryDetailState = 'loaded' | 'unloaded';

/**
 * What kind of work an entry describes, across every source.
 *
 * A superset of the WIRE vocabulary `AgentActivityKindV1`, and the extra members are not aspiration:
 * each one has a live local producer today —
 * `subagent` ← `deriveSubAgentSidechainSubagents`, `execution_run` ← `deriveExecutionRunSubagents`,
 * `agent_team_member` ← `deriveClaudeTeamSubagents`, `background_task` ←
 * `deriveBackgroundTaskActivityEntries` reading the durable `activity/background_task.v1` records.
 * PLAN §5.1 item 11 governs what may cross the WIRE (a kind needs a proven CLI headline writer); a
 * locally derived kind has its writer in this process.
 *
 * `background_task` deliberately stays out of `AgentActivityKindV1`: no CLI publishes it into the
 * headline, and its records already carry existence and status. That is also why its local entry id
 * keeps an unescaped `background_task:<taskId>` template — `parseAgentActivityEntryId` rejects that
 * prefix (pinned by a protocol test), so the merge can never join it onto a headline entry and the
 * escaping ambiguity IDFIX guarded against cannot arise.
 *
 * The compile-time check below is what keeps the two vocabularies from drifting: a kind added to the
 * wire union with no home here fails to compile at this owner.
 */
export type AgentActivityEntryKind =
    | 'workflow_run'
    | 'workflow_agent'
    | 'subagent'
    | 'execution_run'
    | 'agent_team_member'
    | 'background_task';

const WIRE_KIND_COVERAGE: Record<AgentActivityKindV1, AgentActivityEntryKind> = {
    workflow_run: 'workflow_run',
    workflow_agent: 'workflow_agent',
};

/** Map a wire kind into the merged vocabulary. Total by construction. */
export function toAgentActivityEntryKind(kind: AgentActivityKindV1): AgentActivityEntryKind {
    return WIRE_KIND_COVERAGE[kind];
}

export type AgentActivityEntry = Readonly<{
    /** The entry id, spelled by `buildAgentActivityEntryId` on whichever side produced it. */
    id: string;
    kind: AgentActivityEntryKind;
    status: AgentActivityStatusV1;
    title: string;
    /** The single extra fact a row may show. Local sources own it; the headline carries none. */
    metaDetail?: string | null;
    /** Raw, never fabricated (D-8). The row decides whether an elapsed value may be claimed. */
    startedAtMs?: number | null;
    /**
     * The most recent instant we have EVIDENCE about this entry — never "when it was last rebuilt".
     * When both sources have one, the later wins: both are evidence, and the newer one is the one
     * that has not gone stale.
     */
    updatedAtMs?: number | null;
    endedAtMs?: number | null;
    provenance: AgentActivityEntryProvenance;
    detailState: AgentActivityEntryDetailState;
    /**
     * The entry that owns this one. Authorises grouping and layout ONLY — never numeric rollup
     * (N-USAGE). No count, token figure or duration is ever summed from children.
     */
    parentId?: string | null;
    /**
     * How many of this run's agents the producing source says are still RUNNING, when it says so at
     * all — `totalAgents` minus `completedAgents`, computed once at `sources/fromWorkflowHeadline`
     * (RULING-11). The name predates that ruling; the value is the run's LIVE complement.
     *
     * The count-only workflow headline states counts and can name nobody, so this is the only way a
     * surface can describe a workflow with five agents in flight as five agents rather than as one
     * nameless unit — and stating its *total* instead was how the composer chip came to say
     * "5 agents" about a run whose first three had finished. Absent means the producer stated no
     * figure (the unified headline names its members instead); a stated `0` is the opposite of
     * absent, and means nothing of this run's is in flight right now.
     *
     * It describes the run and NOTHING else: it is never read as proof of members (the boolean that
     * was — `isGrouping` — is deleted, because trusting it as containment made a running workflow
     * invisible to every count in the app), and no fraction, duration or token figure is derived
     * from it (N-USAGE) — the run panel's own progress reads `completedAgents / totalAgents`
     * straight off the headline.
     */
    liveAgentComplement?: number | null;
    runId?: string | null;
    sidechainId?: string | null;
    /** The local `SessionSubagent.id` behind this entry, when a local source contributed one. */
    subagentId?: string | null;
}>;

/**
 * A locally derived entry, plus the one thing the merge needs that a row does not: the handle.
 *
 * The merge cannot join on the entry id. The CLI names a subagent by the run it attached it to
 * (`workflow_agent:<runId>:<toolUseId>`) and attaches plain subagents to a synthesized run only once
 * a second one appears, so the id for one unchanged agent is not knowable to this process. The
 * provider tool-use id underneath it is — it is the same string the transcript tool call carries and
 * the same string its sidechain is keyed by — so that is what the two sides are joined on.
 */
export type AgentActivityLocalEntry = Readonly<{
    id: string;
    kind: AgentActivityEntryKind;
    /** Provider tool-use id, or `null` when this entry cannot be joined to a headline entry. */
    handle: string | null;
    status: AgentActivityStatusV1;
    title: string;
    metaDetail?: string | null;
    startedAtMs?: number | null;
    updatedAtMs?: number | null;
    endedAtMs?: number | null;
    runId?: string | null;
    sidechainId?: string | null;
    subagentId?: string | null;
}>;

/**
 * An entry as a headline describes it, already normalised into the merged vocabulary.
 *
 * `handle` is resolved through the protocol owner rather than parsed here, so a change to the id
 * format cannot leave one side reading it the old way.
 */
export type AgentActivityHeadlineEntry = Readonly<{
    id: string;
    kind: AgentActivityEntryKind;
    handle: string | null;
    status: AgentActivityStatusV1;
    title: string;
    startedAtMs?: number | null;
    updatedAtMs?: number | null;
    parentId?: string | null;
    /**
     * The producer's own statement of this run's LIVE agent complement (`totalAgents` minus
     * `completedAgents`), or absent when it states no figure. See `AgentActivityEntry`.
     */
    liveAgentComplement?: number | null;
    runId?: string | null;
    sidechainId?: string | null;
}>;
