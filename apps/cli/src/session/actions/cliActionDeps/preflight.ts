import { readExecutionRunProtocolV2Support, type ExecutionRunCapabilityObservation } from '@happier-dev/protocol/execution/runs/protocolSupport';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRpcErrorCode, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { ExecutionRunStartFailureDetailsV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { CliMachineActionCall } from './machineTransport';
import type { ExecutionRunActionTransportOptions, ExecutionRunProtocolV2Requirement } from './types';

type PreflightFailureDetails = Readonly<{
  executionRunPreflight: NonNullable<ExecutionRunStartFailureDetailsV1['executionRunPreflight']>;
}>;

/** Describe is a passive read under the admitted root, not a new Run effect. */
export async function describeExecutionRunProtocolV2(
  callMachineAction: CliMachineActionCall,
  machineId: string,
  requirement: ExecutionRunProtocolV2Requirement,
  opts?: ExecutionRunActionTransportOptions,
): Promise<
  | Readonly<{ ok: true; exactMachineId: string }>
  | Readonly<{ ok: false; errorCode: string; error: string; details?: PreflightFailureDetails }>
> {
  let observation: ExecutionRunCapabilityObservation;
  let causeCode: string | null = null;
  let refusalCode: string | null = null;
  try {
    const response = await callMachineAction({
      machineId,
      method: RPC_METHODS.CAPABILITIES_DESCRIBE,
      request: {},
      ...(opts?.serverId ? { serverId: opts.serverId } : {}),
      ...(opts ? { context: { ...opts, callerPermissionMode: opts.effectiveCallerPermissionMode,
        ...(opts.workflowRunId ? { executionRunWorkflowRunId: opts.workflowRunId } : {}),
      } } : {}),
      ...(opts?.externalActionExecutionAuthorization
        ? { effectActionId: opts.externalActionExecutionAuthorization.binding.actionId } : {}),
      ...(opts?.authority ? { authority: opts.authority } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    observation = { supported: true, response };
  } catch (error) {
    observation = { supported: false, reason: 'error', error };
    const diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
    const rpcCode = readRpcErrorCode(error);
    // Scope is a local transport refusal; other native/HTTP codes come only
    // from the canonical content-free diagnostic reader, never exception prose.
    const scopeCode = error !== null && typeof error === 'object' && 'code' in error
      && error.code === 'server_scope_mismatch' ? error.code : null;
    const knownRpcCode = rpcCode && Object.values(RPC_ERROR_CODES).some(code => code === rpcCode) ? rpcCode : null;
    causeCode = scopeCode ?? knownRpcCode ?? diagnostic.errorCode;
    refusalCode = scopeCode ?? knownRpcCode ?? (causeCode === 'not_authenticated' ? causeCode : null);
  }
  const support = readExecutionRunProtocolV2Support(observation, requirement, opts?.signal);
  if (support.ok) return { ok: true, exactMachineId: machineId };
  if (observation.supported) return support;
  const errorCode = support.errorCode === 'execution_run_target_unavailable' && refusalCode
    ? refusalCode : support.errorCode;
  return { ok: false, errorCode, error: errorCode,
    details: { executionRunPreflight: { phase: 'capabilities.describe', cause: { code: causeCode } } } };
}
