import {
  buildAgentActivityEntryId,
  fromWorkflowAgentStatus,
  fromWorkflowRunStatus,
  type SessionAgentActivityEntryV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

/**
 * Project durable workflow run detail into unified agent-activity headline entries.
 *
 * The unified headline is DERIVED from the same committed snapshots the workflow headline is derived
 * from — never from a second observation of the same work — so the two keys published in one
 * metadata write can never disagree about what exists. Only the vocabulary differs: the workflow
 * headline speaks in runs and counts, this one speaks in entries a roster can render directly.
 *
 * Why the agents come along. The workflow headline is count-only (`totalAgents`/`completedAgents`),
 * so a client that has not fetched the durable record cannot name a single agent. R-3 requires the
 * roster to be COMPLETE on cold open without reading the transcript, and per-agent entries are the
 * only way the pointer can carry that. Detail still stays behind: no summary, no result preview, no
 * phases, no metrics — those remain in `activity/workflow_run.v1`, which every entry points at
 * through `runId`.
 *
 * Three rules this projection must not break:
 *
 * - **Entry ids come from the protocol owner, never from a template here.** The UI merges this
 *   headline with its own transcript-derived entries BY ID, so a local `workflow_agent:${runId}:${id}`
 *   template that drifted from the consumer's would render every agent twice with nothing failing
 *   loudly. `buildAgentActivityEntryId` is that single owner and both sides import it.
 * - **Never fabricate a start.** `startedAt` is copied only when the source has one. D-8 shipped the
 *   opposite (`startedAtMs ?? updatedAtMs ?? finishedAtMs`) and made a finished 16-second agent
 *   report `0:00`; an absent start renders as nothing, which is the truth.
 * - **`parentId` groups, it never rolls up.** An agent entry names its run so a surface can nest it
 *   (N-USAGE); no count, token figure or duration is ever summed from children here or downstream.
 *
 * **`recordRevision` is the run entry's freshness, and only the run entry's.** The unified headline
 * is a pointer, and a pointer that cannot say WHICH version of the record it points at leaves its
 * consumer choosing between refetching forever and never refetching. The client that hydrates
 * `activity/workflow_run.v1` chose the latter, so on a session whose backend publishes only this
 * headline a run hydrated once and then froze while it kept looking live. Agents are deliberately
 * left unstamped: an agent has no record of its own — it lives inside the run's — and stamping it
 * would publish a second freshness authority for one record. The snapshot handed here is the
 * COMMITTED one, so the revision published always names a record that exists.
 */

export function projectWorkflowRunAgentActivityEntries(
  snapshot: SessionWorkflowRunSnapshotV1,
): SessionAgentActivityEntryV1[] {
  const runEntryId = buildAgentActivityEntryId({ kind: 'workflow_run', runId: snapshot.runId });
  const runEntry: SessionAgentActivityEntryV1 = {
    entryId: runEntryId,
    kind: 'workflow_run',
    title: snapshot.title,
    status: fromWorkflowRunStatus(snapshot.status),
    updatedAt: snapshot.updatedAt,
    runId: snapshot.runId,
    recordRevision: snapshot.recordRevision,
  };
  if (snapshot.startedAt !== undefined) runEntry.startedAt = snapshot.startedAt;

  const entries: SessionAgentActivityEntryV1[] = [runEntry];
  for (const agent of snapshot.agents) {
    const agentEntry: SessionAgentActivityEntryV1 = {
      entryId: buildAgentActivityEntryId({
        kind: 'workflow_agent',
        runId: snapshot.runId,
        agentId: agent.id,
      }),
      kind: 'workflow_agent',
      title: agent.title,
      status: fromWorkflowAgentStatus(agent.status),
      updatedAt: agent.updatedAt,
      runId: snapshot.runId,
      parentId: runEntryId,
    };
    if (agent.startedAt !== undefined) agentEntry.startedAt = agent.startedAt;
    // The open target, copied only when the record proves one. A workflow agent has no owning tool
    // call to route through, so this id is the whole of what makes its row openable — and minting
    // one here for an agent whose sidecar was never imported would make the row press into nothing.
    if (agent.sidechainId !== undefined) agentEntry.sidechainId = agent.sidechainId;
    entries.push(agentEntry);
  }
  return entries;
}
