import { THEME_ACTION_IDS, isThemeActionId } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { USAGE_HISTORY_ACTION_IDS } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
  buildUiActionDispatchRequestV1, type UiActionDispatchRequestV1,
  clientActionUnavailable,
  clientActionAmbiguous,
  currentUiContextReadClientRpcMethod,
  mountedWorkReadClientRpcMethod,
  sessionUiActionClientRpcMethod,
  parseClientActionDispatchResult,
  voiceRunActionClientRpcMethod, UiActionDispatchResultV1Schema, type VoiceRunActionDispatchRequestV1,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import { projectApprovalExecutionOriginCaller } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema, ClientActionRpcFailureCodeV1Schema, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isWorkflowAuthoringActionId, workflowDraftClientRpcMethod, WorkflowDraftGetInputV1Schema } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { PluginExecutionOriginActionIdSchema, PluginExecutionOriginActionInputSchemas } from '@happier-dev/protocol/actions/pluginExecutionOriginActionFamily';
import type { SocketRpcAnsweringClientV1, SocketRpcAnsweringClientCandidateV1 } from '@happier-dev/protocol/socketRpc';
import { readCliActionBoundSessionId } from './resolveCliActionCallerSession';
import { readActionPrincipalAccountId } from './actionPrincipalAccount';
import { retainAdmittedClientActionParent } from './admittedClientActionChildren';
import { MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import { createBrowserAutomationReverseDispatcher } from '@/daemon/browser/automation/reverseDispatch';
import { isVoiceConversationActionId } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { isSettingsDeclarationActionIdV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { isWorkspaceActionId } from '@happier-dev/protocol/actions/workspaceActionFamily';
import { isSessionClientControlActionId, isSessionOrganizationAppearanceActionId } from '@happier-dev/protocol/actions/actionIds';
import { readWidgetActionSessionTargetV1, readWidgetActionSurfaceV1 } from '@happier-dev/protocol/widgets/actionsV1';

export type ClientActionMachineRpc = Readonly<{
  hasConnectedClientRpcHandler(method: string): boolean;
  callConnectedClientRpc(method: string, params: unknown,
    options: Readonly<{ timeoutMs: number | null; signal?: AbortSignal; answeringClient?: SocketRpcAnsweringClientV1; onIssued(): void;
      principalAccountId?: string }>):
    Promise<Readonly<{ ok: true; result: unknown; answeringClientId?: string; answeringClientIds?: readonly string[]; answeringClients?: readonly SocketRpcAnsweringClientCandidateV1[] }> | Readonly<{ ok: false; errorCode?: string; answeringClients?: readonly SocketRpcAnsweringClientCandidateV1[] }>>;
}>;

type ClientActionReverseRequest = Omit<Parameters<NonNullable<ActionExecutorDeps['clientActionExecute']>>[0], 'context' | 'execute'> & Readonly<{
  context: ActionExecutorContext;
  execute?: Parameters<NonNullable<ActionExecutorDeps['clientActionExecute']>>[0]['execute'];
}>;

/** One delivery owner for client continuations and the owning Voice Run frontdoor; no retry after issuance. */
export function createClientActionReverseDispatcher(
  getMachineClient: () => ClientActionMachineRpc | null | undefined,
  voiceRun?: VoiceRunActionDispatchRequestV1['voiceRun'],
): (request: ClientActionReverseRequest) => Promise<ActionExecuteResult> {
  return async ({ actionId, input, context, executeChild, admittedHostReviewedChildren }) => {
    const principalAccountId = readActionPrincipalAccountId(context);
    const requestedClientId: unknown = input && typeof input === 'object' ? Reflect.get(input, 'clientId') : undefined;
    const clientId = typeof requestedClientId === 'string' ? requestedClientId : undefined;
    const unavailable = () => isThemeActionId(actionId) ? clientActionUnavailable(actionId) : clientId
      ? { ok: false as const, errorCode: 'client_not_available', error: 'The selected clientId is not eligible or is disconnected' }
      : clientActionUnavailable(actionId);
    const machineTransportUnavailable = (errorCode = 'machine_transport_unavailable') => ({
      ok: false as const, errorCode, error: errorCode,
    });
    const client = getMachineClient();
    const mountedDiagnosticsActionId = MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS.find(id => id === actionId);
    if (mountedDiagnosticsActionId && !voiceRun) {
      // The Action has already been admitted here. Continue at its exact mounted
      // engine, not a Session-wide App executor that can ask for approval again.
      const execute = createBrowserAutomationReverseDispatcher({ getMachineClient: () => client ? {
        callConnectedClientRpc: (method, params, options) => client.callConnectedClientRpc(method, params, {
          timeoutMs: options?.timeoutMs ?? null,
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.answeringClient ? { answeringClient: options.answeringClient } : {}),
          ...(options?.principalAccountId ? { principalAccountId: options.principalAccountId } : {}),
          onIssued: () => options?.onIssued?.(),
        }),
      } : null });
      const result = await execute({ actionId: mountedDiagnosticsActionId, input, context });
      const failure = ActionExecuteFailureSchema.safeParse(result);
      return failure.success ? failure.data
        : parseClientActionDispatchResult(actionId, { v: 1, execution: { ok: true, result } })
          ?? { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    }
    // Voice, Settings and client-wide effects use the answering Account client's owners even when
    // the invoking Agent's Session is in the background. View-specific Actions
    // still require the App viewing their exact Session, without fallback.
    const accountClientAction = isVoiceConversationActionId(actionId) || isSettingsDeclarationActionIdV1(actionId)
      || isSessionClientControlActionId(actionId)
      || isSessionOrganizationAppearanceActionId(actionId)
      || isWorkspaceActionId(actionId) || actionId === USAGE_HISTORY_ACTION_IDS.read
      || actionId === 'session.open' || actionId === 'desktop.windows.open'
      || actionId === 'links.openExternal' || actionId === 'file.view.preference.set'
      || actionId === 'projects.sources.moveToTeam' || actionId === 'session.messages.pins'
      || actionId === 'session.space_membership.set';
    const sessionPresenter = getActionSpec(actionId).clientPresenter === 'session';
    const composerRef = sessionPresenter && input && typeof input === 'object'
      ? Reflect.get(input, 'composerRef') ?? Reflect.get(input, 'ref') : undefined;
    // Standalone CLI adapters also put the resolved destination in this field.
    // It is not a viewed caller Session; Agent/bridge and explicit Session
    // provenance retain their bound route. Explicit composer refs stay exact.
    const callerSessionId = context.surface === 'cli' && context.actionCaller?.kind !== 'session'
      ? null : context.defaultSessionId;
    // A qualified widget surface owns its destination. A Usage/Project area
    // must not inherit the invoking Agent's unrelated viewed-Session room.
    const widgetSurface = readWidgetActionSurfaceV1(input);
    const targetSessionId = widgetSurface ? readWidgetActionSessionTargetV1(widgetSurface)?.sessionId ?? null : composerRef
      ? typeof composerRef === 'object' && 'sessionId' in composerRef && typeof composerRef.sessionId === 'string'
        ? composerRef.sessionId : null
      : callerSessionId ? readCliActionBoundSessionId(callerSessionId) : null;
    const originAction = PluginExecutionOriginActionIdSchema.safeParse(actionId);
    const originInput = originAction.success ? PluginExecutionOriginActionInputSchemas[originAction.data].parse(input) : null;
    const libraryAction = actionId === 'workflow.library.view.get' || actionId === 'workflow.library.view.set'
      || actionId === 'workflow.library.view.reset';
    const listsThemeDevices = actionId === THEME_ACTION_IDS.list && input !== null && typeof input === 'object' && Reflect.get(input, 'includeDevices') === true;
    const listsAnsweringClients = listsThemeDevices || actionId === 'plugins.execution_origin.list' || actionId === 'workflow.library.view.get';
    const answeringClient = { ...(clientId ? { clientId } : {}), requireSingle: true as const,
      ...(listsAnsweringClients ? { includeCandidates: true as const } : {}) };
    // Project only the address from the already-admitted full Action input.
    const address = isWorkflowAuthoringActionId(actionId) && input && typeof input === 'object'
      ? WorkflowDraftGetInputV1Schema.safeParse({ scope: Reflect.get(input, 'scope'), draftId: Reflect.get(input, 'draftId') }) : null;
    // Read and invoke select the same App socket. The current-UI command owner
    // decides whether the opaque command still exists; its separate registration
    // must not re-decide the answering client's availability.
    const method = voiceRun ? voiceRunActionClientRpcMethod(voiceRun.runId)
      : actionId === 'session.work.get' && input && typeof input === 'object'
      && typeof Reflect.get(input, 'sessionId') === 'string'
      ? mountedWorkReadClientRpcMethod(actionId, Reflect.get(input, 'sessionId'))
      : actionId === 'inbox.get' ? mountedWorkReadClientRpcMethod(actionId)
      : actionId === 'ui.current_context.read' || actionId === 'ui.current_context.command.invoke'
        || actionId === 'account.home_continuation.invoke'
        ? currentUiContextReadClientRpcMethod()
      : address?.success ? workflowDraftClientRpcMethod(address.data)
      : !clientId && !originInput && !libraryAction && !listsThemeDevices && !accountClientAction && targetSessionId ? sessionUiActionClientRpcMethod(targetSessionId)
      : RPC_METHODS.UI_ACTION_EXECUTE;
    if (!client) return machineTransportUnavailable();
    // Advertisements are hints, not receiver authority: reconnect/withdrawal can
    // race them. The server selects current handlers and returns typed absence
    // or ambiguity before any client executes the Action.
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const actionCaller = context.actionCaller ? projectApprovalExecutionOriginCaller(context.actionCaller) : undefined;
    if (context.actionCaller && !actionCaller) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    let request: UiActionDispatchRequestV1 | VoiceRunActionDispatchRequestV1;
    try {
      request = voiceRun ? { v: 1, actionId, input, voiceRun }
        : buildUiActionDispatchRequestV1({ actionId, input: listsThemeDevices && input && typeof input === 'object'
          ? { ...input, includeDevices: false } : input, ...(admittedHostReviewedChildren ? { admittedHostReviewedChildren } : {}), context: {
        ...context, surface: context.surface ?? 'agent', authority: context.authority ?? 'account_automation',
        ...(actionCaller ? { actionCaller } : {}),
      } });
    } catch { return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' }; }
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
      const response = await client.callConnectedClientRpc(method, request, {
        ...(answeringClient ? { answeringClient } : {}), ...(principalAccountId ? { principalAccountId } : {}),
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
      // The Voice owner validates the Action result before applying the same
      // provider privacy projection used by native Voice tool delivery.
      const voiceResult = voiceRun ? UiActionDispatchResultV1Schema.safeParse(response.result) : null;
      const execution = voiceRun ? voiceResult?.success ? voiceResult.data.execution : null
        : parseClientActionDispatchResult(actionId, response.result);
      if (listsThemeDevices && execution?.ok && execution.result && typeof execution.result === 'object') {
        return { ...execution, result: { ...execution.result, devices: response.answeringClients ?? [] } };
      }
      const answeringClients = listsAnsweringClients && response.answeringClientId ? {
        answeringClientId: response.answeringClientId,
        ...(response.answeringClientIds ? { answeringClientIds: [...response.answeringClientIds] } : {}),
        ...(response.answeringClients ? { answeringClients: [...response.answeringClients] } : {}),
      } : null;
      if (actionId === 'workflow.library.view.get' && execution && !execution.ok
        && execution.errorCode === 'unavailable' && answeringClients) {
        return { ...execution, details: {
          ...(execution.details && typeof execution.details === 'object' && !Array.isArray(execution.details) ? execution.details : {}),
          ...answeringClients,
        } };
      }
      if (listsAnsweringClients && execution?.ok && execution.result
        && typeof execution.result === 'object' && answeringClients
        && (libraryAction || Reflect.get(execution.result, 'status') === 'available')) {
        return { ...execution, result: { ...execution.result, ...answeringClients } };
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
