import type {
  ActionOperationDeclarationV1,
  ActionOperationDomainRefV1,
  ActionOperationSnapshotV1,
} from '@happier-dev/protocol/actions';
import type { ActionOperationObservationV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ProjectSetupConsentFailureDetailsV1 } from '@happier-dev/protocol/actions/projectActionFamily';

/** Retained no-effect continuation; the original invocation owns review and re-entry. */
export type ActionOperationReviewContinuation = Readonly<{
  waitForResume(details: ProjectSetupConsentFailureDetailsV1, producer?: Readonly<{
    /** Null means the canonical preparation owner has admitted the current effect. */
    review(): Promise<ProjectSetupConsentFailureDetailsV1 | null>;
  }>): Promise<void>;
}>;

export type ActionOperationScope = ActionOperationSnapshotV1['scope'];
export type ActionOperationQueryScope = Readonly<{
  accountId: string;
  machineId: string;
  sessionId?: string;
}>;

export type ResolvedTrackedAction = Readonly<{
  actionId: string;
  title: string;
  operation?: ActionOperationDeclarationV1;
}>;

export type ActionOperationProgressUpdate = Readonly<{
  label?: string;
  phase?: string;
  queueAhead?: number;
  current?: number;
  total?: number;
}>;

export type ActionOperationOwnerUpdate = Readonly<{
  state?: 'running';
  progress?: ActionOperationProgressUpdate;
  domainRef?: ActionOperationDomainRefV1;
  observation?: ActionOperationObservationV1 | null;
}>;

/** A projection of a lifecycle already owned by another domain. No runner or AbortController is created. */
export interface ActionOperationDomainOwner {
  readonly actionIds: readonly string[];
  list(scope: ActionOperationQueryScope): Promise<readonly import('@happier-dev/protocol/actions').ActionOperationSnapshotV1[]>;
  get(scope: ActionOperationQueryScope, operationId: string): Promise<import('@happier-dev/protocol/actions').ActionOperationSnapshotV1 | null>;
  cancel(scope: ActionOperationQueryScope, operationId: string): Promise<import('@happier-dev/protocol/actions').ActionOperationCancelV1Response | null>;
  subscribe(input: Readonly<{
    resolveScope(): Promise<ActionOperationQueryScope | null>;
    publishSnapshot(snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1): void;
  }>): () => void;
}
