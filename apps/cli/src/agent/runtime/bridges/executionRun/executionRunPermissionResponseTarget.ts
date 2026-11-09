import type {
  AgentStateRequestResponseTarget,
  AgentStateRequestStoreUnsubscribe,
  AgentStateResponseTargetDispatch,
  AgentStateResponseTargetHandler,
} from '@/agent/permissions/agentStateRequestStore';
import {
  readExecutionRunParentSessionPermissionResponseTarget,
  type ExecutionRunParentSessionPermissionResponseTarget,
} from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import type { StructuredQuestionAnswersV1 } from '@happier-dev/protocol';
import type { StructuredQuestionAnswerDetailsV1 } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';
import { logger } from '@/ui/logger';

export type { ExecutionRunParentSessionPermissionResponseTarget };

export type ExecutionRunPermissionRequestStore = Readonly<{
  /** Host-private, same-scope persistence adoption; response registrations stay with this store. */
  rebindPersistenceTargetFrom?(next: unknown): boolean;
  listOutstandingRequests?(): readonly Readonly<{ requestId: string; createdAt?: number; responseTarget?: AgentStateRequestResponseTarget }>[];
  readOutstandingRequest?(requestId: string): Readonly<{
    responseTarget?: AgentStateRequestResponseTarget;
  }> | null;
  publishRequest(params: Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
    kind?: string;
    source?: string;
    responseTarget?: AgentStateRequestResponseTarget | null;
    subagentRef?: unknown;
    sidechainId?: string | null;
    permissionSuggestions?: readonly unknown[] | null;
  }>): void;
  publishRequestAndWait?(params: Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
    kind?: string;
    source?: string;
    responseTarget?: AgentStateRequestResponseTarget | null;
    subagentRef?: unknown;
    sidechainId?: string | null;
    permissionSuggestions?: readonly unknown[] | null;
  }>): Promise<void>;
  completeRequest?(params: Readonly<{
    requestId: string;
    status: string;
    decision?: string;
    reason?: string;
    answers?: StructuredQuestionAnswersV1;
    answerDetails?: StructuredQuestionAnswerDetailsV1;
  }>): Promise<boolean> | boolean;
  retireCompletedRequestsForTurn?(turnId: string): Promise<void>;
  registerResponseTargetHandler(
    kind: 'execution_run_host_bridge',
    handler: AgentStateResponseTargetHandler,
  ): AgentStateRequestStoreUnsubscribe;
}>;

/** Transport projection over the request owner: never retains or decides permissions. */
export function observeExecutionRunPermissionStore(
  store: ExecutionRunPermissionRequestStore,
  changed: () => void,
): ExecutionRunPermissionRequestStore {
  return {
    ...(store.listOutstandingRequests ? { listOutstandingRequests: () => store.listOutstandingRequests!() } : {}),
    ...(store.readOutstandingRequest ? { readOutstandingRequest: (id) => store.readOutstandingRequest!(id) } : {}),
    publishRequest: (params) => {
      if (store.publishRequestAndWait) {
        void store.publishRequestAndWait(params).then(changed).catch((error: unknown) => {
          logger.debug('[EXECUTION RUN] Failed to publish permission request (non-fatal)', error);
        });
      } else { store.publishRequest(params); changed(); }
    },
    ...(store.publishRequestAndWait ? { publishRequestAndWait: async (params: Parameters<NonNullable<ExecutionRunPermissionRequestStore['publishRequestAndWait']>>[0]) => {
      await store.publishRequestAndWait!(params); changed();
    } } : {}),
    ...(store.completeRequest ? { completeRequest: async (params: Parameters<NonNullable<ExecutionRunPermissionRequestStore['completeRequest']>>[0]) => {
      const completed = await store.completeRequest!(params); changed(); return completed;
    } } : {}),
    ...(store.retireCompletedRequestsForTurn ? { retireCompletedRequestsForTurn: async (id: string) => {
      await store.retireCompletedRequestsForTurn!(id); changed();
    } } : {}),
    registerResponseTargetHandler: (kind, handler) => store.registerResponseTargetHandler(kind, handler),
  };
}

export type ExecutionRunPermissionRequestStoreProvider = () => ExecutionRunPermissionRequestStore | null | undefined;

export function readExecutionRunPermissionResponseTargetFromDispatch(
  dispatch: AgentStateResponseTargetDispatch,
): ExecutionRunParentSessionPermissionResponseTarget | null {
  return readExecutionRunParentSessionPermissionResponseTarget(dispatch.responseTarget);
}

export function readExecutionRunPermissionResponseApprovedFromDispatch(
  dispatch: AgentStateResponseTargetDispatch,
): boolean | null {
  const completed = dispatch.completedRequest;
  const status = typeof completed.status === 'string' ? completed.status.trim() : '';
  if (status === 'approved') return true;
  if (status === 'denied' || status === 'canceled' || status === 'cancelled') return false;

  const decision = typeof completed.decision === 'string' ? completed.decision.trim() : '';
  if (
    decision === 'approved'
    || decision === 'approved_for_session'
    || decision === 'approved_execpolicy_amendment'
  ) {
    return true;
  }
  if (decision === 'denied' || decision === 'abort') return false;
  return null;
}
