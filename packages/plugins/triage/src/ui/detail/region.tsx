import * as React from 'react';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Heading,
  Item,
  ItemGroup,
  Label,
  Link,
  LoadingState,
  Metadata,
  Row,
  Stack,
  Status,
  TargetedSurface,
  useSurfaceContext,
  type MetadataEntry,
} from '@happier-dev/plugin-ui';
import type { TriageLinkedSessionProjectionV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageListLaneV1, TriageListRowV1 } from '../../projection/listWindow.js';
import { projectTriageDetailHeaderV1, type TriageDetailHeaderV1 } from './header.js';
import { readTriageSourceDetailContributionV1 } from './sourceSurface.js';
import { useTriageEntryDetail } from './useTriageEntryDetail.js';

/**
 * The mounted detail region: the aggregate's common header, and beneath it the
 * source's own detail body.
 *
 * This is the piece that turned a list into a product. Every part of it already
 * existed — the selection reducer, the strict input builder, the six packaged
 * source detail renderers — and nothing mounted them, so a reader could see
 * rows and open none of them.
 *
 * The split is exactly `core/SURFACE.md` §2.2's. The header owns title, source
 * and kind, scope, state, the observing connection, attention and the bounded
 * Session relationship; the source body owns provider-native facts and its own
 * tabs. Neither renders the other's, and this file mounts the source through the
 * shared `TargetedSurface` — it holds no renderer, artifact, catalog or mount
 * lifecycle of its own, because the physical host owns all four.
 *
 * `core/SURFACE.md` §2.3 governs what a refusal is allowed to say: a renderer
 * the host could not mount is named as an unavailable renderer beside the facts
 * the aggregate already holds. It is never reported as a source read failure, a
 * loading state or an empty detail.
 */

export type TriageDetailRegionProps = Readonly<{
  row: TriageListRowV1;
  lanes: readonly TriageListLaneV1[];
  /** The configured connection's display label, when the aggregate knows one. */
  connectionLabel: string | null;
  /** Clears the selection; the stacked composition returns to the list. */
  onClose: () => void;
}>;

function headerEntries(header: TriageDetailHeaderV1): readonly MetadataEntry[] {
  const entries: MetadataEntry[] = [];
  if (header.scopeLabel !== null) entries.push({ label: 'Scope', value: header.scopeLabel });
  if (header.stateLabel !== null) entries.push({ label: 'State', value: header.stateLabel });
  if (header.connectionLabel !== null) {
    entries.push({ label: 'Connection', value: header.connectionLabel });
  }
  return entries;
}

const EMPTY_SESSIONS: readonly TriageLinkedSessionProjectionV1[] = Object.freeze([]);

/** The words the aggregate uses for what it currently knows about the entry. */
const PRESENCE_COPY = Object.freeze({
  present: null,
  absent: 'This entry is no longer at the source.',
  unresolved: 'This entry could not be read from the source.',
});

function LinkedSessions(props: Readonly<{
  sessions: readonly TriageLinkedSessionProjectionV1[];
}>): React.ReactElement | null {
  if (props.sessions.length === 0) return null;
  return (
    <Stack gap="small">
      <Label value="Sessions" />
      <ItemGroup accessibilityLabel="Sessions">
        {props.sessions.map((session) => (
          <Item
            key={session.sessionId}
            // A retained link whose Session the host cannot answer for keeps
            // its row: dropping it would say the entry was never worked on.
            title={session.displayTitle ?? 'Session'}
            accessibilityLabel={session.displayTitle ?? 'Session'}
          />
        ))}
      </ItemGroup>
    </Stack>
  );
}

export function TriageDetailRegion(props: TriageDetailRegionProps): React.ReactElement {
  const context = useSurfaceContext();
  const lookup = readTriageSourceDetailContributionV1(context, props.row.entryRef.source);

  const selection = React.useMemo(() => (
    props.row.selected.kind === 'selected'
      ? { entryRef: props.row.entryRef, sourceInstanceId: props.row.selected.sourceInstanceId }
      : null
  ), [props.row]);
  const observation = React.useMemo(() => {
    if (selection === null) return null;
    const found = props.row.observations.find(
      (candidate) => candidate.sourceInstanceId === selection.sourceInstanceId
        && candidate.outcome.kind === 'present',
    );
    if (found === undefined || found.outcome.kind !== 'present') return null;
    return {
      entryRef: props.row.entryRef,
      observedAtMs: found.observedAtMs,
      locator: found.outcome.locator,
      snapshot: found.outcome.snapshot,
      viewer: found.outcome.viewer,
      ...(found.outcome.sourceUpdatedAtMs === undefined
        ? {}
        : { sourceUpdatedAtMs: found.outcome.sourceUpdatedAtMs }),
    };
  }, [props.row, selection]);

  const detail = useTriageEntryDetail(
    selection === null || observation === null ? null : { selection, observation },
  );
  const linkedSessions = detail?.kind === 'ready' ? detail.input.linkedSessions : EMPTY_SESSIONS;
  const header = React.useMemo(() => projectTriageDetailHeaderV1({
    row: props.row,
    lanes: props.lanes,
    connectionLabel: props.connectionLabel,
    linkedSessions,
  }), [linkedSessions, props.connectionLabel, props.lanes, props.row]);

  const entries = headerEntries(header);
  const presenceCopy = PRESENCE_COPY[header.presence];

  return (
    <Stack gap="small">
      <Row justify="space-between" align="center">
        <Heading level={2} value={header.title} />
        <Button title="Close" variant="secondary" onPress={props.onClose} />
      </Row>

      {header.attention === null ? null : (
        <Badge
          tone={header.attention.level === 'required' ? 'warning' : 'info'}
          value={header.attention.reasonLabel}
        />
      )}

      {entries.length === 0 ? null : <Metadata entries={entries} />}

      {presenceCopy === null ? null : <Status tone="warning" label={presenceCopy} />}

      {header.sourceUnhealthy ? (
        <Status tone="muted" label="This connection did not answer in the last pass." />
      ) : null}

      {header.webUrl === null ? null : <Link title="Open at the source" url={header.webUrl} />}

      <LinkedSessions sessions={header.linkedSessions} />

      {detail === null ? (
        <EmptyState
          title="No connection to open this through"
          description="No configured connection currently observes this entry, so there is nothing to read it with."
        />
      ) : detail.kind === 'reading' ? (
        <LoadingState title="Reading this entry" />
      ) : detail.kind === 'unavailable' ? (
        <EmptyState
          title="This connection is no longer configured"
          description="The connection this entry was read through has been removed or replaced, so its details cannot be opened."
        />
      ) : detail.kind === 'unreachable' ? (
        <ErrorState
          title="Your account could not be read"
          description="Happier could not reach your account, so this entry's details are unavailable right now."
        />
      ) : detail.kind === 'refused' ? (
        <Banner
          tone="warning"
          title="These details could not be prepared"
          description="What Happier holds for this entry does not fit what a source detail is allowed to receive, so it was not handed over."
        />
      ) : lookup.kind !== 'admitted' ? (
        <EmptyState
          title="This source has no detail view"
          description="The source that owns this entry does not currently contribute a detail surface."
        />
      ) : (
        <TargetedSurface
          surface={lookup.surface}
          input={detail.input}
          // Remounts on entry and on connection, and on nothing else: a refresh
          // that re-reads the same selection must not throw away the tab, scroll
          // and parser state the source body is holding.
          instanceKey={`${props.row.entryRef.entryId}:${detail.input.instance.instance.sourceInstanceId}`}
          fallback={(
            <EmptyState
              // §2.3: the host's mount lifecycle is not source-domain status.
              title="This source's detail view is unavailable"
              description="Happier could not mount the source's own view of this entry. The facts above are what the aggregate already knows."
            />
          )}
        />
      )}
    </Stack>
  );
}
