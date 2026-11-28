import type { ResolvedSessionTransport } from '../actions/cliActionDeps/types';
import type { CliActionDepsParams } from '../actions/cliActionDeps/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteFailure, ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { HandoffTargetReplacementPreflightResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { resolveSessionHandoffSourceAuthority } from '@/session/handoff/resolveSessionHandoffSourceAuthority';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { projectActionFailureCauseV1, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope, readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { logger } from '@/ui/logger';
import type { CliMachineActionCall } from '@/session/actions/cliActionDeps/machineTransport';
import { isOriginalAccountActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionTransportContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

function readOriginalAccountHandoffRoot(context?: ActionExecutorContext) {
  const root = context?.externalActionExecutionAuthorization;
  const admission = root?.binding.handoffAdmission;
  return root && root.binding.actionId === 'session.handoff' && admission
    && !root.binding.handoffPreflight && !root.binding.handoffContinuation
    && isOriginalAccountActionCustody(root.binding) ? { root, admission } : undefined;
}

type FamilyActionDeps = Pick<ActionExecutorDeps, 'sessionHandoffTargetReplacementApprovalPreflight' | 'sessionHandoffStart'
  | 'sessionHandoffStatusGet' | 'sessionHandoffPrepareTargetResume' | 'sessionWorkspaceReturn'>;

export function createCliSessionHandoffActionDeps(
  params: CliActionDepsParams,
  { callMachineAction, notSupported, resolveTransportForSession }: Readonly<{

    callMachineAction: CliMachineActionCall;
    notSupported: () => never;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
  }>,
): FamilyActionDeps {
  const requestRecovery = (actionId: ActionId, method: string, request: unknown, context: ActionExecutorContext): Promise<unknown> => {
    if (!params.credentials) return notSupported();
    const target = context.externalActionTarget;
    if (target?.kind !== 'machine') return Promise.resolve({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
    return callMachineAction({ machineId: target.machineId, method, request, context,
      effectActionId: actionId, exactMachine: true, ...(context.serverId ? { serverId: context.serverId } : {}),
      ...(context.signal ? { signal: context.signal } : {}) });
  };
  return {
    sessionWorkspaceReturn: ({ actionId, input, context }) => callMachineAction({
      machineId: input.machineId, method: actionId, request: input, context,
      effectActionId: actionId, exactMachine: true,
      ...(context.serverId ? { serverId: context.serverId } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    }),
    // Recovery addresses the retained job on its admitted target, independently of the source Session.
    sessionHandoffStatusGet: (input, context) => requestRecovery('session.handoff.status.get', RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3, input, context),
    sessionHandoffPrepareTargetResume: (input, context) => requestRecovery('session.handoff.prepare_target.resume', RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3, input, context),
    // One destination-approval preflight for both destination-choosing Action
    // families. Handoff expresses its intent through a workspace action; direct
    // Project linking has no Session and states its intent and mode explicitly.
    sessionHandoffTargetReplacementApprovalPreflight: async ({
      sessionId,
      targetMachineId,
      targetPath,
      workspaceAction,
      activatesExactMirror,
      destinationIntent,
      replaceRelationshipId,
      serverId,
      operationId,
      effectActionId,
      context,
      signal,
    }) => {
      const handoffChoosesDestination = workspaceAction?.kind === 'copy_once'
        || workspaceAction?.kind === 'create_relationship';
      if (!handoffChoosesDestination && destinationIntent === undefined) {
        return { type: 'not_required' as const };
      }
      if (!params.credentials || !targetPath?.trim() || !serverId?.trim() || !operationId.trim()) {
        return { type: 'error' as const, result: { ok: false, errorCode: 'invalid_input', error: 'invalid_input' } };
      }
      const mirrors = activatesExactMirror
        ?? (workspaceAction?.kind === 'create_relationship' && workspaceAction.mode === 'mirror_exactly');
      const refuse = (failure: ActionExecuteFailure, cause: unknown) => {
        const failureCause = projectActionFailureCauseV1(cause, 'session.handoff.replacement_preflight',
          { allowUnknownErrorCode: failure.errorCode === 'peer_unavailable' });
        if (failure.errorCode === 'peer_unavailable') {
          const requestId = context.actionRequestId ?? operationId;
          // Caller-authored IDs can contain arbitrary text. Native Session IDs
          // at this boundary are opaque UUIDs.
          const opaqueId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(requestId);
          try {
            logger.warnLocalFile('[Workspace Sync] Target preflight refused', {
              ...(opaqueId ? { requestId } : {}), failureCause,
            });
          } catch { /* A local log failure cannot replace the original refusal. */ }
        }
        return { type: 'error' as const, result: { ...failure, failureCause } };
      };
      try {
        const rpc = {
          machineId: targetMachineId,
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
          request: {
            v: 1,
            serverId: serverId.trim(),
            machineId: targetMachineId,
            operationId: operationId.trim(),
            targetPath: targetPath.trim(),
            ...(mirrors ? { activatesExactMirror: true } : {}),
            ...(destinationIntent ? { destinationIntent } : {}),
            ...(replaceRelationshipId ? { replaceRelationshipId } : {}),
          },
          ...(signal ? { signal } : {}),
        };
        const handoff = effectActionId === 'session.handoff' ? readOriginalAccountHandoffRoot(context) : undefined;
        let raw: unknown;
        if (handoff) {
          // Destination inspection follows the app's ordinary Account RPC. The
          // target still enforces Manage and owns the destination-path decision.
          const requester = readRequesterAccountActionTransportContext(handoff.root);
          if (!requester || handoff.admission.sessionId !== sessionId || handoff.admission.targetMachineId !== targetMachineId) {
            return { type: 'error' as const, result: { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' } };
          }
          // A Can use requester on another person's Machine copies only inside their
          // own member capture there. The TARGET capture and its matched-capture
          // writer preflight decide that destination in-flow; this Manage-only
          // Account read would refuse before it (O-MACH ruling 2026-11-28 10:18Z).
          const [{ readPublishedMachineRow }, { requiresRequesterWorkspaceCapture }] = await Promise.all([
            import('@/api/machine/readPublishedMachineRow'), import('@/api/machine/machineRpcAuthorization')]);
          const targetAccess = (await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl,
            () => readPublishedMachineRow(targetMachineId, requester.credentials, signal ? { signal } : undefined))
            .catch((error) => { if (signal?.aborted) throw error; return null; }))?.access;
          if (targetAccess && requiresRequesterWorkspaceCapture({ actorAccountId: handoff.root.binding.accountId,
            custodianAccountId: targetAccess.custodian.accountId, role: targetAccess.role })) {
            return { type: 'not_required' as const };
          }
          const { callExactMachineRpc, executionRunAuthorityCeiling } = await import('@/session/transport/rpc/machineRpc');
          raw = readMachineActionRpcResult(await callExactMachineRpc({ ...rpc, credentials: requester.credentials,
            serverUrl: requester.serverHttpBaseUrl, requestId: context.actionRequestId,
            ...executionRunAuthorityCeiling({ authority: context.authority }) }));
        } else {
          raw = await callMachineAction({ ...rpc, context, effectActionId, exactMachine: true });
        }
        const failure = readActionFailureEnvelope(raw);
        if (failure) return refuse(failure, failure);
        return HandoffTargetReplacementPreflightResultV1Schema.parse(raw);
      } catch (error) {
        // Both the in-process signed sender and the exact target RPC can throw a typed refusal.
        const errorCode = readRpcErrorCode(error) ?? readActionErrorCodeV1(error) ?? 'target_unavailable';
        return refuse({ ...readActionFailureEnvelope(error), ok: false, errorCode, error: errorCode }, error);
      }
    },
    sessionHandoffStart: async ({
      sessionId,
      targetMachineId,
      targetPath,
      targetSessionStorageMode,
      stateTransfer,
      workspaceAction,
      serverId,
      actionRequestId,
      handoffTargetReplacementApproval,
      handoffTargetReplacementApprovalReceiptId,
      handoffTargetReplacementApprovalActionInput,
      signal,
    }, context) => {
      if (!params.credentials) return notSupported();
      const handoff = readOriginalAccountHandoffRoot(context);
      const requester = readRequesterAccountActionTransportContext(handoff?.root);
      if (handoff && (!requester || requester.credentials !== params.credentials || handoff.admission.sessionId !== sessionId)) {
        return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      }
      // Keep the source read in the requester's Account and on the exact
      // admitted Session. The effect below still receives the admitted Action.
      const transport = requester && handoff
        ? await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, () => resolveTransportForSession(sessionId, signal,
          undefined, { serverId: handoff.root.binding.serverIdentityId, sessionId }))
        : await resolveTransportForSession(sessionId, signal, context ? { context, actionId: 'session.handoff' } : undefined);
      if (!transport.ok) {
        return { ok: false, errorCode: transport.code, error: transport.code };
      }
      // One owner for the handoff source facts, shared with the daemon's tracked
      // coordinator: machine custody and transcript-storage authority both come
      // from OWNER metadata, and an unresolved link refuses here rather than
      // being stamped as `persisted` on a request that stops the source.
      const { resolveSessionHandoffSourceAuthority } = await import('@/session/handoff/resolveSessionHandoffSourceAuthority');
      const source = resolveSessionHandoffSourceAuthority({
        credentials: params.credentials,
        rawSession: transport.rawSession,
        accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
      });
      if (!source.ok) {
        return { ok: false, errorCode: source.errorCode, error: source.error };
      }
      const sourceMachineId = source.sourceMachineId;
      // Workspace endpoints bind to the admitted Home identity (as destination
      // preflight does); the local profile label is only the fallback.
      const accountServerId = context?.serverIdentityId?.trim() || serverId;
      return await callMachineAction({
        machineId: sourceMachineId,
        method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
        context,
        authority: context?.authority,
        effectActionId: 'session.handoff',
        request: {
          sessionId: transport.sessionId,
          sourceMachineId,
          targetMachineId,
          sessionStorageMode: source.sessionStorageMode,
          ...(targetPath ? { targetPath } : {}),
          ...(targetSessionStorageMode ? { targetSessionStorageMode } : {}),
          ...(stateTransfer ? { stateTransfer } : {}),
          preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
          ...(workspaceAction ? { workspaceAction } : {}),
          ...(accountServerId ? { accountServerId } : {}),
          ...(actionRequestId ? { actionRequestId } : {}),
          ...(handoffTargetReplacementApproval ? { handoffTargetReplacementApproval } : {}),
          ...(handoffTargetReplacementApprovalReceiptId ? {
            handoffTargetReplacementApprovalReceiptId,
            handoffTargetReplacementApprovalActionInput,
          } : {}),
        },
        ...(signal ? { signal } : {}),
      });
    },
  };
}
