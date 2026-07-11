import type {
    SessionWorkflowActivityHeadlineV1,
    SessionWorkflowAgentStatusV1,
    SessionWorkflowRunHeadlineV1,
    SessionWorkflowRunSnapshotV1,
    SessionWorkflowRunStatusV1,
} from '@happier-dev/protocol';

/**
 * UI view-model layer for workflow activity (UIW1). These types are derived ENTIRELY from the
 * provider-agnostic protocol contracts (`SessionWorkflowActivityHeadlineV1` /
 * `SessionWorkflowRunSnapshotV1`). The UI never parses Claude-native events — it only reshapes the
 * normalized snapshot/headline into row/phase view models that virtualized list rows can memoize
 * from primitive props.
 *
 * Plural-safety invariant: every row id and cache/expansion key combines `runId` so two concurrent
 * workflows whose agents share a provider id cannot collide.
 */

export type {
    SessionWorkflowActivityHeadlineV1,
    SessionWorkflowAgentStatusV1,
    SessionWorkflowRunHeadlineV1,
    SessionWorkflowRunSnapshotV1,
    SessionWorkflowRunStatusV1,
};

/** Per-phase (and per-run) status rollup. Counts are exact and provider-agnostic. */
export type WorkflowPhaseRollup = Readonly<{
    total: number;
    complete: number;
    failed: number;
    blocked: number;
    active: number;
    pending: number;
    cancelled: number;
    unknown: number;
}>;

/** Primitive agent row props — memoizable, no nested objects beyond optional metrics. */
export type WorkflowAgentRowViewModel = Readonly<{
    rowId: string;
    runId: string;
    agentId: string;
    title: string;
    status: SessionWorkflowAgentStatusV1;
    phaseId?: string;
    phaseTitle?: string;
    model?: string;
    tokensUsed?: number;
    toolCalls?: number;
    timeUsedSeconds?: number;
    resultPreview?: string;
    summary?: string;
}>;

/** A phase grouping with its rollup and ordered agent rows. */
export type WorkflowPhaseViewModel = Readonly<{
    id: string;
    runId: string;
    title?: string;
    order?: number;
    rollup: WorkflowPhaseRollup;
    agents: readonly WorkflowAgentRowViewModel[];
}>;

/**
 * Flattened, phase-primary virtualization row. `phaseHeader` rows carry rollups; `agent` rows carry
 * primitive display props. Row kinds are stable so `getItemType` can keep estimated sizes stable.
 */
export type WorkflowActivityRowViewModel =
    | Readonly<{
        kind: 'phaseHeader';
        rowId: string;
        runId: string;
        phaseId: string;
        title?: string;
        order?: number;
        fallback?: 'activity';
        rollup: WorkflowPhaseRollup;
    }>
    | Readonly<{
        kind: 'agent';
        rowId: string;
        runId: string;
        phaseId?: string;
        agent: WorkflowAgentRowViewModel;
    }>;

/** Loaded-detail state for one run, keyed off the durable `activity/workflow_run.v1` record. */
export type WorkflowRunDetailState =
    | Readonly<{ state: 'loading'; runId: string }>
    | Readonly<{ state: 'missing'; runId: string }>
    | Readonly<{ state: 'loaded'; runId: string; snapshot: SessionWorkflowRunSnapshotV1 }>;
