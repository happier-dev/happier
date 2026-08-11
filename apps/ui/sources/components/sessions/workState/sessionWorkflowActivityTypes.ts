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
    /**
     * The durable sidechain holding this agent's own transcript, when the importer registered one.
     *
     * Carried so an agent drawn INSIDE a run panel asks the one open-target resolver the same
     * question a listed roster row asks. Without it the panel's rows were structurally unopenable:
     * every agent of a LIVE run is parented, so the partition folds all of them here, and the
     * compact popover — the only agent surface a phone has — draws this panel. A transcript
     * reachable only from a listed row was a transcript reachable only with a pane open.
     *
     * Proof, never intent (the producer writes it only after importing the sidecar), so absence
     * means "nothing to open" rather than "not yet".
     */
    sidechainId?: string;
    /**
     * Genuine provider timestamps, in epoch ms, carried through so the shared agent row owns the
     * duration column. Both are optional at the source and are never back-filled from each other:
     * borrowing a finish instant for a missing start is D-8, which told every reader that a
     * sixteen-second run took none.
     */
    startedAtMs?: number;
    endedAtMs?: number;
    /**
     * The last moment the producer has evidence of this agent doing something, in epoch ms.
     *
     * Carried so a run-panel agent row can take part in the silence rule (4.10) like every other
     * agent row. Without it the row defaulted to `'fresh'` forever: an agent that had been quiet
     * for hours kept a turning spinner and a running clock inside an expanded run.
     */
    updatedAtMs?: number;
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
