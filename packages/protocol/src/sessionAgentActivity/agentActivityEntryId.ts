import type { AgentActivityKindV1 } from './agentActivityKindV1.js';

/**
 * The one owner of how a unit of agent work is named.
 *
 * `deriveAgentActivityEntries` unions the headline the CLI publishes with the entries the UI derives
 * from the transcript, and it unions them BY ID. Two spellings of one agent — `workflow_agent:wf_1:a1`
 * on the producer against `wf_1/a1` on the consumer — therefore render that agent twice, with every
 * schema valid, every test green and nothing failing loudly. That is the failure this module exists
 * to make impossible: the CLI projection and the UI merge both import these functions, so there is
 * one spelling by construction, and the hand-written literals in the test are the lock on it.
 *
 * Two separate identifiers live here, and conflating them is the subtle mistake:
 *
 * - **The entry id** is what a row is keyed by and what the headline publishes. It is namespaced by
 *   the run an agent belongs to, because a provider agent id is only unique inside its run — a
 *   recorded two-run workflow fixture labels an agent `workflow-agent:1` in BOTH of its runs.
 * - **The agent handle** is the provider-side tool-use id underneath. It is the ONLY identifier the
 *   two sides can independently produce for the same work: the CLI sees the SDK's `tool_use` id
 *   (`claudeWorkflowCorrelation.parseSubagentToolUse` → the agent's snapshot id), and the UI sees the
 *   transcript tool call whose id doubles as the sidechain id (`resolveToolTranscriptSidechainId`
 *   returns `tool.id`; `sdkToLogConverter` writes `sidechainId: toolUseId`). The UI cannot know which
 *   run the CLI attached an agent to — a plain subagent is attached to a synthesized implicit run
 *   only once a second one appears — so the merge joins on the handle and adopts the headline's id.
 */

/** The separator between an entry id's components. Part of the wire format. */
export const AGENT_ACTIVITY_ENTRY_ID_SEPARATOR = ':';

/**
 * What an entry id names, in the vocabulary each producer already speaks.
 *
 * A member here is required for every kind on the wire — the prefix table below is typed
 * `Record<AgentActivityKindV1, …>`, so a kind added to the union without an id shape fails to
 * compile at the owner rather than at whichever caller happens to be compiled first.
 */
export type AgentActivityEntryRefV1 =
  | Readonly<{ kind: 'workflow_run'; runId: string }>
  | Readonly<{ kind: 'workflow_agent'; runId: string; agentId: string }>;

const ENTRY_ID_PREFIX_BY_KIND: Record<AgentActivityKindV1, string> = {
  workflow_run: 'workflow_run',
  workflow_agent: 'workflow_agent',
};

/**
 * Escape a component so the id splits into a fixed number of parts.
 *
 * Both variable components genuinely contain the separator in production, which is why this exists
 * rather than a "components must not contain ':'" rule: the CLI's synthesized run id is literally
 * `implicit:agent-activity`, and a workflow journal's fallback agent id is literally
 * `workflow-agent:1` (OBSERVED in the recorded concurrent-workflow fixture). A scheme that forbade
 * either would push the producer into either throwing on real data or minting an id that reads back
 * as a different agent — which, joined on, merges two agents into one row or splits one into two.
 *
 * `%` is escaped first so the encoding is reversible.
 */
export function encodeAgentActivityIdComponent(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`agent-activity entry id: ${label} must be a non-empty string`);
  }
  return normalized
    .replaceAll('%', '%25')
    .replaceAll(AGENT_ACTIVITY_ENTRY_ID_SEPARATOR, '%3A');
}

function decodeIdComponent(value: string): string {
  return value.replaceAll('%3A', AGENT_ACTIVITY_ENTRY_ID_SEPARATOR).replaceAll('%25', '%');
}

export function buildAgentActivityEntryId(ref: AgentActivityEntryRefV1): string {
  const prefix = ENTRY_ID_PREFIX_BY_KIND[ref.kind];
  switch (ref.kind) {
    case 'workflow_run':
      return [prefix, encodeAgentActivityIdComponent(ref.runId, 'runId')]
        .join(AGENT_ACTIVITY_ENTRY_ID_SEPARATOR);
    case 'workflow_agent':
      return [
        prefix,
        encodeAgentActivityIdComponent(ref.runId, 'runId'),
        encodeAgentActivityIdComponent(ref.agentId, 'agentId'),
      ].join(AGENT_ACTIVITY_ENTRY_ID_SEPARATOR);
    default: {
      const exhaustive: never = ref;
      return exhaustive;
    }
  }
}

/**
 * Read an entry id back, or `null` when this build does not know the shape.
 *
 * `null` rather than a throw, and deliberately: a client one release behind a producer that has
 * started publishing a new kind must degrade to "I cannot join this entry", never to a crash or to
 * an empty roster (PLAN §5.2).
 */
export function parseAgentActivityEntryId(entryId: string): AgentActivityEntryRefV1 | null {
  // Fixed arity, because every component is escaped: an id with a different part count was not
  // written by this builder and this build must not guess at what it meant.
  const parts = entryId.split(AGENT_ACTIVITY_ENTRY_ID_SEPARATOR);
  const prefix = parts[0];

  if (prefix === ENTRY_ID_PREFIX_BY_KIND.workflow_run && parts.length === 2) {
    const runId = decodeIdComponent(parts[1]!).trim();
    return runId.length > 0 ? { kind: 'workflow_run', runId } : null;
  }

  if (prefix === ENTRY_ID_PREFIX_BY_KIND.workflow_agent && parts.length === 3) {
    const runId = decodeIdComponent(parts[1]!).trim();
    const agentId = decodeIdComponent(parts[2]!).trim();
    if (runId.length === 0 || agentId.length === 0) return null;
    return { kind: 'workflow_agent', runId, agentId };
  }

  return null;
}

/**
 * The provider handle a headline entry and a locally derived entry can be joined on, or `null` when
 * the entry is not agent-shaped.
 *
 * A run returns `null` on purpose. A run is the box its agents sit in, not a unit of work anybody
 * derives locally, and handing back its run id would let it join onto an unrelated local row.
 */
export function resolveAgentActivityEntryAgentHandle(entryId: string): string | null {
  const ref = parseAgentActivityEntryId(entryId);
  if (ref === null) return null;
  switch (ref.kind) {
    case 'workflow_agent':
      return ref.agentId;
    case 'workflow_run':
      return null;
    default: {
      const exhaustive: never = ref;
      return exhaustive;
    }
  }
}
