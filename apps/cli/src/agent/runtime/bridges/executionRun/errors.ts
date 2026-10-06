import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';

/** Provider evidence that the initial input was definitively refused before work. */
export class ExecutionRunRejectedStartError extends Error {
  readonly executionRunErrorCode = 'connected_service_model_start_rejected';
  constructor(readonly classification: ConnectedServiceRuntimeFailureClassification) {
    super(`Connected account rejected model '${classification.providerLimitId}' before Run start`);
    this.name = 'ExecutionRunRejectedStartError';
  }
}

export function readExecutionRunRejectedStartDiagnostic(diagnostic: unknown): ExecutionRunRejectedStartError | null {
  if (!diagnostic || typeof diagnostic !== 'object' || !('code' in diagnostic)
    || diagnostic.code !== 'connected_service_model_start_rejected'
    || !('details' in diagnostic) || !diagnostic.details || typeof diagnostic.details !== 'object'
    || !('runtimeAuthClassification' in diagnostic.details)) return null;
  const classification = sanitizeConnectedServiceRuntimeFailureClassification(diagnostic.details.runtimeAuthClassification);
  if (!classification || classification.kind !== 'plan' || classification.limitCategory !== 'plan_invalid'
    || classification.quotaScope !== 'model' || !classification.providerLimitId) return null;
  return new ExecutionRunRejectedStartError(classification);
}

export type ExecutionRunTimeoutError = Error & Readonly<{
  executionRunErrorCode: string;
  livenessProbe?: unknown;
}>;

export function createExecutionRunTimeoutError(params: Readonly<{
  timeoutMs: number;
  errorCode: string;
  livenessProbe: unknown;
}>): ExecutionRunTimeoutError {
  const error = new Error(`Timed out after ${params.timeoutMs}ms`) as ExecutionRunTimeoutError;
  Object.assign(error, {
    executionRunErrorCode: params.errorCode,
    livenessProbe: params.livenessProbe,
  });
  return error;
}

export function readExecutionRunErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { executionRunErrorCode?: unknown }).executionRunErrorCode;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

export function createExecutionRunCodedError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { executionRunErrorCode: code });
  return error;
}

export function isExecutionRunTimeoutError(error: unknown): error is ExecutionRunTimeoutError {
  const code = readExecutionRunErrorCode(error);
  return code === 'provider_inactivity_timeout';
}
