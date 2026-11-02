import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
  UiActionDispatchRequestV1Schema,
  clientActionUnavailable,
  clientActionAmbiguous,
  currentUiContextCommandClientRpcMethod,
  currentUiContextReadClientRpcMethod,
  mountedWorkReadClientRpcMethod,
  sessionUiActionClientRpcMethod,
  parseClientActionDispatchResult,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { projectApprovalExecutionOriginCaller } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema, ClientActionRpcFailureCodeV1Schema, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isWorkflowAuthoringActionId, workflowDraftClientRpcMethod, WorkflowDraftGetInputV1Schema } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { PluginExecutionOriginActionIdSchema, PluginExecutionOriginActionInputSchemas } from '@happier-dev/protocol/actions/pluginExecutionOriginActionFamily';
import type { SocketRpcAnsweringClientV1, SocketRpcAnsweringClientCandidateV1 } from '@happier-dev/protocol/socketRpc';
import { readCliActionBoundSessionId } from './resolveCliActionCallerSession';
import { retainAdmittedClientActionParent } from './admittedClientActionChildren';
import { MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import { createBrowserAutomationReverseDispatcher } from '@/daemon/browser/automation/reverseDispatch';
import { isVoiceConversationActionId } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { isSettingsDeclarationActionIdV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

export type ClientActionMachineRpc = Readonly<{
  hasConnectedClientRpcHandler(method: string): boolean;
  callConnectedClientRpc(method: string, params: unknown,
    options: Readonly<{ timeoutMs: number | null; signal?: AbortSignal; answeringClient?: SocketRpcAnsweringClientV1; onIssued(): void }>):
    Promise<Readonly<{ ok: true; result: unknown; answeringClientId?: string; answeringClientIds?: readonly string[] }> | Readonly<{ ok: false; errorCode?: string; answeringClients?: readonly SocketRpcAnsweringClientCandidateV1[] }>>;
}>;

/** One delivery owner for every built-in client-placed Action; no retry after issuance. */
export function createClientActionReverseDispatcher(
  getMachineClient: () => ClientActionMachineRpc | null | undefined,
): NonNullable<ActionExecutorDeps['clientActionExecute']> {
  return async ({ actionId, input, context, executeChild }) => {
    const requestedClientId: unknown = input && typeof input === 'object' ? Reflect.get(input, 'clientId') : undefined;
    const clientId = typeof requestedClientId === 'string' ? requestedClientId : undefined;
    const unavailable = () => clientId
      ? { ok: false as const, errorCode: 'client_not_available', error: 'The selected clientId is not eligible or is disconnected' }
      : clientActionUnavailable(actionId);
    const machineTransportUnavailable = (errorCode = 'machine_transport_unavailable') => ({
      ok: false as const, errorCode, error: errorCode,
    });
    const client = getMachineClient();
    // Voice and Settings use the answering Account client's owners even when
    const mountedDiagnosticsActionId = MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS.find(id => id === actionId);
    if (mountedDiagnosticsActionId) {
      // The Action has already been admitted here. Continue at its exact mounted
      // engine, not a Session-wide App executor that can ask for approval again.
      const execute = createBrowserAutomationReverseDispatcher({ getMachineClient: () => client ? {
        callConnectedClientRpc: (method, params, options) => client.callConnectedClientRpc(method, params, {
          timeoutMs: options?.timeoutMs ?? null,
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.answeringClient ? { answeringClient: options.answeringClient } : {}),
          onIssued: () => options?.onIssued?.(),
        }),
      } : null });
      const result = await execute({ actionId: mountedDiagnosticsActionId, input, context });
      const failure = ActionExecuteFailureSchema.safeParse(result);
      return failure.success ? failure.data
        : parseClientActionDispatchResult(actionId, { v: 1, execution: { ok: true, result } })
          ?? { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    }
    // the invoking Agent's Session is in the background. View-specific Actions
    // still require the App viewing their exact Session, without fallback.
    const accountClientAction = isVoiceConversationActionId(actionId) || isSettingsDeclarationActionIdV1(actionId);
    const composerAction = actionId === 'ui.prompts.picker.open' || actionId === 'composer.transaction.apply'
      || actionId === 'composer.attachments.pick';
    const composerRef = composerAction && input && typeof input === 'object'
      ? Reflect.get(input, 'composerRef') ?? Reflect.get(input, 'ref') : undefined;
    // Standalone CLI adapters also put the resolved destination in this field.
    // It is not a viewed caller Session; Agent/bridge and explicit Session
    // provenance retain their bound route. Explicit composer refs stay exact.
    const callerSessionId = context.surface === 'cli' && context.actionCaller?.kind !== 'session'
      ? null : context.defaultSessionId;
    const targetSessionId = composerRef
      ? typeof composerRef === 'object' && 'sessionId' in composerRef && typeof composerRef.sessionId === 'string'
        ? composerRef.sessionId : null
      : callerSessionId ? readCliActionBoundSessionId(callerSessionId) : null;
    const originAction = PluginExecutionOriginActionIdSchema.safeParse(actionId);
    const originInput = originAction.success ? PluginExecutionOriginActionInputSchemas[originAction.data].parse(input) : null;
    const answeringClient = { ...(clientId ? { clientId } : {}), requireSingle: true as const };
    // Project only the address from the already-admitted full Action input.
    const address = isWorkflowAuthoringActionId(actionId) && input && typeof input === 'object'
      ? WorkflowDraftGetInputV1Schema.safeParse({ scope: Reflect.get(input, 'scope'), draftId: Reflect.get(input, 'draftId') }) : null;
    const method = actionId === 'session.work.get' && input && typeof input === 'object'
      && typeof Reflect.get(input, 'sessionId') === 'string'
      ? mountedWorkReadClientRpcMethod(actionId, Reflect.get(input, 'sessionId'))
      : actionId === 'inbox.get' ? mountedWorkReadClientRpcMethod(actionId)
      : actionId === 'ui.current_context.read' ? currentUiContextReadClientRpcMethod()
      : (actionId === 'ui.current_context.command.invoke' || actionId === 'account.home_continuation.invoke')
        && input && typeof input === 'object'
        && typeof Reflect.get(input, 'commandId') === 'string'
        ? currentUiContextCommandClientRpcMethod(Reflect.get(input, 'commandId'))
      : address?.success ? workflowDraftClientRpcMethod(address.data)
      : !originInput && !accountClientAction && targetSessionId ? sessionUiActionClientRpcMethod(targetSessionId)
      : RPC_METHODS.UI_ACTION_EXECUTE;
    if (!client) return machineTransportUnavailable();
    // Advertisements are hints, not receiver authority: reconnect/withdrawal can
    // race them. The server selects current handlers and returns typed absence
    // or ambiguity before any client executes the Action.
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const actionCaller = context.actionCaller ? projectApprovalExecutionOriginCaller(context.actionCaller) : undefined;
    if (context.actionCaller && !actionCaller) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const request = UiActionDispatchRequestV1Schema.safeParse({ v: 1, actionId, input, context: {
      surface: context.surface ?? 'agent', authority: context.authority ?? 'account_automation',
      ...(context.defaultSessionId ? { defaultSessionId: context.defaultSessionId } : {}),
      ...(context.defaultSessionMachineId ? { defaultSessionMachineId: context.defaultSessionMachineId } : {}),
      ...(context.agentStartWorkspaceWrites ? { agentStartWorkspaceWrites: context.agentStartWorkspaceWrites } : {}),
      ...(actionCaller ? { actionCaller } : {}),
      ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
      ...(context.externalActionCredential ? { externalActionCredential: context.externalActionCredential } : {}),
      ...(context.externalActionTarget ? { externalActionTarget: context.externalActionTarget } : {}),
    } });
    if (!request.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    // A Session caller's parent stays admitted here while the App answers; its
    // declared Workflow children return to this caller rather than to App relay.
    const parentRequestId = context.actionRequestId?.trim();
    const parentAccountId = context.externalActionExecutionAuthorization?.binding.accountId ?? context.runtimeAccountId;
    const releaseParent = context.actionCaller?.kind === 'session' && context.authority !== 'present_user'
      && parentRequestId && parentAccountId && executeChild
      ? retainAdmittedClientActionParent(parentRequestId, {
        accountId: parentAccountId, sessionId: context.actionCaller.sessionId, executeChild,
      })
      : null;
    let issued = false;
    const sideEffectClass = getActionSpec(actionId).sideEffectClass;
    const mayHaveEffect = sideEffectClass !== 'read' && sideEffectClass !== 'none';
    const failureWithCause = (reason: 'client_rpc_transport_failure' | 'client_rpc_invalid_response', code?: string, error?: unknown) => {
      const parsedCode = ClientActionRpcFailureCodeV1Schema.safeParse(code);
      const errorCode = parsedCode.success ? parsedCode.data : null;
      const diagnostic = error === undefined ? undefined : readUnexpectedActionErrorDiagnosticV1(error);
      return {
        ...(mayHaveEffect ? { ok: false as const, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' }
          : machineTransportUnavailable(code ?? 'invalid_action_output')),
        details: { reason, errorCode, ...(diagnostic ? {
          errorClass: diagnostic.errorClass, httpStatus: diagnostic.httpStatus,
        } : {}) },
      };
    };
    try {
      const response = await client.callConnectedClientRpc(method, request.data, {
        ...(answeringClient ? { answeringClient } : {}),
        timeoutMs: null, ...(context.signal ? { signal: context.signal } : {}), onIssued: () => {
          issued = true;
          context.onTransportIssued?.();
        },
      });
      if (!response.ok) {
        if (response.errorCode === RPC_ERROR_CODES.CLIENT_AMBIGUOUS) return clientActionAmbiguous(response.answeringClients);
        if (response.errorCode === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE) return unavailable();
        if (answeringClient && response.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return { ok: false,
          errorCode: 'client_routing_update_required', error: 'Update the Home server to support answering-client routing' };
        if (response.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
          || response.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND) return unavailable();
        return issued ? failureWithCause('client_rpc_transport_failure', response.errorCode)
          : machineTransportUnavailable(response.errorCode);
      }
      // The room may still be settling an accepted call after its receiver
      // withdrew new admission. Its encrypted method-not-found is a known
      // refusal, not a lost Action receipt.
      const refusal = response.result && typeof response.result === 'object'
        && 'errorCode' in response.result ? response.result.errorCode : undefined;
      if (refusal === RPC_ERROR_CODES.METHOD_NOT_FOUND || refusal === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return unavailable();
      const execution = parseClientActionDispatchResult(actionId, response.result);
      if (actionId === 'plugins.execution_origin.list' && execution?.ok && execution.result
        && typeof execution.result === 'object' && Reflect.get(execution.result, 'status') === 'available' && response.answeringClientId) {
        return { ...execution, result: { ...execution.result, answeringClientId: response.answeringClientId,
          ...(response.answeringClientIds ? { answeringClientIds: [...response.answeringClientIds] } : {}) } };
      }
      return execution ?? failureWithCause('client_rpc_invalid_response');
    } catch (error) {
      return issued ? failureWithCause('client_rpc_transport_failure',
        context.signal?.aborted ? 'cancelled' : readRpcErrorCode(error) ?? undefined, error)
        : machineTransportUnavailable(context.signal?.aborted ? 'cancelled' : readRpcErrorCode(error) ?? undefined);
    } finally {
      releaseParent?.();
    }
  };
}
