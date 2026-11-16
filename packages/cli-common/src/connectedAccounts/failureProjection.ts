import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';

import {
  isPluginError,
  PluginError,
  type PluginDiagnosticData,
} from '../plugins/errors.js';

type RedactText = (value: string) => string;

export type ConnectedAccountFailureProjection = Readonly<{
  code: string;
  /** Present only when the failure carries more than its code. */
  diagnostic?: PluginDiagnosticData;
}>;

function readAuthoredMessage(
  error: unknown,
  code: string,
  redactText: RedactText,
): string | undefined {
  if (!isPluginError(error)) return undefined;
  const message = error.message.trim();
  if (!message || message === error.code || message === code) return undefined;
  return redactText(message);
}

/**
 * The one connected-account exception-to-result projection. It keeps the thrown
 * typed code and, when the failure says more than that code, a diagnostic with
 * the author's PluginError message and remediation plus the closed Action cause
 * (error code, HTTP status). Author details, request or response bodies and
 * untyped exception prose never leave; the message goes through the redactor.
 */
export function projectConnectedAccountFailure(
  error: unknown,
  input: Readonly<{
    /**
     * `fallback`: the thrown typed code wins, else this one. `outcome`: the
     * result's code is fixed (e.g. an outcome-unknown class) and the thrown
     * typed code travels only inside the cause.
     */
    code: Readonly<{ fallback: string }> | Readonly<{ outcome: string }>;
    phase: string;
    redactText?: RedactText;
  }>,
): ConnectedAccountFailureProjection {
  const code = 'outcome' in input.code
    ? input.code.outcome
    : readActionErrorCodeV1(error) ?? input.code.fallback;
  const message = readAuthoredMessage(
    error,
    code,
    input.redactText ?? redactBugReportSensitiveText,
  );
  const remediation = isPluginError(error) ? error.remediation : undefined;
  const failureCause = projectActionFailureCauseV1(error, input.phase);
  const carriesCause =
    failureCause.httpStatus !== null ||
    (failureCause.errorCode !== null && failureCause.errorCode !== code);
  if (message === undefined && remediation === undefined && !carriesCause)
    return { code };
  return {
    code,
    diagnostic: Object.freeze({
      code,
      severity: 'error' as const,
      ...(message === undefined ? {} : { message }),
      ...(remediation === undefined ? {} : { remediation }),
      // The closed cause is JSON; absent optional leaves are dropped.
      details: {
        failureCause: Object.fromEntries(Object.entries(failureCause).filter(([, value]) => value !== undefined)),
      },
    }),
  };
}

/**
 * A provider callback's PluginError leaves its invocation only after the
 * invocation's own redactor saw it, because that redactor alone knows the
 * secrets submitted to this attempt. Other thrown values pass unchanged.
 */
export function redactConnectedAccountProviderFailure(
  error: unknown,
  redactText: RedactText | undefined,
): unknown {
  if (!isPluginError(error) || !redactText) return error;
  const message = readAuthoredMessage(error, error.code, redactText);
  return new PluginError({
    code: error.code,
    ...(message === undefined ? {} : { message }),
    ...(error.remediation === undefined
      ? {}
      : { remediation: error.remediation }),
    failureCause: projectActionFailureCauseV1(
      error,
      'connected_account.provider',
    ),
  });
}
