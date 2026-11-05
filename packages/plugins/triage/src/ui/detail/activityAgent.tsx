import * as React from 'react';

import {
  Row,
  Text,
  type PluginTranslate,
  type SessionStateReadV1,
} from '@happier-dev/plugin-ui';
import type {
  TriageActivityAgentV1,
  TriageDetailPrimaryWriteV1,
} from '@happier-dev/triage-sources/ui';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';

type TriageActivityEventV1 = TriageActivityAgentV1['events'][number];

/**
 * What the entry's linked Sessions did, as Activity events (lab c7 "merged-activity": one timeline mixing source
 * and Happier events). Each is a Session's latest activity the host already reports for the Sessions this detail
 * reads; the host's Session title supplies the one-line summary, never the transcript body. Nothing is read for it,
 * and a Session whose latest activity is hidden, empty or unread adds nothing.
 */
export function readTriageActivitySessionEventsV1(
  sessions: readonly TriageLinkedSessionProjectionV1[],
  reads: ReadonlyMap<string, SessionStateReadV1>,
): readonly TriageActivityEventV1[] {
  const events: TriageActivityEventV1[] = [];
  for (const session of sessions) {
    const state = reads.get(session.sessionId)?.state ?? null;
    const latest = state?.latestActivity;
    if (
      state === null ||
      latest === undefined ||
      latest.kind !== 'ready' ||
      latest.text.trim() === '' ||
      !state.title?.trim()
    )
      continue;
    events.push({
      id: `happier-session:${session.sessionId}:${latest.createdAt}`,
      atMs: latest.createdAt,
      kind: 'session',
      actor: state.agent?.displayName ?? null,
      summary: state.title,
    });
  }
  return events;
}

/**
 * The Activity's honest "Next:" (lab c7): what the source says still stands between this pull request and merging,
 * in the source's own words. Nothing is said when the source reports no merge readiness, or while the agent is the
 * one waiting on the reader (its card above already says so).
 */
export function readTriageActivityNextV1(
  write: TriageDetailPrimaryWriteV1 | null,
  agentNeedsReader: boolean,
): string | null {
  if (agentNeedsReader || write === null || write.readiness === undefined)
    return null;
  const sentence = write.readiness.reason ?? write.readiness.label;
  return sentence.trim() === '' ? null : sentence;
}

/** The "Next:" line that closes the Activity, quiet, under the agent card. */
export function TriageActivityNext(
  props: Readonly<{ sentence: string; text: PluginTranslate }>,
): React.ReactElement {
  return (
    <Row gap="xsmall" align="center" testID="triage-activity-next">
      <Text
        variant="meta"
        tone="secondary"
        value={props.text(
          'plugins.triage.surface.detail.activity.next',
          'Next: {sentence}',
          { sentence: props.sentence },
        )}
      />
    </Row>
  );
}
