import type { core } from 'zod/mini';
import { projectActionInputIssues } from './actionInputValidation.js';
import { projectActionFailureCauseV1, readUnexpectedActionErrorDiagnosticV1, type ActionFailureCauseV1, type ActionExecuteFailure } from '../actionExecutionResult.js';
import { redactBugReportSensitiveText } from '../../bugs/reports/redaction.js';

/** In-process diagnostics are deliberately absent from JSON and public failure projection. */
// Author plugins may bundle their own SDK copy in this same process.
const outputDiagnostic = Symbol.for('happier.actionOutputDiagnostic');
export type ActionOutputDiagnostic = Readonly<{
  source: string;
  requestId?: string;
  phase?: string;
  causeKind?: ActionFailureDiagnosticInput['causeKind'];
  exception?: Readonly<{ errorClass: string; message: string }>;
  issues: readonly Readonly<{ path: readonly (string | number)[]; code: string; expected?: string }>[];
  failureCause?: ActionFailureCauseV1;
}>;
type DiagnosticCarrier = { [outputDiagnostic]?: ActionOutputDiagnostic };
type DiagnosticFailure = ActionExecuteFailure & DiagnosticCarrier;
export type ActionFailureDiagnosticInput = Readonly<{
  phase: string;
  causeKind: 'not_found' | 'already_deleted' | 'target_unreachable' | 'binding_missing' | 'native_failure'
    | 'access_denied' | 'server_mismatch' | 'feature_disabled' | 'incomplete' | 'client_required';
  error?: unknown;
}>;

/** Diagnostic prose stays on the private carrier; only the canonical redactor sees it. */
export function withActionFailureDiagnostic<T extends object>(value: T, input: ActionFailureDiagnosticInput,
  record?: (diagnostic: ActionOutputDiagnostic) => void,
): T {
  const carried = readActionOutputDiagnostic(input.error) ?? readActionOutputDiagnostic(value);
  let exception: ActionOutputDiagnostic['exception'];
  try {
    if (input.error instanceof Error) exception = {
      errorClass: readUnexpectedActionErrorDiagnosticV1(input.error).errorClass,
      message: redactBugReportSensitiveText(input.error.message),
    };
  } catch { /* A diagnostic accessor cannot replace the original refusal. */ }
  const diagnostic: ActionOutputDiagnostic = { source: input.phase, issues: [], phase: input.phase, causeKind: input.causeKind,
    ...(exception ? { exception } : {}), ...carried };
  const result = attachDiagnostic(value, diagnostic);
  try { record?.(diagnostic); } catch { /* Logging cannot replace the original refusal. */ }
  return result;
}
/** Parsing public fields must not erase the already-projected in-process diagnosis. */
export function carryActionFailureDiagnostic<T extends object>(value: T, from: unknown,
  options?: Readonly<{ enumerable: true }>,
): T {
  const diagnostic = readActionOutputDiagnostic(from);
  if (!diagnostic) return value;
  return attachDiagnostic(value, diagnostic, options?.enumerable);
}

function attachDiagnostic<T extends object>(value: T, diagnostic: ActionOutputDiagnostic, enumerable = false): T & DiagnosticCarrier {
  // Strict JSON admits non-enumerable host sidecars; public members stay unchanged.
  return Object.defineProperty(value instanceof Error ? value : { ...value }, outputDiagnostic,
    { value: diagnostic, configurable: true, enumerable });
}

export function readActionOutputDiagnostic(value: unknown): ActionOutputDiagnostic | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined;
    const direct = (value as DiagnosticFailure)[outputDiagnostic];
    if (direct) return direct;
    const cause = value instanceof Error ? value.cause : undefined;
    return cause && typeof cause === 'object' ? (cause as DiagnosticFailure)[outputDiagnostic] : undefined;
  } catch { return undefined; }
}

/** One output-failure owner; the input issue projector alone interprets schema issues. */
export function invalidActionOutputFailure(error?: core.$ZodError, source = 'action.output', thrown?: unknown): DiagnosticFailure {
  const issues = error ? projectActionInputIssues(error).map(({ path, code, expected }) => ({ path, code,
    ...(code === 'invalid_type' && expected ? { expected } : {}) })) : [];
  return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output',
    [outputDiagnostic]: { source, issues,
      ...(thrown === undefined ? {} : { failureCause: projectActionFailureCauseV1(thrown, source) }) } };
}
