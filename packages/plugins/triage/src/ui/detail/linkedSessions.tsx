import * as React from 'react';

import {
  Item,
  ItemGroup,
  Label,
  Stack,
  Status,
  usePluginHostApi,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';

import { openLinkedSession } from '../../sessions/entrySessionOpen.js';

/** Common-header rendering for the bounded read-only linked Session projection. */
export function TriageLinkedSessions(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
  hasMore: boolean;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const [busySessionId, setBusySessionId] = React.useState<string | null>(null);
  const [failedSessionId, setFailedSessionId] = React.useState<string | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const openSession = React.useCallback(async (sessionId: string) => {
    if (busySessionId !== null) return;
    setBusySessionId(sessionId);
    setFailedSessionId(null);
    const result = await openLinkedSession({
      execute: async (actionId, input, options) => await host.executeAction(actionId, input, options),
      sessionId,
    });
    if (!mounted.current) return;
    setBusySessionId(null);
    setFailedSessionId(result.status === 'failed' ? sessionId : null);
  }, [busySessionId, host]);
  if (props.sessions.length === 0) return null;
  return (
    <Stack gap="small">
      <Label value={text('plugins.triage.surface.detail.sessions', 'Sessions')} />
      <ItemGroup accessibilityLabel={text('plugins.triage.surface.detail.sessions', 'Sessions')}>
        {props.sessions.map((session) => (
          <Item
            key={session.sessionId}
            title={session.displayTitle ?? text('plugins.triage.surface.detail.session', 'Session')}
            accessibilityLabel={session.displayTitle ?? text('plugins.triage.surface.detail.session', 'Session')}
            busy={busySessionId === session.sessionId}
            disabled={busySessionId !== null && busySessionId !== session.sessionId}
            onPress={() => { void openSession(session.sessionId); }}
          />
        ))}
      </ItemGroup>
      {props.hasMore ? (
        <Status
          tone="muted"
          labelKey="plugins.triage.surface.detail.sessionsMore"
          label="More linked Sessions are available."
        />
      ) : null}
      {failedSessionId === null ? null : (
        <Status
          tone="danger"
          labelKey="plugins.triage.surface.detail.sessionOpenFailed"
          label="This Session could not be opened."
        />
      )}
    </Stack>
  );
}
