import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import type { WorkflowRunStateV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowActivityListRequestV1, WorkflowRunListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { AutomationRunLifecycleOccurrenceEvidenceV1 } from '@happier-dev/protocol/automations/automationRunLifecycle';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

/** Live observations, retained Machine transitions, and retained Run finishes. */
export type WorkflowActivityLiveFact = Readonly<{
    key: string;
    occurredAt: number;
    coverage: 'live' | 'retained';
}> & (
    | Readonly<{ kind: 'session'; sessionId: string; event: 'started' | 'archived'; sourceRevision: number }>
    | Readonly<{ kind: 'session'; sessionId: string; event: 'turn_started'; turnId: string; sourceRevision: number }>
    | Readonly<{ kind: 'machine'; machineId: string; event: 'online' | 'offline'; sourceRevision: number }>
    | Readonly<{ kind: 'run'; runId: string; event: 'terminal' | 'needs_attention'; sourceRevision: number; state: WorkflowRunStateV1 }>
);

export type WorkflowActivityLiveBatch = readonly WorkflowActivityLiveFact[];

/** Frozen source evidence from an admitted child Run, without reconstructed source state. */
export type WorkflowActivityRetainedCauseFact = Readonly<{
    key: string;
    kind: 'run';
    runId: string;
    event: AutomationRunLifecycleOccurrenceEvidenceV1['condition'];
    sourceRevision: number;
    occurredAt: number;
    coverage: 'retained_cause';
    evidence: AutomationRunLifecycleOccurrenceEvidenceV1;
}>;
export type WorkflowActivityFact = WorkflowActivityLiveFact | WorkflowActivityRetainedCauseFact;

/** Presentation identity of a source Event; trigger ids namespace child admissions, not this row. */
export function workflowActivityRunEventKey(
    source: AutomationRunLifecycleOccurrenceEvidenceV1['source'],
    condition: AutomationRunLifecycleOccurrenceEvidenceV1['condition'],
    sourceRevision: number,
): string {
    return createCanonicalJsonSigningInput(['runLifecycle', source, condition, sourceRevision]);
}

/** Both pushed changes and retained membership describe the same Run occurrence. */
export function projectWorkflowActivityRunFact(
    run: WorkflowRunSummaryV1,
    event: 'terminal' | 'needs_attention',
    coverage: 'live' | 'retained',
): WorkflowActivityLiveFact | null {
    const at = event === 'terminal'
        ? isTerminalAutomationRunStateV3(run.state) ? run.finishedAt : null
        : run.attentionRequired ? run.updatedAt : null;
    if (!at) return null;
    return { kind: 'run', runId: run.id, event, state: run.state, sourceRevision: run.revision,
        occurredAt: Date.parse(at), coverage,
        key: workflowActivityRunEventKey({ kind: 'workflow_run', runId: run.id }, event, run.revision) };
}

/** Public membership selectors, derived from the existing Run list contract. */
export type WorkflowActivityPageInput = WorkflowActivityListRequestV1;

export type WorkflowActivityObserver = Readonly<{
    onLive(batch: WorkflowActivityLiveBatch): void;
    /** A new observer receives the current window. Later publications include only changed Runs. */
    onRetained(page: WorkflowRunListResultV1, changedRuns: readonly WorkflowRunSummaryV1[]): void;
    onError?(error: unknown): void;
    onHistoryError?(error: unknown): void;
}>;

/** The source owns requested Run membership; the projection accumulates facts through shared frames. */
export type WorkflowActivitySource = Readonly<{
    acquire(observer: WorkflowActivityObserver): () => void;
    hasDemand(): boolean;
    listeningSince(): number | null;
    readPage(input?: WorkflowActivityPageInput): Promise<WorkflowRunListResultV1>;
    /** Extend the shared demanded Run window through its current continuation. */
    loadMore(): Promise<void>;
    retry(): Promise<void>;
}>;
