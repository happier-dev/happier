import type { ExecutionRunProtocolV2Requirement } from '../../actions/executor/types.js';
import { parseCapabilityProtocol } from '../../capabilities/index.js';
import { isRpcMethodNotFoundError, isRpcMethodNotFoundResult, RPC_ERROR_CODES } from '../../rpc/errors.js';

/** Transport adapters retain observation facts; this owner decides Run support. */
export type ExecutionRunCapabilityObservation =
  | Readonly<{ supported: true; response: unknown }>
  | Readonly<{ supported: false; reason: 'not-supported' | 'error' | 'server-switch-abort'; error?: unknown }>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : {};
}

function failure(errorCode: 'cancelled' | 'execution_run_protocol_unsupported' | 'execution_run_target_unavailable') {
  return { ok: false, errorCode, error: errorCode } as const;
}

export function readExecutionRunProtocolV2Support(
  observation: ExecutionRunCapabilityObservation,
  requirement: ExecutionRunProtocolV2Requirement,
  signal?: AbortSignal,
): Readonly<{ ok: true }> | ReturnType<typeof failure> {
  if (signal?.aborted || !observation.supported && (
    observation.reason === 'server-switch-abort' || record(observation.error).name === 'AbortError'
  )) return failure('cancelled');
  if (!observation.supported) {
    return failure(observation.reason === 'not-supported'
      || isRpcMethodNotFoundError(observation.error)
      ? 'execution_run_protocol_unsupported' : 'execution_run_target_unavailable');
  }
  const response = record(observation.response);
  if (response.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
    return failure('execution_run_target_unavailable');
  }
  if (isRpcMethodNotFoundResult(response)) {
    return failure('execution_run_protocol_unsupported');
  }
  const descriptor = response.protocolVersion === 1 && Array.isArray(response.capabilities)
    ? response.capabilities.map(record).find(capability => capability.id === 'tool.executionRuns') : undefined;
  const protocol = parseCapabilityProtocol(descriptor?.protocol);
  if (!protocol || protocol.available !== true || protocol.version !== 2
    || Object.entries(requirement).some(([feature, required]) => required && protocol.features[feature] !== true)) {
    return failure('execution_run_protocol_unsupported');
  }
  return { ok: true };
}
