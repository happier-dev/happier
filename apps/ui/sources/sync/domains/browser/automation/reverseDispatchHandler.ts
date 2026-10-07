import { UiBrowserAutomationDispatchRequestV1Schema, UiBrowserAutomationDispatchResultV1Schema } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { createBrowserRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { readRegisteredBrowserRuntimeAutomationAdapter, readRegisteredBrowserRuntimeControlAdapter } from '../actions/runtimeControlRegistry';

const unavailable = { ok: false, errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_view_unavailable' } as const;
const invalid = { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' } as const;

export async function handleUiBrowserAutomationDispatchRequest(
  rawRequest: unknown,
  view: Readonly<{ browserSessionId: string; viewId: string; sessionId: string }>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<unknown> {
  const request = UiBrowserAutomationDispatchRequestV1Schema.safeParse(rawRequest);
  if (!request.success) return invalid;
  if (request.data.sessionId !== view.sessionId) return unavailable;
  const parsed = getActionSpec(request.data.actionId).inputSchema.safeParse(request.data.input);
  if (!parsed.success || !parsed.data || typeof parsed.data !== 'object') return invalid;
  const target = parsed.data as Readonly<{ browserSessionId?: unknown; viewId?: unknown }>;
  if (target.browserSessionId !== view.browserSessionId || target.viewId !== view.viewId) return unavailable;
  const control = readRegisteredBrowserRuntimeControlAdapter(view.browserSessionId);
  if (!control) return unavailable;
  const currentView = control.readState()?.viewsById[view.viewId];
  if (!currentView || currentView.browserSessionId !== view.browserSessionId) return unavailable;
  const automation = readRegisteredBrowserRuntimeAutomationAdapter(view.browserSessionId);
  if (!automation?.controlService) return unavailable;
  if (options?.signal?.aborted) return unavailable;
  const execute = createBrowserRuntimeActionExecutor({ control, automation });
  const result = await execute({ actionId: request.data.actionId, input: parsed.data, context: {
    surface: 'agent', authority: request.data.authority, defaultSessionId: request.data.sessionId, signal: options?.signal,
  } });
  const response = UiBrowserAutomationDispatchResultV1Schema.safeParse(result);
  return response.success ? response.data : unavailable;
}
