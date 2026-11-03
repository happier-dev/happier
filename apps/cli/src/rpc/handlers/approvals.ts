import { readStoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { configuration } from '@/configuration';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createProductionDaemonWorkflowRuntime } from '@/daemon/workflows/daemonRuntime';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { APPROVAL_RPC_SCOPES } from './actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { PrivateConfidentialContinuationV1Schema } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';
import { SecretFillSettlementV1Schema } from '@happier-dev/protocol/computer/v1';
import type { ActionExecutorContext, ActionExecuteResult } from '@happier-dev/protocol';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { canUseCustodianAccountForMachineRequest } from '@/daemon/lifecycle/requesterWorkAttribution';
import { projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

type ApprovalActionId = typeof ACTION_ID_FAMILIES_V1.approvals[number];

type ApprovalRpcActionExecutor = RpcActionExecutor<ApprovalActionId> & Readonly<{
  continueConfidentialApprovalRequest?: (input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
  replayApprovedApprovalRequest?: (args: Readonly<{
    artifactId: string;
    signal?: AbortSignal;
    callerAuthority?: RpcHandlerContext['callerAuthority'];
  }>) => Promise<unknown>;
}>;

type RpcRegistrar = Readonly<{
  registerHandler(
    method: string,
    handler: (input: unknown, context?: RpcHandlerContext) => Promise<unknown>,
  ): void;
}>;

async function resolveProductionActionExecutor(): Promise<ApprovalRpcActionExecutor> {
  const credentials = await readStoredCredentials().catch(() => null);
  if (!credentials) {
    return {
      execute: async () => ({
        ok: false,
        errorCode: 'not_authenticated',
        error: 'not_authenticated',
      }),
    };
  }
  // The Workflow accepted-authorization owner, composed for these credentials
  // exactly as the daemon composes it (`startDaemon`). The credential-backed
  // executor builds the canonical daemon replay currentness checker itself
  // (this daemon's Machine from settings, the active Home) and hands this owner
  // to it, so a replayed Workflow origin is rechecked like its live admission
  // instead of failing closed for want of the owner.
  const accountId = readAccountIdFromToken(credentials.token);
  return createCliActionExecutorFromCredentials({
    credentials,
    ...(accountId
      ? {
          workflowAcceptedAuthorizationCurrentness: createProductionDaemonWorkflowRuntime({
            credentials,
            accountId,
            serverId: configuration.activeServerId,
          }).isAcceptedAuthorizationCurrent,
        }
      : {}),
  });
}

export function registerApprovalRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcRegistrar;
  actionExecutor?: ApprovalRpcActionExecutor;
}>): void {
  const resolveAccountExecutor = async (context?: RpcHandlerContext): Promise<ApprovalRpcActionExecutor | null> => {
    const requester = context?.callerInputAuthorization?.requesterAccountExecutor;
    if (requester) return requester;
    // Machine access is not private Account custody. Ingress binds this
    // custodian to the current Home/installation; only its own admitted caller
    // may borrow the daemon's fallback reader. Prepared requester custody wins.
    if (!await canUseCustodianAccountForMachineRequest(context)) return null;
    return params.actionExecutor ?? await resolveProductionActionExecutor();
  };
  registerActionSpecRpcHandlers<ApprovalActionId>({
    rpcHandlerManager: params.rpcHandlerManager,
    actionExecutor: params.actionExecutor,
    resolveActionExecutor: resolveProductionActionExecutor,
    actionIds: ACTION_ID_FAMILIES_V1.approvals,
    scopes: APPROVAL_RPC_SCOPES,
  });

  params.rpcHandlerManager.registerHandler(
    RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
    async (input, context) => {
      const artifactId = input && typeof input === 'object'
        && typeof (input as { artifactId?: unknown }).artifactId === 'string'
        ? (input as { artifactId: string }).artifactId.trim()
        : '';
      if (!artifactId) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      // The admitted requester executor is produced by this same daemon's
      // ingress owner. It supplies Account custody; replay still loads and
      // validates the Artifact's immutable original execution origin.
      const executor = await resolveAccountExecutor(context);
      if (!executor) return { ok: false, errorCode: 'requester_account_material_unavailable', error: 'requester_account_material_unavailable' };
      if (!executor.replayApprovedApprovalRequest) {
        return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:approvals' };
      }
      return await executor.replayApprovedApprovalRequest({
        artifactId,
        ...(context?.signal ? { signal: context.signal } : {}),
        ...(context?.callerAuthority ? { callerAuthority: context.callerAuthority } : {}),
      });
    },
  );
  params.rpcHandlerManager.registerHandler(RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE, async (input, context) => {
    const isActionInputs = input !== null && typeof input === 'object' && 'kind' in input && input.kind === 'action_inputs';
    const failure = (code: string): ActionExecuteResult => ({ ok: false, errorCode: code, error: code });
    if (context?.callerAuthority !== 'present_user') return isActionInputs
      ? failure('present_user_required') : { status: 'refused', code: 'approval_required' };
    const parsed = PrivateConfidentialContinuationV1Schema.safeParse(input);
    if (!parsed.success) return isActionInputs ? failure('invalid_parameters') : { status: 'refused', code: 'approval_changed' };
    const continuation = parsed.data;
    const actionInputs = 'kind' in continuation;
    try {
      const executor = await resolveAccountExecutor(context);
      if (!executor?.continueConfidentialApprovalRequest) return actionInputs
        ? failure('target_unavailable') : { status: 'refused', code: 'target_unavailable' };
      const result = await executor.continueConfidentialApprovalRequest(continuation, {
        authority: context.callerAuthority, surface: 'rpc', serverId: actionInputs ? continuation.serverId : continuation.request.serverId,
        ...(actionInputs ? { defaultSessionMachineId: continuation.machineId } : {}),
        signal: context.signal,
        ...(context.machineAdmission ? {
          runtimeAccountId: context.machineAdmission.actorAccountId,
          defaultSessionMachineId: context.machineAdmission.machineId,
        } : {}),
        ...(context.verifyMachineAdmissionCurrent
          ? { verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent }
          : {}),
      });
      if (actionInputs) return result;
      if (result.ok) {
        const settlement = SecretFillSettlementV1Schema.safeParse(result.result);
        return settlement.success ? settlement.data : { status: 'unknown', code: 'delivery_unknown' };
      }
      if (result.errorCode === 'approval_execution_outcome_unknown') return { status: 'unknown', code: 'delivery_unknown' };
      const refusal = SecretFillSettlementV1Schema.safeParse({ status: 'refused', code: result.errorCode });
      if (refusal.success) return refusal.data;
      return { status: 'refused', code: result.errorCode === 'present_user_required' ? 'approval_required' : 'approval_changed' };
    } catch {
      return actionInputs ? projectUnexpectedActionFailureV1(true) : { status: 'unknown', code: 'delivery_unknown' };
    } finally {
      // Own no reusable private operand after this single admission attempt.
      const choices = actionInputs ? continuation.choices.map(entry => entry.choice) : [continuation.choice];
      for (const choice of choices) if (choice.kind === 'once') choice.value = '';
    }
  });
}
