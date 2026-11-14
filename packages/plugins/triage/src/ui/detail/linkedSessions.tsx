import * as React from 'react';

import {
  Button,
  Label,
  SessionCard,
  Stack,
  Status,
  usePluginTranslation,
  useSessionState,
  type SessionStateReadV1,
} from '@happier-dev/plugin-ui';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';

import { useLinkedSessionOpen } from './useLinkedSessionOpen.js';
import { describeTriageAgentStatusV1 } from './agentState.js';

const LinkedSessionRow = React.memo(function LinkedSessionRow(props: Readonly<{
  sessionId: TriageLinkedSessionProjectionV1['sessionId'];
  busy: boolean;
  unavailable: boolean;
  failed: boolean;
  onSelect?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
  open: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => Promise<unknown>;
}>) {
  const text = usePluginTranslation();
  const read = useSessionState(props.sessionId);
  // The agent's card (lab c7/t1 "Claude's work"): the shared Session card, in Triage's words for its state.
  const status = read.state === null ? null : describeTriageAgentStatusV1(read.state);
  // An archived Session is history: it stays one press away, quieter than the work still in hand.
  const archived = read.state !== null && (read.state.lifecycle === 'archived' || read.state.lifecycle === 'cancelled');
  const notice = props.failed
    ? <Status tone="danger" labelKey="plugins.triage.surface.detail.sessionOpenFailed" label="This Session could not be opened." />
    : props.unavailable
      ? <Status tone="muted" labelKey="plugins.triage.surface.detail.sessionUnavailable" label="Another Session is opening." />
      : null;
  const onSelect = props.onSelect;
  return (
    <Stack style={archived ? ARCHIVED_STYLE : undefined}>
    <SessionCard
      sessionId={props.sessionId}
      read={read}
      status={status === null ? null : { label: text(status.labelKey, status.label, status.labelParams), tone: status.tone, live: status.live }}
      onOpen={() => { void props.open(props.sessionId); }}
      openBusy={props.busy}
      openDisabled={props.unavailable}
      {...(onSelect === undefined || props.unavailable ? {} : { onPress: () => onSelect(props.sessionId) })}
      notice={notice}
      testID={`triage-session-card-${props.sessionId}`}
    />
    </Stack>
  );
});

const ARCHIVED_STYLE = Object.freeze({ opacity: 0.62 });

/** The detail reader owns continuation and retry; both linked-Session presentations consume it. */
export function TriageLinkedSessionsContinuation(props: Readonly<{
  hasMore: boolean;
  pageState?: 'idle' | 'loading' | 'failed';
  onLoadMore?: () => void;
}>): React.ReactElement | null {
  return <>
    {props.hasMore ? <Button titleKey={props.pageState === 'failed' ? 'plugins.triage.surface.loadMore.retry' : 'plugins.triage.surface.loadMore'}
      title={props.pageState === 'failed' ? 'Retry' : 'Load more'} variant="secondary"
      busy={props.pageState === 'loading'} disabled={props.onLoadMore === undefined} onPress={() => { props.onLoadMore?.(); }} /> : null}
    {props.pageState === 'failed' ? <Status tone="danger" labelKey="plugins.triage.surface.detail.sessionsLoadFailed"
      label="More linked Sessions could not be loaded." /> : null}
  </>;
}

/** Common-header rendering for the bounded read-only linked Session projection. */
export function TriageLinkedSessions(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
  hasMore: boolean;
  pageState?: 'idle' | 'loading' | 'failed';
  onLoadMore?: () => void;
  onSelect?: (sessionId: TriageLinkedSessionProjectionV1['sessionId']) => void;
  /** Omit the visible label when an enclosing story step already names the group. */
  labelled?: boolean;
  /** The detail's live reads of these Sessions, which place archived ones last. */
  states?: ReadonlyMap<string, SessionStateReadV1>;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const { busySessionId, failedSessionId, open: openSession } = useLinkedSessionOpen();
  // Work still in hand leads; archived Sessions follow in their own order.
  const ordered = React.useMemo(() => {
    const states = props.states;
    if (states === undefined) return props.sessions;
    const isArchived = (session: TriageLinkedSessionProjectionV1) => {
      const lifecycle = states.get(session.sessionId)?.state?.lifecycle;
      return lifecycle === 'archived' || lifecycle === 'cancelled';
    };
    return [...props.sessions.filter((session) => !isArchived(session)), ...props.sessions.filter(isArchived)];
  }, [props.sessions, props.states]);
  if (props.sessions.length === 0) return null;
  return (
    <Stack gap="small">
      {props.labelled === false ? null : (
        <Label value={text('plugins.triage.surface.detail.sessions', 'Sessions')} />
      )}
      <Stack gap="small">
        {ordered.map((session) => (
          <LinkedSessionRow
            key={session.sessionId}
            sessionId={session.sessionId}
            busy={busySessionId === session.sessionId}
            unavailable={busySessionId !== null && busySessionId !== session.sessionId}
            failed={failedSessionId === session.sessionId}
            onSelect={props.onSelect}
            open={openSession}
          />
        ))}
      </Stack>
      <TriageLinkedSessionsContinuation hasMore={props.hasMore} pageState={props.pageState} onLoadMore={props.onLoadMore} />
    </Stack>
  );
}
