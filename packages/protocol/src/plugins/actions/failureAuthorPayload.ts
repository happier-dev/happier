import { readActionFailureCauseV1, type ActionFailureCauseV1 } from '../../actions/actionExecutionResult.js';
import {
  PluginDiagnosticDataV1Schema,
  PluginDiagnosticRemediationV1Schema,
  type PluginDiagnosticDataV1,
  type PluginDiagnosticRemediationV1,
} from '../../daemon/pluginContributionIntrospection.js';
import type { JsonValue as StrictJsonValue } from '../../json/strictJsonValue.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/**
 * The author vocabulary a canonical PluginError publishes alongside its code.
 * Protocol owns the wire decision so the daemon Action host and the SDK test
 * host read one payload the same way instead of each inventing a reader.
 */
export type PluginActionFailureAuthorPayloadV1 = Readonly<{
  failureCause?: ActionFailureCauseV1;
  effectAttempted?: boolean;
  details?: StrictJsonValue;
  remediation?: PluginDiagnosticRemediationV1;
  diagnostics?: readonly PluginDiagnosticDataV1[];
}>;

const PluginActionFailureDiagnosticsV1Schema = lazyZodSchema(() => z.array(PluginDiagnosticDataV1Schema));

/**
 * Reads the author vocabulary out of a projected failure `data` payload. Each
 * field is admitted independently, so one field a target published in a shape
 * this version does not model cannot suppress the rest. Identity and
 * consistency fields are deliberately not read here: `code`, `message` and
 * `retryable` are already carried as proven top-level projection facts.
 */
export function readPluginActionFailureAuthorPayload(
  data: StrictJsonValue | undefined,
): PluginActionFailureAuthorPayloadV1 {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    return Object.freeze({});
  }
  const record = data as Readonly<Record<string, StrictJsonValue | undefined>>;
  const failureCause = record.failureCause === undefined ? undefined : readActionFailureCauseV1(record.failureCause);
  const remediation = record.remediation === undefined
    ? undefined
    : PluginDiagnosticRemediationV1Schema.safeParse(record.remediation);
  const diagnostics = record.diagnostics === undefined
    ? undefined
    : PluginActionFailureDiagnosticsV1Schema.safeParse(record.diagnostics);
  return Object.freeze({
    ...(record.details === undefined ? {} : { details: record.details }),
    ...(failureCause === undefined ? {} : { failureCause }),
    ...(typeof record.effectAttempted === 'boolean' ? { effectAttempted: record.effectAttempted } : {}),
    ...(remediation?.success ? { remediation: remediation.data } : {}),
    ...(diagnostics?.success ? { diagnostics: Object.freeze(diagnostics.data) } : {}),
  });
}
