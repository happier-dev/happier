import type { WorkflowRunStateV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowRunListRequestV1, WorkflowRunListResultV1 } from '@happier-dev/protocol/workflows/actionsV1';

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

/** Public membership selectors, derived from the existing Run list contract. */
export type WorkflowActivityPageInput = Omit<WorkflowRunListRequestV1,
    'projection' | 'originDiscussionId' | 'targetSessionId' | 'underSessionId' | 'invocationProvenance'>;

export type WorkflowActivityObserver = Readonly<{
    onLive(batch: WorkflowActivityLiveBatch): void;
    onRetained(page: WorkflowRunListResultV1): void;
    onError?(error: unknown): void;
}>;

/** Acquisition only; the shared Events projection owns accumulation, frames and windows. */
export type WorkflowActivitySource = Readonly<{
    acquire(observer: WorkflowActivityObserver): () => void;
    hasDemand(): boolean;
    listeningSince(): number | null;
    readPage(input?: WorkflowActivityPageInput): Promise<WorkflowRunListResultV1>;
    retry(): Promise<void>;
}>;
