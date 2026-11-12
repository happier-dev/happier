import { readPluginErrorRequestIdV1, type PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import { TriageSourceFailureV1Schema, type TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

export type TriageSourceReadFailureV1 = TriageSourceFailureV1 & Readonly<{
  retryable?: boolean;
  diagnostics?: readonly PluginDiagnosticData[];
}>;

function invocationFailure(
  error: Readonly<{ code: string; retryable?: boolean; diagnostics?: readonly PluginDiagnosticData[] }>,
  fallbackCode: string,
  requestId?: string,
): TriageSourceFailureV1 {
  // Mounted transports retain the exact host refusal in a diagnostic.
  const wrapped = error.code === 'unavailable' || error.code === 'denied' || error.code === 'stale_surface';
  const code = wrapped ? error.diagnostics?.find(diagnostic => diagnostic.severity === 'error')?.code ?? error.code : error.code;
  const failure = TriageSourceFailureV1Schema.safeParse({
    class: error.code === 'denied' ? 'permission' : error.retryable ? 'transient' : 'unsupportedContract',
    code,
    ...(requestId === undefined ? {} : { requestId }),
  });
  return failure.success ? failure.data : { class: 'transient', code: fallbackCode };
}

/** Preserve canonical host refusal classification without disclosing raw error context. */
export function projectTriageSourceInvocationFailureV1(error: unknown, fallbackCode: string): TriageSourceFailureV1 {
  return isPluginError(error) ? invocationFailure(error, fallbackCode, readPluginErrorRequestIdV1(error))
    : { class: 'transient', code: fallbackCode };
}

/** Finite reads may retry a missing receipt; mutation settlement remains with its owner. */
export function projectTriageSourceReadFailureV1(
  execution: PluginActionExecution,
  fallbackCode: string,
  notDispatchedCode: string,
  sourceFailure?: TriageSourceFailureV1,
): TriageSourceReadFailureV1 {
  const settledFailure = execution.status === 'error' || execution.status === 'outcomeUnknown'
    ? execution : undefined;
  const failure: TriageSourceFailureV1 = execution.status === 'success' && sourceFailure !== undefined
    ? sourceFailure : execution.status === 'error'
    ? invocationFailure(execution, fallbackCode)
    : {
      class: 'unknown',
      code: execution.status === 'idle' || execution.status === 'pending' ? notDispatchedCode
        : settledFailure?.code ?? fallbackCode,
    };
  return Object.freeze({
    ...failure,
    ...(execution.status === 'error' ? {
      retryable: execution.retryable,
      ...(execution.diagnostics === undefined ? {} : { diagnostics: execution.diagnostics }),
    } : {}),
    ...(execution.status === 'outcomeUnknown' ? { retryable: true } : {}),
    ...(failure.requestId !== undefined ? {}
      : execution.status === 'success' && execution.requestId !== undefined ? { requestId: execution.requestId }
        : settledFailure?.requestId === undefined ? {} : { requestId: settledFailure.requestId }),
  });
}
