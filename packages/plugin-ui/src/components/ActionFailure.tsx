import { useEffect, useState } from 'react';
import { presentActionFailure, type PluginUiActionFailurePresentationV1 } from '@happier-dev/plugin-sdk/ui';

import { usePluginHostApi } from '../hostApi/context.js';
import type { PluginActionExecution } from '../hostApi/executeAction.js';
import { ErrorState, type ErrorStateProps } from './State.js';

type Failure = Extract<PluginActionExecution, { status: 'error' | 'outcomeUnknown' }>;

/** Show the reason and disclose the safe technical details of a settled Action failure. */
export function ActionFailure({ execution, onRetry, retryLabel }: Readonly<{
  execution: PluginActionExecution;
}> & Pick<ErrorStateProps, 'onRetry' | 'retryLabel'>) {
  const host = usePluginHostApi();
  const failure = execution.status === 'error' || execution.status === 'outcomeUnknown' ? execution : null;
  const [presented, setPresented] = useState<Readonly<{
    failure: Failure;
    host: typeof host;
    presentation: PluginUiActionFailurePresentationV1;
  }> | null>(null);

  useEffect(() => {
    if (!failure) return;
    const controller = new AbortController();
    void presentActionFailure(host, {
      ok: false,
      errorCode: failure.code,
      error: failure.message,
      ...(failure.authoredMessage === undefined ? {} : { message: failure.authoredMessage }),
      ...(failure.details === undefined ? {} : { details: failure.details }),
      ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      ...(failure.effectAttempted === undefined ? {} : { effectAttempted: failure.effectAttempted }),
      ...(failure.failureCause === undefined ? {} : { failureCause: failure.failureCause }),
      ...(failure.remediation === undefined ? {} : { remediation: failure.remediation }),
    }, { signal: controller.signal }).then(presentation => {
      if (!controller.signal.aborted) setPresented({ failure, host, presentation });
    }, () => {
      // The synchronous reason and code remain available if presentation is withdrawn.
    });
    return () => controller.abort();
  }, [failure, host]);

  if (!failure) return null;
  const presentation = presented?.failure === failure && presented.host === host ? presented.presentation : null;
  return <ErrorState layout="line" title={presentation?.reason ?? failure.message}
    description={presentation?.nextStep ?? undefined}
    details={presentation?.technicalDetails.map(line => `${line.label}: ${line.value}`).join('\n') || failure.code}
    onRetry={onRetry} retryLabel={retryLabel} />;
}
