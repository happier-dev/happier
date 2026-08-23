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
