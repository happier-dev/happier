import type { WorkflowRunStateV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowActivityListRequestV1, WorkflowRunListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { AutomationRunLifecycleOccurrenceEvidenceV1 } from '@happier-dev/protocol/automations/automationRunLifecycle';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';

/** UI-local observations of committed facts; never a retained event journal. */
export type WorkflowActivityLiveFact = Readonly<{
    key: string;
    occurredAt: number;
    coverage: 'live';
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

/** Public membership selectors, derived from the existing Run list contract. */
export type WorkflowActivityPageInput = WorkflowActivityListRequestV1;

export type WorkflowActivityObserver = Readonly<{
    onLive(batch: WorkflowActivityLiveBatch): void;
    onRetained(page: WorkflowRunListResultV1): void;
    onError?(error: unknown): void;
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
