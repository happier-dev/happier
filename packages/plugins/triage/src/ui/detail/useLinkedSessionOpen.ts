import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';

import { openLinkedSession } from '../../sessions/entrySessionOpen.js';

/** One mounted failure/retry lifecycle for the existing Session-open owner. */
export function useLinkedSessionOpen() {
  const host = usePluginHostApi();
  const [busySessionId, setBusySessionId] = React.useState<SessionId | null>(null);
  const [failedSessionId, setFailedSessionId] = React.useState<SessionId | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const open = React.useCallback(async (sessionId: SessionId) => {
    if (busySessionId !== null) return;
    setBusySessionId(sessionId);
    setFailedSessionId(null);
    const result = await openLinkedSession({
      execute: (actionId, input, options) => host.executeAction(actionId, input, options),
      sessionId,
    });
    if (!mounted.current) return;
    setBusySessionId(null);
    setFailedSessionId(result.status === 'failed' ? sessionId : null);
  }, [busySessionId, host]);
  return { busySessionId, failedSessionId, open };
}
