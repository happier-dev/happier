import { AsyncLocalStorage } from 'node:async_hooks';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';

type BindingDiagnosticIdentity = Readonly<{
  requestId?: string;
  invocationId?: string;
  correlationId?: string;
  sessionId?: string;
  pluginId?: string;
  localId?: string;
  purpose?: string;
  subscriptionId?: string;
  operation?: 'get_binding' | 'watch_open' | 'watch_next';
}>;
type BindingDiagnosticStage = 'dispatch' | 'authorization' | 'binding_read' | 'consumer_lock'
  | 'retained_binding' | 'account_purpose_read' | 'account_currentness' | 'target_resolution';

const context = new AsyncLocalStorage<BindingDiagnosticIdentity>();

/** Host-private correlation only; never transport diagnostic state through the public SDK. */
export function withConnectedAccountBindingDiagnostic<T>(identity: BindingDiagnosticIdentity, operation: () => T): T {
  const inherited = context.getStore();
  return context.run({ ...inherited, ...identity }, operation);
}

function failureCode(error: unknown): string {
  // Plugin error codes are author-controlled too. A syntactically valid
  // arbitrary code can contain a secret; keep this corridor's known vocabulary.
  try {
    const code: unknown = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && [
      'plugin_connected_account_settings_unavailable', 'plugin_connected_account_settings_conflict',
      'plugin_connected_account_purpose_undeclared', 'plugin_connected_account_binding_out_of_scope',
      'plugin_host_access_resource_not_selected', 'plugin_host_access_operation_denied',
      'plugin_services_turn_authority_unavailable', 'plugin_final_generation_retired',
      'account_encryption_currentness_unavailable', 'account_storage_currentness_unavailable',
      'plugin_connected_account_binding_unavailable',
    ].includes(code)) return code;
    if (error instanceof Error && error.name === 'AbortError') return 'operation_cancelled';
  } catch { /* A thrown accessor cannot replace the original failure. */ }
  return readUnexpectedActionErrorDiagnosticV1(error).errorCode ?? 'binding_read_failed';
}

function bindingUnavailableReason(error: unknown): string | undefined {
  if (failureCode(error) !== 'plugin_connected_account_binding_unavailable'
    || !error || typeof error !== 'object' || !('details' in error)) return undefined;
  const details = error.details;
  const reason = details && typeof details === 'object' && 'reasonCode' in details ? details.reasonCode : undefined;
  return typeof reason === 'string' && ['subject_absent', 'subject_retired', 'purpose_unauthorized',
    'scope_unauthorized', 'target_unavailable', 'unselected'].includes(reason) ? reason : undefined;
}

/** File-only, content-free begin/terminal records. Logging never changes the operation. */
export async function runConnectedAccountBindingStage<T>(stage: BindingDiagnosticStage, operation: () => T | Promise<T>): Promise<T> {
  const identity = context.getStore();
  if (!identity) return await operation();
  const started = performance.now();
  const record = (event: 'begin' | 'end' | 'failure', error?: unknown) => {
    try {
      // The file sink treats bare sessionId as a possible credential. This is
      // the host-admitted Happier Session identity, not a native session secret.
      const { sessionId, ...correlation } = identity;
      logger[event === 'failure' ? 'warnLocalFile' : 'debug']('[connected-account-binding-stage]', { ...correlation,
        ...(sessionId ? { agentSessionId: sessionId } : {}), stage, event,
        durationMs: performance.now() - started,
        ...(event === 'failure' ? { errorCode: failureCode(error),
          ...(bindingUnavailableReason(error) ? { reasonCode: bindingUnavailableReason(error) } : {}) } : {}) });
    } catch { /* Diagnostics cannot alter credential authority or settlement. */ }
  };
  record('begin');
  try {
    const value = await operation();
    record('end');
    return value;
  } catch (error) {
    record('failure', error);
    throw error;
  }
}
