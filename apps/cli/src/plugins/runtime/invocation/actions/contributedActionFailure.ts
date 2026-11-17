import type { JsonValue } from '@happier-dev/plugin-sdk';
import { DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { projectPluginFailureText } from '@happier-dev/protocol/plugins/failureProjection';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions';
import { PluginError, readPluginErrorRequestIdV1 } from '@happier-dev/plugin-sdk';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';

/** Preserve the public failure envelope across ordinary Action normalization. */
export function projectContributedActionFailure(result: Readonly<{
  errorCode: string;
  error: string;
  details?: unknown;
  retryable?: boolean;
  actionHandlerInvocation?: 'notStarted';
  data?: JsonValue;
}>): ActionExecuteFailure {
  const data = { code: result.errorCode, message: result.error,
    ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
    ...readPluginActionFailureAuthorPayload(result.data) };
  const error = result.actionHandlerInvocation === 'notStarted'
    ? createPluginActionHandlerNotStartedError(data) : new PluginError(data);
  return { ok: false, errorCode: result.errorCode, error: result.error,
    ...(result.actionHandlerInvocation === 'notStarted' ? { effectAttempted: false } : {}),
    ...(error.data.failureCause ? { failureCause: error.data.failureCause } : {}),
    details: result.details === undefined ? error.data : result.details };
}

/** One public refusal projection for immediate RPCs and retained finite results. */
export function projectStructuredMessageActionFailure(result: Readonly<{
  errorCode: string;
  error: string;
  retryable?: boolean;
  actionHandlerInvocation?: 'notStarted';
  data?: JsonValue;
}>) {
  const { diagnostics: _diagnostics, ...authorPayload } = readPluginActionFailureAuthorPayload(result.data);
  const requestId = readPluginErrorRequestIdV1({ details: authorPayload.details });
  const effectAttempted = isJsonObject(authorPayload.details) ? authorPayload.details.effectAttempted : undefined;
  // Target invocation already redacts its failures; observer failures use the same projection.
  const message = result.error.trim();
  return DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
    ok: false,
    code: result.errorCode,
    ...(message && message !== result.errorCode ? { message: projectPluginFailureText(new Error(message)) } : {}),
    ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
    ...(result.actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation: result.actionHandlerInvocation }),
    ...authorPayload,
    ...(requestId === undefined ? {} : { requestId }),
    ...(typeof effectAttempted === 'boolean' ? { effectAttempted } : {}),
  });
}

/** Retained replies restore only facts already public on direct execution. */
export const contributedActionFailureResult = Object.freeze({
  project: projectStructuredMessageActionFailure,
  read(value: unknown) {
    const parsed = DaemonPluginStructuredMessageActionExecuteResponseSchema.safeParse(value);
    if (!parsed.success || parsed.data.ok) return null;
    const failure = parsed.data;
    return {
      ok: false as const,
      errorCode: failure.code,
      error: failure.message ?? failure.code,
      ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
      ...(failure.actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation: failure.actionHandlerInvocation }),
      ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      ...(failure.effectAttempted === undefined ? {} : { effectAttempted: failure.effectAttempted }),
      data: readPluginActionFailureAuthorPayload(failure),
    };
  },
});
