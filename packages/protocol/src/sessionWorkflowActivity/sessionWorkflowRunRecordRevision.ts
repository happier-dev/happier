import type {
  SessionWorkflowAgentSnapshotV1,
  SessionWorkflowPhaseSnapshotV1,
  SessionWorkflowRunSnapshotV1,
} from './sessionWorkflowRunSnapshotV1.js';

export const SESSION_WORKFLOW_RUN_RECORD_REVISION_PATTERN = /^\d+$/;

/**
 * `recordRevision` is a per-run, strictly monotonic decimal string. It is produced only by the
 * activity publisher after a material durable-record change. It must NOT be derived from
 * wall-clock time, headline metadata, `metadataVersion`, or UI fetch state.
 *
 * @param previous the previous committed revision (or undefined for a run's first publication)
 * @param materialChange whether the normalized snapshot materially changed vs the previous one
 */
export function bumpWorkflowRunRecordRevision(previous: string | undefined, materialChange: boolean): string {
  const current = parseRevision(previous);
  return (current + (materialChange ? 1n : 0n)).toString();
}

function parseRevision(value: string | undefined): bigint {
  if (typeof value !== 'string') return 0n;
  const trimmed = value.trim();
  if (!SESSION_WORKFLOW_RUN_RECORD_REVISION_PATTERN.test(trimmed)) return 0n;
  try {
    return BigInt(trimmed);
  } catch {
    return 0n;
  }
}

/**
 * Decide whether two normalized run snapshots differ materially per the W1 material-change
 * table. Display-ordering timestamps (`updatedAt` at run and agent level) and the bookkeeping
 * `recordRevision` are NOT material; everything else — status, ids, titles, source revision,
 * phases (order/title/membership), agent fields, aggregate counts, and lifecycle timestamps —
 * is material.
 */
export function isWorkflowRunSnapshotMaterialChange(
  previous: SessionWorkflowRunSnapshotV1 | undefined,
  next: SessionWorkflowRunSnapshotV1,
): boolean {
  if (!previous) return true;
  return serializeMaterialProjection(previous) !== serializeMaterialProjection(next);
}

type MaterialAgentProjection = Readonly<{
  id: string;
  title: string;
  status: string;
  vendorRef?: string;
  /** Openability: gaining, losing or moving a transcript changes what the row can do. */
  sidechainId?: string;
  parentId?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  summary?: string;
  resultPreview?: string;
  tokensUsed?: number;
  toolCalls?: number;
  timeUsedSeconds?: number;
  startedAt?: number;
  completedAt?: number;
}>;

type MaterialPhaseProjection = Readonly<{
  id: string;
  title?: string;
  order?: number;
  agentIds: readonly string[];
}>;

function projectMaterialAgent(agent: SessionWorkflowAgentSnapshotV1): MaterialAgentProjection {
  // Deliberately excludes `agent.updatedAt` (display-ordering only). Ordered explicitly so the
  // serialized comparison is stable regardless of source key order.
  return {
    id: agent.id,
    title: agent.title,
    status: agent.status,
    vendorRef: agent.vendorRef,
    sidechainId: agent.sidechainId,
    parentId: agent.parentId,
    phaseIndex: agent.phaseIndex,
    phaseTitle: agent.phaseTitle,
    model: agent.model,
    summary: agent.summary,
    resultPreview: agent.resultPreview,
    tokensUsed: agent.tokensUsed,
    toolCalls: agent.toolCalls,
    timeUsedSeconds: agent.timeUsedSeconds,
    startedAt: agent.startedAt,
    completedAt: agent.completedAt,
  };
}

function projectMaterialPhase(phase: SessionWorkflowPhaseSnapshotV1): MaterialPhaseProjection {
  return {
    id: phase.id,
    title: phase.title,
    order: phase.order,
    // Membership is set-semantic: reordering agent ids within a phase is not material.
    agentIds: [...phase.agentIds].sort(),
  };
}

function serializeMaterialProjection(snapshot: SessionWorkflowRunSnapshotV1): string {
  const projection = {
    runId: snapshot.runId,
    backendId: snapshot.backendId,
    agentId: snapshot.agentId,
    title: snapshot.title,
    status: snapshot.status,
    statusReason: snapshot.statusReason,
    vendorRef: snapshot.vendorRef,
    workflowToolUseId: snapshot.workflowToolUseId,
    sourceSessionId: snapshot.sourceSessionId,
    sourceRevision: snapshot.sourceRevision,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    totalAgents: snapshot.totalAgents,
    completedAgents: snapshot.completedAgents,
    failedAgents: snapshot.failedAgents,
    blockedAgents: snapshot.blockedAgents,
    cancelledAgents: snapshot.cancelledAgents,
    tokensUsed: snapshot.tokensUsed,
    toolCalls: snapshot.toolCalls,
    timeUsedSeconds: snapshot.timeUsedSeconds,
    // Phase order IS material, so phases stay in array order.
    phases: snapshot.phases.map(projectMaterialPhase),
    // Agent array order is arrival-derived display only; compare as a stable id-sorted set.
    agents: [...snapshot.agents]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(projectMaterialAgent),
  };
  return JSON.stringify(projection);
}
