import { win32 } from 'node:path';
import { projectActionFailureCauseV1, readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';

type RunPreparationPhase =
  | 'request_account_context' | 'request_settings' | 'request_features'
  | 'provider_authorization' | 'provider_before_effect' | 'managed_endpoint'
  | 'binding_account_context' | 'binding_run_authority' | 'managed_source_open'
  | 'consumer_application_start' | 'binding_source_currentness'
  | 'provider_materialization' | 'endpoint_currentness' | 'provider_commit'
  | 'engine_resolution' | 'connected_services_selection' | 'provider_features'
  | 'account_snapshot' | 'provider_launch' | 'connected_services_materialization'
  | 'secret_reference_snapshot' | 'runtime_provider_commit' | 'runtime_create';

/** One completion record per preparation step, including both clock endpoints.
 * Never inspect error contents, launch values or credentials. No polling or
 * authority observations are added; non-Run callers keep their existing logs. */
export async function traceRunPreparationPhase<T>(
  runId: string | undefined,
  phase: RunPreparationPhase,
  signal: AbortSignal | undefined,
  work: () => T | Promise<T>,
): Promise<T> {
  if (!runId) return await work();
  const startedAtMs = Date.now();
  const startedAt = performance.now();
  let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
  try {
    const result = await work();
    outcome = 'completed';
    return result;
  } finally {
    logger.infoFile('[PROVIDER] Run preparation phase', {
      runId, phase, outcome: outcome === 'failed' && signal?.aborted ? 'cancelled' : outcome,
      startedAtMs, finishedAtMs: Date.now(), elapsedMs: Math.round(performance.now() - startedAt),
    });
  }
}

/** Strip parent paths from frames validated by the canonical error parser. */
export function projectProviderFailureSourceLocations(
  diagnostic: Pick<ReturnType<typeof readUnexpectedActionErrorDiagnosticV1>, 'stackFrames'>,
): readonly string[] {
  return diagnostic.stackFrames.map(frame => `${win32.basename(frame.file)}:${frame.line}:${frame.column}`);
}

/** Unexpected failures may contain credentials in their message or cause.
 * Retain the exception class and source coordinates, never arbitrary prose,
 * paths, request data, or serialized error objects. */
export function logProviderUnexpectedFailure(
  operation: 'launch' | 'model_projection',
  error: unknown,
): void {
  try {
    const failures: readonly unknown[] = error instanceof AggregateError ? error.errors : [error];
    for (const failure of failures) {
      const errorType = failure instanceof Error
        ? [Error, TypeError, ReferenceError, RangeError, SyntaxError, URIError, EvalError]
          .find(type => failure.constructor === type)?.name ?? 'Error'
        : 'Unknown';
      const sourceLocations = projectProviderFailureSourceLocations(readUnexpectedActionErrorDiagnosticV1(failure));
      logger.warnLocalFile('[PROVIDER] Unexpected failure', { operation, errorType, sourceLocations, failureCause: projectActionFailureCauseV1(failure) });
    }
  } catch { /* Diagnostics cannot replace the original Provider failure. */ }
}
