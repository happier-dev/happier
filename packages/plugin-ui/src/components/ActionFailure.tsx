import { useEffect, useState } from 'react';
import { presentActionFailure, type PluginUiActionFailurePresentationV1 } from '@happier-dev/plugin-sdk/ui';

import { usePluginHostApi } from '../hostApi/context.js';
import type { PluginActionExecution } from '../hostApi/executeAction.js';
import { ErrorState } from './State.js';

type Failure = Extract<PluginActionExecution, { status: 'error' | 'outcomeUnknown' }>;

/** Show the reason and disclose the safe technical details of a settled Action failure. */
export function ActionFailure({ execution }: Readonly<{ execution: PluginActionExecution }>) {
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
      message: failure.authoredMessage,
      details: failure.details,
      requestId: failure.requestId,
      effectAttempted: failure.effectAttempted,
      failureCause: failure.failureCause,
      remediation: failure.remediation,
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
    details={presentation?.technicalDetails.map(line => line.value).join('\n') || failure.code} />;
}
