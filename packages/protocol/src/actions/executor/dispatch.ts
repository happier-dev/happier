import type { RuntimeActionIdV1 } from '../actionIds.js';
import {
  executeBrowserRuntimeAction,
  isBrowserRuntimeActionId,
} from './browser.js';
import {
  executeDevicesSimulatorRuntimeAction,
  isDevicesSimulatorRuntimeActionId,
} from './simulator.js';
import {
  executeLocalServicesRuntimeAction,
  isLocalServicesRuntimeActionId,
} from './localServices.js';
import {
  executePeerMediationRuntimeAction,
  isPeerMediationRuntimeActionId,
} from './peerMediation.js';
import type {
  ActionExecuteResult,
  RuntimeActionDisabledReason,
  RuntimeActionExecute,
  RuntimeActionExecutionFamily,
  RuntimeActionExecuteArgsFor,
} from './types.js';

export async function dispatchRuntimeAction(args: Readonly<{
  actionId: RuntimeActionIdV1;
  input: unknown;
  context: RuntimeActionExecuteArgsFor<RuntimeActionIdV1>['context'];
  runtimeActionExecute?: RuntimeActionExecute;
}>): Promise<unknown> {
  const actionId = args.actionId;
  if (!args.runtimeActionExecute) {
    return {
      ok: false,
      errorCode: 'unsupported_action',
      error: `unsupported_action:${actionId}`,
    };
  }

  if (isBrowserRuntimeActionId(actionId)) {
    return executeBrowserRuntimeAction({
      actionId,
      input: args.input,
      context: args.context,
      runtimeActionExecute: args.runtimeActionExecute,
    });
  }
  if (isLocalServicesRuntimeActionId(actionId)) {
    return executeLocalServicesRuntimeAction({
      actionId,
      input: args.input,
      context: args.context,
      runtimeActionExecute: args.runtimeActionExecute,
    });
  }
  if (isPeerMediationRuntimeActionId(actionId)) {
    return executePeerMediationRuntimeAction({
      actionId,
      input: args.input,
      context: args.context,
      runtimeActionExecute: args.runtimeActionExecute,
    });
  }
  if (isDevicesSimulatorRuntimeActionId(actionId)) {
    return executeDevicesSimulatorRuntimeAction({
      actionId,
      input: args.input,
      context: args.context,
      runtimeActionExecute: args.runtimeActionExecute,
    });
  }

  throw new Error(`Unknown runtime action family: ${String(actionId)}`);
}

export function resolveRuntimeActionExecutionFamily(
  actionId: RuntimeActionIdV1,
): RuntimeActionExecutionFamily {
  if (isBrowserRuntimeActionId(actionId)) return 'browser';
  if (isLocalServicesRuntimeActionId(actionId)) return 'localServices';
  if (isPeerMediationRuntimeActionId(actionId)) return 'peerMediation';
  if (isDevicesSimulatorRuntimeActionId(actionId)) return 'devices.simulator';

  throw new Error(`Unknown runtime action family: ${actionId}`);
}

export function createRuntimeActionDisabledResult(params: Readonly<{
  actionId: RuntimeActionIdV1;
  reason?: RuntimeActionDisabledReason;
}>): Extract<ActionExecuteResult, Readonly<{ ok: false }>> {
  const reason = params.reason ?? 'runtime_family_unimplemented';
  const family = resolveRuntimeActionExecutionFamily(params.actionId);
  return {
    ok: false,
    errorCode: 'runtime_action_disabled',
    error: `runtime_action_disabled:${family}:${reason}`,
  };
}

export function createUnavailableRuntimeActionExecutor(params?: Readonly<{
  reason?: RuntimeActionDisabledReason;
}>): RuntimeActionExecute {
  return async ({ actionId }) =>
    createRuntimeActionDisabledResult({
      actionId,
      ...(params?.reason ? { reason: params.reason } : {}),
    });
}
