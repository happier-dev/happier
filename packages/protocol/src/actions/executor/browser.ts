import {
  ACTION_ID_FAMILIES_V1,
  RuntimeActionIdV1Schema,
  type RuntimeActionIdV1,
} from '../actionIds.js';
import type { RuntimeActionDispatchArgs } from './types.js';
import { BrowserCommandDispatchResultV1Schema } from '../../browser/control/v1.js';
import { projectActionFailureCauseV1 } from '../actionExecutionResult.js';

export const BROWSER_RUNTIME_ACTION_IDS = [
  ...ACTION_ID_FAMILIES_V1.browser_control,
  ...ACTION_ID_FAMILIES_V1.browser_diagnostics,
  ...ACTION_ID_FAMILIES_V1.browser_context,
  ...ACTION_ID_FAMILIES_V1.browser_automation,
  ...ACTION_ID_FAMILIES_V1.browser_recording,
] as const satisfies readonly RuntimeActionIdV1[];

export type BrowserRuntimeActionId = (typeof BROWSER_RUNTIME_ACTION_IDS)[number];

const BROWSER_RUNTIME_ACTION_ID_SET: ReadonlySet<RuntimeActionIdV1> = new Set(BROWSER_RUNTIME_ACTION_IDS);

export function isBrowserRuntimeActionId(actionId: RuntimeActionIdV1): actionId is BrowserRuntimeActionId {
  return BROWSER_RUNTIME_ACTION_ID_SET.has(actionId);
}

/** Non-content Session routing, shared by sealed transport and Home admission. */
export function projectExternalActionBrowserSessionIdV1(actionId: string, input: unknown): string | undefined {
  const action = RuntimeActionIdV1Schema.safeParse(actionId);
  if (!action.success || !isBrowserRuntimeActionId(action.data)
    || !input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const sessionId = (input as Readonly<Record<string, unknown>>).browserSessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : undefined;
}

export async function executeBrowserRuntimeAction(args: RuntimeActionDispatchArgs<BrowserRuntimeActionId>): Promise<unknown> {
  const result = await args.runtimeActionExecute({
    actionId: args.actionId,
    input: args.input,
    context: args.context,
  });
  // Control transports return the Browser protocol outcome. Project its failure
  // once here so every Action caller and durable approval records the same result.
  const command = BrowserCommandDispatchResultV1Schema.safeParse(result);
  if (command.success && command.data.status === 'failed') {
    return { ok: false, errorCode: command.data.error.code, error: command.data.error.message, details: command.data,
      failureCause: projectActionFailureCauseV1({ name: 'Error', code: command.data.error.code }, args.actionId) };
  }
  return result;
}
