import type {
  ActionOperationDeclarationV1,
  ActionExecuteResult,
  ActionOperationDomainRefV1,
  ActionOperationSnapshotV1,
} from '@happier-dev/protocol/actions';
import type { ActionOperationObservationV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ProjectSetupConsentFailureDetailsV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ExternalSessionOperationAccountAdmission } from '@/session/actions/externalSessions/operationRecordStore';

/** Actual guest continuation outcome, retained privately with its acquisition invocation. */
export type ManagedWorkflowContinuationResult = ActionExecuteResult &
  (Readonly<{ ok: false }> | Readonly<{ ok: true; result: WorkflowRunStartResultV1 }>);

export type HostActionOperationExecute = (context: Readonly<{
  actionRequestId?: string;
  resumeActionRequest?: true;
  signal: AbortSignal;
  requesterWorkAttributionV1?: import('@happier-dev/protocol/machines/requesterWorkAttributionV1').RequesterWorkAttributionV1;
  operationProgress: Readonly<{ update: (update: ActionOperationProgressUpdate) => void }>;
  operationOwnerUpdate: Readonly<{ update: (update: ActionOperationOwnerUpdate) => void }>;
  operationAcceptance?: import('@happier-dev/protocol').ActionExecutorContext['operationAcceptance'];
  operationCancellation?: ActionOperationCancellation;
  operationReview?: ActionOperationReviewContinuation;
  afterTerminalSuccessAcknowledged?: (effect: () => Promise<void>) => void;
  settleManagedNativeOperation?: import('@/machines/managed/managedIntentReconciler').ManagedMachineOperationSettlementContext['settleManagedNativeOperation'];
}>) => Promise<ActionExecuteResult>;

/** Host-only authority captured from the currently admitted cancellation request. */
export type ActionOperationCancellationContext = Readonly<Partial<Pick<RpcHandlerContext,
  'signal' | 'machineAdmission' | 'verifyMachineAdmissionCurrent' | 'requesterSessionBootstrap'
  | 'callerInputAuthorization' | 'originalActionEnvelope' | 'callerAuthority' | 'callerInputConstraints'>> & {
  assertCurrent(): Promise<void>;
  /** Daemon-private capture of this external-operation request, never transported. */
  externalSessionOperationAdmission?: ExternalSessionOperationAccountAdmission;
}>;

export type ActionOperationCancellation = Readonly<{
  onRequest(listener: (context?: ActionOperationCancellationContext) => void | Promise<void>): () => void;
}>;

/** Retained setup-review continuation; the original invocation owns review and re-entry. */
export type ActionOperationSetupDecision = Readonly<{ reviewedEffectDigest: string; skipForInvocation: boolean }>;

export type ActionOperationReviewContinuation = Readonly<{
  waitForResume(details: ProjectSetupConsentFailureDetailsV1, producer?: Readonly<{
    /** Null means the canonical preparation owner has admitted the current effect. */
    review(decision?: ActionOperationSetupDecision): Promise<ProjectSetupConsentFailureDetailsV1 | null>;
  }>): Promise<void>;
}>;

export type ActionOperationScope = ActionOperationSnapshotV1['scope'];
/** Private native-invocation custody, never a public receipt or grant. */
export type DeploymentTokenOperationOrigin = Readonly<{
  serverIdentityId: string;
  credentialId: string;
  environmentId: string;
}>;
export type ActionOperationQueryScope = Readonly<{
  accountId: string;
  machineId: string;
  sessionId?: string;
}>;

export type ResolvedTrackedAction = Readonly<{
  actionId: string;
  title: string;
  operation?: ActionOperationDeclarationV1;
  operationReentry?: import('@happier-dev/protocol/actions/operations/v1').ActionOperationReentryPolicyV1;
}>;

export type ActionOperationProgressUpdate = Readonly<{
  label?: string;
  phase?: string;
  queueAhead?: number;
  current?: number;
  total?: number;
  approval?: ActionApprovalRequestCreatedResult;
}>;

export type ActionOperationOwnerUpdate = Readonly<{
  state?: 'running';
  cancellation?: 'supported' | 'unsupported';
  outcome?: ActionExecuteResult;
  progress?: ActionOperationProgressUpdate;
  domainRef?: ActionOperationDomainRefV1;
  observation?: ActionOperationObservationV1 | null;
}>;

/** A projection of a lifecycle already owned by another domain. No runner or AbortController is created. */
export interface ActionOperationDomainOwner {
  readonly actionIds: readonly string[];
  list(scope: ActionOperationQueryScope): Promise<readonly import('@happier-dev/protocol/actions').ActionOperationSnapshotV1[]>;
  get(scope: ActionOperationQueryScope, operationId: string): Promise<import('@happier-dev/protocol/actions').ActionOperationSnapshotV1 | null>;
  cancel(scope: ActionOperationQueryScope, operationId: string, context?: ActionOperationCancellationContext): Promise<import('@happier-dev/protocol/actions').ActionOperationCancelV1Response | null>;
  refreshSetupReview?(scope: ActionOperationQueryScope, operationId: string): Promise<void>;
  decideSetupReview?(scope: ActionOperationQueryScope, operationId: string,
    workspace: import('@happier-dev/protocol/workspaces/workspaceRefV1').WorkspaceAddressV1,
    phase: 'setup' | 'teardown', decision: ActionOperationSetupDecision): Promise<ActionOperationSnapshotV1 | null>;
  waitForTerminal?(scope: ActionOperationQueryScope, operationId: string, signal?: AbortSignal,
    options?: Readonly<{ includeSetupReview?: true; includeManagedPrompt?: true }>): Promise<ActionOperationSnapshotV1 | null>;
  subscribe(input: Readonly<{
    resolveScope(): Promise<ActionOperationQueryScope | null>;
    publishSnapshot(snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1): void;
  }>): () => void;
}
