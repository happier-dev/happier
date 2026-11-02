import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { projectPluginActionFailureCode, type PluginActionInvocationResult, type PluginActionInputParserIssue } from '@happier-dev/protocol/plugins/actions/invocation';
import { projectPluginFailureText } from '@happier-dev/protocol/plugins/failureProjection';
import { projectTargetActionDiagnosticIssue, readTargetActionDiagnosticConfidentiality } from './actionDiagnosticRedaction.js';
import { redactPluginInvocationResultData } from './actionResultRedaction.js';

export type TargetActionExecutionResult = Readonly<
  | { status: 'executed'; value: JsonValue | null }
  | { status: 'deferred'; artifactId: string }
  | {
    status: 'unavailable' | 'invalid' | 'failed';
    code: string;
    message: string;
    issues?: readonly PluginActionInputParserIssue[];
    /** Failures only, and only for a proven canonical PluginError. */
    retryable?: boolean;
    /** Failures only: the target's own published PluginError contract payload. */
    data?: JsonValue;
    /** Present only when the generic Action owner proves the target handler never began. */
    actionHandlerInvocation?: 'notStarted';
  }
>;

/** One public projection for admission failures and registered invocation secrets. */
export function projectTargetActionFailure(
  result: PluginActionInvocationResult,
  redact?: (value: string) => string,
  confidentialInput?: Readonly<{
    input: unknown;
    secretInputPaths: readonly string[];
    rawConfidentiality?: ReturnType<typeof readTargetActionDiagnosticConfidentiality>;
  }>,
): PluginActionInvocationResult;
export function projectTargetActionFailure(
  result: TargetActionExecutionResult,
  redact?: (value: string) => string,
  confidentialInput?: Readonly<{
    input: unknown;
    secretInputPaths: readonly string[];
    rawConfidentiality?: ReturnType<typeof readTargetActionDiagnosticConfidentiality>;
  }>,
): TargetActionExecutionResult;
export function projectTargetActionFailure(
  result: TargetActionExecutionResult,
  redact?: (value: string) => string,
  confidentialInput?: Readonly<{
    input: unknown;
    secretInputPaths: readonly string[];
    rawConfidentiality?: ReturnType<typeof readTargetActionDiagnosticConfidentiality>;
  }>,
): TargetActionExecutionResult {
  if (result.status === 'deferred') return result;
  if (result.status === 'executed') {
    if (!redact) return result;
    try {
      return Object.freeze({ ...result, value: redactPluginInvocationResultData(result.value, redact) });
    } catch {
      return Object.freeze({ status: 'failed', code: 'plugin_action_execution_failed',
        message: 'plugin_action_execution_failed' });
    }
  }
  let code = projectPluginActionFailureCode(result.code);
  let message = result.message;
  let data = result.data;
  let issues = result.issues;
  let confidentiality: ReturnType<typeof readTargetActionDiagnosticConfidentiality> | undefined;
  if (confidentialInput) {
    try {
      const classified = readTargetActionDiagnosticConfidentiality(
        confidentialInput.input, confidentialInput.secretInputPaths, confidentialInput.rawConfidentiality,
      );
      confidentiality = classified;
      const { nonStringPaths } = classified;
      issues = issues?.map(issue => projectTargetActionDiagnosticIssue(issue, classified) ?? issue);
      const firstIssue = issues?.[0];
      if (firstIssue && firstIssue !== result.issues?.[0]) message = firstIssue.message;
      if (nonStringPaths.length > 0 && result.code === 'plugin_action_result_schema_invalid' && !result.issues) {
        // The Protocol result parser retains only prose, losing issue provenance.
        // Use its content-free schema failure rather than guessing operand text.
        message = 'Plugin action result does not match its executable result schema';
      }
    } catch {
      code = 'plugin_action_execution_failed';
      message = code;
      data = undefined;
      issues = undefined;
    }
  }
  if (redact || confidentiality) {
    const redactText = redact ?? ((value: string) => value);
    const projected = { code, message, data, issues };
    code = 'plugin_action_execution_failed';
    message = code;
    data = undefined;
    issues = undefined;
    try {
      const redactedCode = redactText(projected.code);
      code = redactedCode === projected.code ? projectPluginActionFailureCode(projected.code) : code;
      message = redactText(projected.message);
      data = projected.data === undefined ? undefined : redactPluginInvocationResultData(projected.data, redactText, confidentiality);
      issues = projected.issues?.map(issue => Object.freeze({
        path: Object.freeze(issue.path.map(segment => typeof segment === 'string' ? redactText(segment) : segment)),
        code: redactText(issue.code), message: redactText(issue.message),
        ...(issue.expected === undefined ? {} : { expected: redactText(issue.expected) }),
        ...(issue.acceptedValues === undefined ? {} : {
          acceptedValues: Object.freeze(issue.acceptedValues.map(value => typeof value === 'string' ? redactText(value) : value)),
        }),
      }));
    } catch {
      // A failed scoped redactor cannot disclose a partially projected diagnostic.
      code = 'plugin_action_execution_failed';
      message = code;
      data = undefined;
      issues = undefined;
    }
  }
  return Object.freeze({
    status: result.status, code, message: projectPluginFailureText(new Error(message)),
    ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
    ...(data === undefined ? {} : { data }),
    ...(issues === undefined ? {} : { issues }),
    ...(result.actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation: result.actionHandlerInvocation }),
  });
}
