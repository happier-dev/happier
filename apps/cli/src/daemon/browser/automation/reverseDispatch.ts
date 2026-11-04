import { UiBrowserAutomationDispatchRequestV1Schema, UiBrowserAutomationDispatchResultV1Schema, uiBrowserAutomationDispatchMethod, MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS, EXISTING_VIEW_BROWSER_CONTROL_ACTION_IDS } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import { BrowserAutomationActionKindV1Schema, isBrowserAutomationMutatingActionKind } from '@happier-dev/protocol/browser/automation/v1';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpcErrors';
import { clientActionAmbiguous, withoutClientActionInput } from '@happier-dev/protocol/actions/clientDispatchV1';

import type { ReverseCaptureMachineRpcClient } from '../recording/reverseChannel/desktopReverseCaptureUiCall';

const unavailable = { ok: false, errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_ui_automation_unavailable' } as const;

export function createBrowserAutomationReverseDispatcher(input: Readonly<{
  getMachineClient: () => ReverseCaptureMachineRpcClient | null | undefined;
}>): RuntimeActionExecute {
  return async (args) => {
    const record = args.input && typeof args.input === 'object' ? args.input as Record<string, unknown> : {};
    if (typeof record.browserSessionId !== 'string' || typeof record.viewId !== 'string') return unavailable;
    const method = uiBrowserAutomationDispatchMethod({ browserSessionId: record.browserSessionId, viewId: record.viewId });
    const client = input.getMachineClient();
    // Registration hints are positive-only, not a complete census after reconnect.
    // The server's live RPC registry decides whether this exact view can answer.
    if (!client) return unavailable;
    const request = UiBrowserAutomationDispatchRequestV1Schema.safeParse({
      v: 1, sessionId: args.context.defaultSessionId, actionId: args.actionId, input: withoutClientActionInput(args.input),
      ...(args.context.authority ? { authority: args.context.authority } : {}),
    });
    if (!request.success) return unavailable;
    const actionKind = BrowserAutomationActionKindV1Schema.safeParse(record.actionKind);
    const diagnostics = (MOUNTED_BROWSER_DIAGNOSTICS_ACTION_IDS as readonly string[]).includes(args.actionId);
    const clientViewEffect = args.actionId === 'browser.view.openExternal' || args.actionId === 'browser.view.openDevtools'
      || (EXISTING_VIEW_BROWSER_CONTROL_ACTION_IDS as readonly string[]).includes(args.actionId);
    const effectBearing = diagnostics || clientViewEffect || args.actionId === 'browser.automation.cancelActive'
      || args.actionId === 'browser.control.takeControl' || args.actionId === 'browser.control.handBack'
      || (actionKind.success && isBrowserAutomationMutatingActionKind(actionKind.data));
    let issued = false;
    const interrupted = () => UiBrowserAutomationDispatchResultV1Schema.parse({
      v: 1, status: 'interrupted', completion: 'unknown',
      ...(typeof record.automationRequestId === 'string' ? { automationRequestId: record.automationRequestId } : {}),
    });
    const failedTransport = () => issued && effectBearing
      ? clientViewEffect || diagnostics
        ? { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' } as const
        : interrupted()
      : unavailable;
    if (args.context.signal?.aborted) return unavailable;
    try {
      // Automation owns its execution budget; do not let the generic RPC default cut
      // a valid long-running page action off first.
      const response = await client.callConnectedClientRpc(method, request.data,
        { ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
          answeringClient: { requireSingle: true, ...(typeof record.clientId === 'string' ? { clientId: record.clientId } : {}) }, signal: args.context.signal,
          onIssued: () => { issued = true; args.context.onTransportIssued?.(); } });
      if (!response.ok && response.errorCode === RPC_ERROR_CODES.CLIENT_AMBIGUOUS) {
        return clientActionAmbiguous(response.answeringClients);
      }
      if (!response.ok && response.errorCode === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE && typeof record.clientId === 'string') {
        return { ok: false, errorCode: 'client_not_available', error: 'The selected clientId is not eligible or is disconnected' };
      }
      // Retirement may be refused by the Home before dispatch or by the UI
      // inside its decoded ACK. Either receipt proves the handler never ran.
      if ((!response.ok && (response.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
        || response.errorCode === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE))
        || (response.ok && isRpcMethodNotFoundResult(response.result))) return unavailable;
      if (!response.ok && response.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
        return { ok: false, errorCode: 'client_routing_update_required', error: 'Update the Home server to support answering-client routing' };
      }
      if (args.context.signal?.aborted || !response.ok) return failedTransport();
      const parsed = UiBrowserAutomationDispatchResultV1Schema.safeParse(response.result);
      return parsed.success ? parsed.data : failedTransport();
    } catch {
      return failedTransport();
    }
  };
}
