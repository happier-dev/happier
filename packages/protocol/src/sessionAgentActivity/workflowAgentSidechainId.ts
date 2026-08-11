import { encodeAgentActivityIdComponent } from './agentActivityEntryId.js';

/**
 * The one owner of the sidechain id a WORKFLOW agent's imported transcript is filed under.
 *
 * A plain `Task` subagent needs no builder: its sidechain id IS its tool-use id, because
 * `sdkToLogConverter` writes `sidechainId: toolUseId` and one `Task` call owns exactly one
 * transcript. A workflow breaks that one-to-one relationship — a run has ONE `Workflow` tool call
 * and MANY `agent-<agentId>.jsonl` sidecars — so reusing the tool-use id would file every agent's
 * records under one sidechain and render them as a single interleaved transcript. Nothing would
 * fail: the schema is satisfied, the counts are right, and only the content is wrong.
 *
 * The id composes the two identifiers that are re-derived identically on every reconnect and after
 * every restart, which is what makes it STABLE rather than merely unique:
 * - `workflowToolUseId` — the `Workflow` tool-use id, fixed for the run's lifetime and re-read from
 *   the session transcript, never minted at runtime;
 * - `agentId` — the id the run's `journal.jsonl` names and the sidecar file is named after
 *   (`agent-<agentId>.jsonl`), assigned by the provider and fixed on disk.
 * An id derived from anything process-local (a counter, an arrival index, a timestamp) would change
 * identity mid-run and produce either a duplicate transcript or an orphaned one.
 *
 * Components are escaped rather than merely joined, because both genuinely contain the separator in
 * production — the workflow journal's fallback agent id is literally `workflow-agent:1` — and an
 * ambiguous split is the same collapse by another route.
 *
 * The UI must never construct this string. It receives it on
 * `SessionAgentActivityEntryV1.sidechainId` and hands it to the by-id sidechain loader unmodified.
 */

/** Namespace marker. On the wire: it is what keeps a minted id out of the bare tool-use id space. */
export const WORKFLOW_AGENT_SIDECHAIN_ID_PREFIX = 'workflow_agent_sidechain';

const WORKFLOW_AGENT_SIDECHAIN_ID_SEPARATOR = ':';

export function buildWorkflowAgentSidechainId(params: Readonly<{
  workflowToolUseId: string;
  agentId: string;
}>): string {
  return [
    WORKFLOW_AGENT_SIDECHAIN_ID_PREFIX,
    encodeAgentActivityIdComponent(params.workflowToolUseId, 'workflowToolUseId'),
    encodeAgentActivityIdComponent(params.agentId, 'agentId'),
  ].join(WORKFLOW_AGENT_SIDECHAIN_ID_SEPARATOR);
}
