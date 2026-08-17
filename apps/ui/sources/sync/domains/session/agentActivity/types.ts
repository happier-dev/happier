import type { AgentActivityKindV1, AgentActivityStatusV1 } from '@happier-dev/protocol';

/**
 * The merged agent-activity model: one unit of agent work, however it became known.
 *
 * Two sources know about agent work and neither knows everything:
 *
 * - the **headline** the agent publishes into session metadata
 *   (`SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY`), which arrives with the session itself and is
 *   therefore complete on a cold open however little transcript has paged in;
 * - **local derivation** from the transcript (`deriveSessionSubagents`), the only source with
 *   detail — the tool call, the sidechain, the permission prompt, the terminal instant — and the
 *   only source at all for an agent whose backend publishes no headline.
 *
 * Every surface that asks "what agent work does this session have" reads this model, so the fields
 * here are exactly what a surface may reason about and nothing that would let two surfaces tell
 * different stories.
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
 * `unloaded` is the cold-open state: the headline named the agent, the transcript page holding it
 * has not arrived, and the entry still exists rather than being dropped. It is not an error and not
 * a loading state for the roster — the roster is complete.
 */
export type AgentActivityEntryDetailState = 'loaded' | 'unloaded';

/**
 * What kind of work an entry describes, across every source.
 *
 * A superset of the WIRE vocabulary `AgentActivityKindV1`, and the extra members are not
 * aspiration: each one has a live local producer in this repository today —
 * `subagent` <- `deriveSubAgentSidechainSubagents`, `execution_run` <-
 * `deriveExecutionRunSubagents`, `agent_team_member` <- the provider team derivation, all three
 * reached through `deriveSessionSubagents`. `AgentActivityKindV1` governs what may cross the wire
 * (a kind needs a proven publisher); a locally derived kind has its writer in this process.
 *
 * `background_task` is deliberately absent: this repository has a durable
 * `activity/background_task.v1` record but no client derivation that turns one into a roster entry,
 * and a kind with no producer is a branch that can never be taken.
 *
 * The compile-time coverage table below is what keeps the two vocabularies from drifting: a kind
 * added to the wire union with no home here fails to compile at this owner.
 */
export type AgentActivityEntryKind =
    | 'workflow_run'
    | 'workflow_agent'
    | 'subagent'
    | 'execution_run'
    | 'agent_team_member';

const WIRE_KIND_COVERAGE: Record<AgentActivityKindV1, AgentActivityEntryKind> = {
    workflow_run: 'workflow_run',
    workflow_agent: 'workflow_agent',
};

/** Map a wire kind into the merged vocabulary. Total by construction. */
export function toAgentActivityEntryKind(kind: AgentActivityKindV1): AgentActivityEntryKind {
    return WIRE_KIND_COVERAGE[kind];
}

/**
 * One unit of agent work, merged.
 *
 * **It carries no evidence instant, and that absence is load-bearing.** How fresh the evidence for
 * a unit of work is changes constantly while what the unit IS does not, so folding the instant into
 * the row would make every row a new object on every observation and defeat the memoization the
 * roster depends on. Freshness lives in the separately built evidence index
 * (`buildAgentActivityEvidenceIndex`), keyed by this `id`.
 */
export type AgentActivityEntry = Readonly<{
    /** The entry id, spelled by `buildAgentActivityEntryId` on whichever side produced it. */
    id: string;
    kind: AgentActivityEntryKind;
    status: AgentActivityStatusV1;
    title: string;
    /** The single extra fact a row may show. Local sources own it; the headline carries none. */
    metaDetail: string | null;
    /** Raw, never fabricated: a start is absent unless something genuinely observed one. */
    startedAtMs: number | null;
    /** Raw terminal instant, or `null`. Never borrowed from an update. */
    endedAtMs: number | null;
    provenance: AgentActivityEntryProvenance;
    detailState: AgentActivityEntryDetailState;
    /**
     * The entry that owns this one. Authorises grouping and layout ONLY — never numeric rollup. No
     * count, token figure or duration is ever summed from children.
     */
    parentId: string | null;
    runId: string | null;
    sidechainId: string | null;
    /** The local `SessionSubagent.id` behind this entry, when a local source contributed one. */
    subagentId: string | null;
}>;

/**
 * A locally derived entry, plus the one thing the merge needs that a row does not: the handle.
 *
 * The merge cannot join on the entry id. The producer names a workflow agent by the run it attached
 * it to (`workflow_agent:<runId>:<agentId>`), and which run that is is a producer-side decision this
 * process cannot see, so the id for one unchanged agent is not knowable here. The provider tool-use
 * id underneath it IS — it is the same string the transcript tool call carries and the same string
 * its sidechain is keyed by — so that is what the two sides are joined on.
 */
export type AgentActivityLocalEntry = Readonly<{
    id: string;
    kind: AgentActivityEntryKind;
    /** Provider tool-use id, or `null` when this entry cannot be joined to a headline entry. */
    handle: string | null;
    status: AgentActivityStatusV1;
    title: string;
    metaDetail: string | null;
    startedAtMs: number | null;
    /** Evidence, not identity: it goes to the index, never onto the merged row. */
    updatedAtMs: number | null;
    endedAtMs: number | null;
    runId: string | null;
    sidechainId: string | null;
    subagentId: string | null;
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
    startedAtMs: number | null;
    /** Evidence, not identity — see `AgentActivityEntry`. */
    updatedAtMs: number | null;
    parentId: string | null;
    runId: string | null;
    sidechainId: string | null;
}>;
