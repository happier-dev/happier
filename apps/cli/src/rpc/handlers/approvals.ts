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
import { PrivateSecretContinuationV1Schema } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';
import { SecretFillSettlementV1Schema } from '@happier-dev/protocol/computer/v1';
import type { ActionExecutorContext, ActionExecuteResult } from '@happier-dev/protocol';

type ApprovalRpcActionExecutor = RpcActionExecutor & Readonly<{
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
  registerActionSpecRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    actionExecutor: params.actionExecutor,
    resolveActionExecutor: resolveProductionActionExecutor,
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
      const executor = context?.callerInputAuthorization?.requesterAccountExecutor
        ?? params.actionExecutor ?? await resolveProductionActionExecutor();
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
    if (context?.callerAuthority !== 'present_user') return { status: 'refused', code: 'approval_required' };
    const parsed = PrivateSecretContinuationV1Schema.safeParse(input);
    if (!parsed.success) return { status: 'refused', code: 'approval_changed' };
    try {
      const executor = params.actionExecutor ?? await resolveProductionActionExecutor();
      if (!executor.continueConfidentialApprovalRequest) return { status: 'refused', code: 'target_unavailable' };
      const result = await executor.continueConfidentialApprovalRequest(parsed.data, {
        authority: context.callerAuthority, surface: 'rpc', serverId: parsed.data.request.serverId,
        signal: context.signal,
        ...(context.machineAdmission ? {
          runtimeAccountId: context.machineAdmission.actorAccountId,
          defaultSessionMachineId: context.machineAdmission.machineId,
        } : {}),
        ...(context.verifyMachineAdmissionCurrent
          ? { verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent }
          : {}),
      });
      if (result.ok) {
        const settlement = SecretFillSettlementV1Schema.safeParse(result.result);
        return settlement.success ? settlement.data : { status: 'unknown', code: 'delivery_unknown' };
      }
      if (result.errorCode === 'approval_execution_outcome_unknown') return { status: 'unknown', code: 'delivery_unknown' };
      const refusal = SecretFillSettlementV1Schema.safeParse({ status: 'refused', code: result.errorCode });
      if (refusal.success) return refusal.data;
      return { status: 'refused', code: result.errorCode === 'present_user_required' ? 'approval_required' : 'approval_changed' };
    } catch {
      return { status: 'unknown', code: 'delivery_unknown' };
    } finally {
      // Own no reusable private operand after this single admission attempt.
      if (parsed.data.choice.kind === 'once') parsed.data.choice.value = '';
    }
  });
}
