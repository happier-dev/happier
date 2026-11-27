import type {
  AgentStateRequestStore,
  AgentStateResponseTargetDispatch,
} from '@/agent/permissions/agentStateRequestStore';
import {
  readExecutionRunParentSessionPermissionResponseTarget,
  type ExecutionRunParentSessionPermissionResponseTarget,
} from '@/agent/executionRuns/policy/executionRunPermissionInteractionPolicy';
import { logger } from '@/ui/logger';
import type { PermissionResult } from '@/agent/permissions/BasePermissionHandler';
import { resolveNativePermissionChoice } from '@/agent/permissions/nativePermissionChoice';
import { StructuredQuestionAnswersV1Schema, StructuredQuestionAnswerDetailsV1Schema } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';

export type { ExecutionRunParentSessionPermissionResponseTarget };

export type ExecutionRunPermissionRequestStore = Readonly<
  Pick<AgentStateRequestStore, 'publishRequest' | 'registerResponseTargetHandler'>
  & Partial<Pick<AgentStateRequestStore,
    'rebindPersistenceTargetFrom' | 'listOutstandingRequests' | 'readOutstandingRequest'
    | 'publishRequestAndWait' | 'completeRequest' | 'retireCompletedRequestsForTurn' | 'cancelRunQuestions'
    | 'captureRequestApplication' | 'readAppliedCompletion' | 'recoverAppliedCompletions' | 'subscribeToRunRequestChanges'>>
>;

/** Transport projection over the request owner: never retains or decides permissions. */
export function observeExecutionRunPermissionStore(
  store: ExecutionRunPermissionRequestStore,
  changed: () => void,
): ExecutionRunPermissionRequestStore {
  return {
    ...(store.captureRequestApplication ? { captureRequestApplication: (id) => store.captureRequestApplication!(id) } : {}),
    ...(store.readAppliedCompletion ? { readAppliedCompletion: (params) => store.readAppliedCompletion!(params) } : {}),
    ...(store.recoverAppliedCompletions ? { recoverAppliedCompletions: () => store.recoverAppliedCompletions!() } : {}),
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
    ...(store.cancelRunQuestions ? { cancelRunQuestions: async (runId: string) => {
      await store.cancelRunQuestions!(runId); changed();
    } } : {}),
    ...(store.retireCompletedRequestsForTurn ? { retireCompletedRequestsForTurn: async (id: string) => {
      await store.retireCompletedRequestsForTurn!(id); changed();
    } } : {}),
    registerResponseTargetHandler: (...params) => store.registerResponseTargetHandler(...params),
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

/** Read the incumbent completion's native offer or structured answer without reducing it to a boolean. */
export function readExecutionRunPermissionResponseFromDispatch(
  dispatch: AgentStateResponseTargetDispatch,
): PermissionResult | boolean | null {
  const completed = dispatch.completedRequest;
  if (completed.nativeChoices != null) {
    return resolveNativePermissionChoice(completed.nativeChoices, completed.nativeChoice)?.result ?? null;
  }
  if (completed.structuredAnswersV1 !== undefined) {
    const answers = StructuredQuestionAnswersV1Schema.safeParse(completed.structuredAnswersV1);
    const details = completed.answerDetails === undefined ? undefined
      : StructuredQuestionAnswerDetailsV1Schema.safeParse(completed.answerDetails);
    if (!answers.success || (details && !details.success)) return null;
    return { decision: 'approved', answers: answers.data,
      ...(details?.success ? { answerDetails: details.data } : {}) };
  }
  return readExecutionRunPermissionResponseApprovedFromDispatch(dispatch);
}
