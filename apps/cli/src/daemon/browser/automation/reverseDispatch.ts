import {
  UiBrowserAutomationDispatchRequestV1Schema,
  UiBrowserAutomationDispatchResultV1Schema,
  uiBrowserAutomationDispatchMethod,
  BrowserAutomationActionKindV1Schema,
  isBrowserAutomationMutatingActionKind,
  type RuntimeActionExecute,
} from '@happier-dev/protocol';

import type { ReverseCaptureMachineRpcClient } from '../recording/reverseChannel/desktopReverseCaptureUiCall';

type MachineClient = ReverseCaptureMachineRpcClient & Readonly<{
  hasConnectedClientRpcHandler: (method: string) => boolean;
}>;

const unavailable = { ok: false, errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_ui_automation_unavailable' } as const;

export function createBrowserAutomationReverseDispatcher(input: Readonly<{
  getMachineClient: () => MachineClient | null | undefined;
}>): RuntimeActionExecute {
  return async (args) => {
    const record = args.input && typeof args.input === 'object' ? args.input as Record<string, unknown> : {};
    if (typeof record.browserSessionId !== 'string' || typeof record.viewId !== 'string') return unavailable;
    const method = uiBrowserAutomationDispatchMethod({ browserSessionId: record.browserSessionId, viewId: record.viewId });
    const client = input.getMachineClient();
    if (!client?.hasConnectedClientRpcHandler(method)) return unavailable;
    const request = UiBrowserAutomationDispatchRequestV1Schema.safeParse({
      v: 1, sessionId: args.context.defaultSessionId, actionId: args.actionId, input: args.input,
      ...(args.context.authority ? { authority: args.context.authority } : {}),
    });
    if (!request.success) return unavailable;
    const actionKind = BrowserAutomationActionKindV1Schema.safeParse(record.actionKind);
    const effectBearing = args.actionId === 'browser.automation.cancelActive'
      || args.actionId === 'browser.control.takeControl' || args.actionId === 'browser.control.handBack'
      || (actionKind.success && isBrowserAutomationMutatingActionKind(actionKind.data));
    let issued = false;
    const interrupted = () => UiBrowserAutomationDispatchResultV1Schema.parse({
      v: 1, status: 'interrupted', completion: 'unknown',
      ...(typeof record.automationRequestId === 'string' ? { automationRequestId: record.automationRequestId } : {}),
    });
    const failedTransport = () => issued && effectBearing ? interrupted() : unavailable;
    if (args.context.signal?.aborted) return unavailable;
    try {
      // Automation owns its execution budget; do not let the generic RPC default cut
      // a valid long-running page action off first.
      const response = await client.callConnectedClientRpc(method, request.data,
        { ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
          signal: args.context.signal, onIssued: () => { issued = true; } });
      if (args.context.signal?.aborted || !response.ok) return failedTransport();
      const parsed = UiBrowserAutomationDispatchResultV1Schema.safeParse(response.result);
      return parsed.success ? parsed.data : failedTransport();
    } catch {
      return failedTransport();
    }
  };
}
