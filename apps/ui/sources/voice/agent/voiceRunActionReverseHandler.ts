import { VoiceRunActionDispatchRequestV1Schema, UiActionDispatchResultV1Schema,
  voiceRunActionClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { projectKnownAccountAuthorityRetirementReceipt } from '@happier-dev/protocol/actions/accountAuthorityRetirement';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { storage } from '@/sync/domains/state/storage';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import { resolveBoundTargetSessionAddress } from './voiceAgentRunState';
import { readAdmittedVoiceSessionExecutionTarget } from '@/voice/session/voiceSessionStore';
import { createVoiceToolHandlers } from '@/voice/tools/handlers';
import { projectVoiceActionExecutionResult } from '@/voice/tools/voiceActionResult';
import { resolveToolSessionId } from '@/voice/tools/resolveToolSessionId';
import { resolveVoiceActionExecution } from '@/voice/tools/voiceActionExecution';
import { redactVoiceActionExecutionResultForProvider } from '@/voice/context/redactVoiceToolResult';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { createActionApprovalContinuationObserver, resumeActionExecutionResult } from '@/components/approvals/actionApprovalContinuation';
import { observeActionApprovalContinuation } from '@/components/approvals/observeActionApprovalContinuation';
import { showApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { Modal } from '@/modal';
import { captureLazyActionAccountContext, withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { VoiceAgentHandle } from './types';

/** The Machine-authenticated per-Run room owns provenance; the request carries only operands. */
export function createVoiceRunActionReverseHandler(handle: VoiceAgentHandle, controlSessionId: string) {
  const failure = (errorCode: string) => ({ v: 1 as const,
    execution: { ok: false as const, errorCode, error: errorCode } });
  return async (raw: unknown, context?: Readonly<{ signal: AbortSignal }>) => {
    const parsed = VoiceRunActionDispatchRequestV1Schema.safeParse(raw);
    if (!parsed.success) return failure('invalid_action_input');
    if (!context || context.signal.aborted || handle.signal?.aborted || !handle.accountLifetime.isCurrent()) {
      return failure('target_unavailable');
    }
    const request = parsed.data;
    if (request.voiceRun.runId !== handle.voiceAgentId || request.voiceRun.sessionId !== handle.rpcSessionId) {
      return failure('target_unavailable');
    }
    if (!handle.actionInvocation) return failure('admission_unavailable');
    const binding = resolveVoiceBindingBySessionId({ sessionId: controlSessionId });
    const target = resolveBoundTargetSessionAddress(controlSessionId);
    const serverId = handle.accountLifetime.scope.serverId;
    const turn = handle.toolTurnContext?.current;
    const tools = createVoiceToolHandlers({
      voiceSessionBinding: binding, currentSessionAddress: target, currentServerId: serverId,
      currentExecutionTarget: binding ? readAdmittedVoiceSessionExecutionTarget({ adapterId: binding.adapterId,
        controlSessionId: binding.controlSessionId, serverId }) : null,
      readVoiceAgentHandle: () => handle,
      ...(turn?.playHostText ? { playHostText: turn.playHostText } : {}),
      resolveSessionId: explicitSessionId => resolveToolSessionId({ explicitSessionId,
        currentSessionId: target?.sessionId ?? null, currentServerId: target?.serverId ?? serverId }),
    });
    const turnOrigin = turn?.turnOrigin;
    const spec = getActionSpec(request.actionId);
    const dismissal = new AbortController();
    const cancellation = mergeAbortSignals([context.signal, handle.signal, dismissal.signal]);
    let reviewId: string | null = null;
    const closeReview = () => {
      if (reviewId === null) return;
      const id = reviewId;
      reviewId = null;
      Modal.hide(id);
    };
    let stopApprovalObservation: (() => void) | undefined;
    let approvalAccount: ReturnType<typeof captureLazyActionAccountContext> | undefined;
    try {
      return await withActionAccountRequestSignal(handle, cancellation.signal, async signal => {
        const execution: unknown = JSON.parse(await tools.action_execute!({ actionId: request.actionId, input: request.input }, {
          signal, serverId, turnOrigin, effectId: request.voiceRun.actionRequestId,
        }));
        const result = UiActionDispatchResultV1Schema.safeParse({ v: 1,
          execution: projectVoiceActionExecutionResult(request.actionId, execution) });
        if (!result.success) return failure('invalid_action_output');
        const settled = await resumeActionExecutionResult({ result: result.data.execution, actionId: request.actionId,
          scope: handle.accountLifetime.scope, signal,
          aborted: () => failure(dismissal.signal.aborted ? 'cancelled' : 'action_account_scope_changed').execution,
          requestId: request.voiceRun.actionRequestId,
          onApprovalPending: registration => {
            const observer = createActionApprovalContinuationObserver({ onExecuted: () => {} });
            const deliver = observer.subscribe(() => observer.deliverSettlement());
            const observe = observeActionApprovalContinuation({ observer, scope: handle.accountLifetime.scope,
              isCurrent: () => !signal?.aborted && handle.accountLifetime.isCurrent(),
              fetchArtifact: async artifactId => {
                approvalAccount ??= captureLazyActionAccountContext(serverId, signal);
                return (await approvalAccount).fetchArtifact(artifactId, { signal });
              } });
            stopApprovalObservation = () => { observe(); deliver(); observer.dispose(); };
            observer.requestApproval(registration);
            let answered = false;
            reviewId = showApprovalReview({ artifactId: registration.artifactId, serverId,
              onDecisionRecorded: () => { answered = true; },
              onDismissed: () => {
                closeReview();
                if (!answered && !signal?.aborted) dismissal.abort();
              },
            });
          } });
        if (!handle.accountLifetime.isCurrent()) {
          const receipt = projectKnownAccountAuthorityRetirementReceipt(spec, settled);
          if (!receipt) return failure(spec.sideEffectClass === 'read' || spec.sideEffectClass === 'none'
            ? 'action_account_scope_changed' : 'outcome_uncertain');
          return { v: 1 as const, execution: receipt };
        }
        const toolName = resolveVoiceActionExecution({ actionId: request.actionId, input: request.input })?.toolName ?? '';
        return UiActionDispatchResultV1Schema.parse({ v: 1, execution: redactVoiceActionExecutionResultForProvider(
          toolName, settled, readVoicePrivacySettings(storage.getState().settings)) });
      });
    } catch (error) {
      return { v: 1 as const, execution: { ok: false as const, ...normalizeActionExecutorThrownError(error) } };
    } finally {
      closeReview();
      stopApprovalObservation?.();
      if (approvalAccount) void approvalAccount.then(account => account.dispose(), () => {});
      cancellation.dispose();
    }
  };
}

export function registerVoiceRunActionReverseHandler(handle: VoiceAgentHandle, controlSessionId: string, machineId: string): void {
  if (!handle.actionInvocation || handle.signal?.aborted || !handle.accountLifetime.isCurrent()) return;
  const unregister = apiSocket.registerMachineScopedRpcHandler(machineId, voiceRunActionClientRpcMethod(handle.voiceAgentId),
    createVoiceRunActionReverseHandler(handle, controlSessionId), { settleInFlight: true });
  let retirement: Readonly<{ dispose(): void }> | undefined;
  const dispose = () => {
    unregister(); retirement?.dispose(); handle.signal?.removeEventListener('abort', dispose);
  };
  retirement = handle.accountLifetime.onRetire(dispose);
  handle.signal?.addEventListener('abort', dispose, { once: true });
  if (handle.signal?.aborted) dispose();
}
