import * as React from 'react';
import { PluginError } from '@happier-dev/plugin-sdk';
import { presentTriageMountedUiActionFailure } from '../mountedActions.js';
import { usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';

import { openLinkedSession } from '../../sessions/entrySessionOpen.js';

/** One mounted failure/retry lifecycle for the existing Session-open owner. */
export function useLinkedSessionOpen() {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const [busySessionId, setBusySessionId] = React.useState<SessionId | null>(null);
  const [failedSessionId, setFailedSessionId] = React.useState<SessionId | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const open = React.useCallback(async (sessionId: SessionId, serverId?: string) => {
    if (busySessionId !== null) return;
    setBusySessionId(sessionId);
    setFailedSessionId(null);
    const result = await openLinkedSession({
      execute: (actionId, input, options) => host.executeAction(actionId, input, options),
      sessionId, ...(serverId === undefined ? {} : { serverId }),
    });
    if (!mounted.current) return;
    setBusySessionId(null);
    setFailedSessionId(result.status === 'failed' ? sessionId : null);
    if (result.status === 'failed' && result.failure !== undefined) {
      await presentTriageMountedUiActionFailure(host, new PluginError({
        code: result.failure.codes[0] ?? 'unavailable',
        diagnostics: result.failure.codes.slice(1).map(code => ({ code, severity: 'error' })),
        ...(result.failure.requestId === undefined ? {} : { details: { requestId: result.failure.requestId } }),
      }), text);
    }
    return result;
  }, [busySessionId, host, text]);
  return { busySessionId, failedSessionId, open };
}
