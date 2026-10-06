import type {
  ActionOperationDeclarationV1,
  ActionOperationDomainRefV1,
  ActionOperationSnapshotV1,
} from '@happier-dev/protocol/actions';

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
  current?: number;
  total?: number;
}>;

export type ActionOperationOwnerUpdate = Readonly<{
  progress?: ActionOperationProgressUpdate;
  domainRef?: ActionOperationDomainRefV1;
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
