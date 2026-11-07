import * as React from 'react';
import {
  Avatar,
  Button,
  Icon,
  IconButton,
  Markdown,
  Row,
  Stack,
  Surface,
  Text,
  Timeline,
  type IconName,
  type TextTone,
  type TimelineItemContent,
  usePluginHostApi,
} from '@happier-dev/plugin-ui';
import { formatTriageCompactAgeV1, formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';

import { useTriageActivityAgent, useTriagePageRefresh } from './activityAgent.js';
import { TriageTextPreview } from './textPreview.js';

/**
 * What kind of thing happened. It picks the event's marker; the sentence says the rest.
 *
 * A remark (`comment`) is marked by the person who made it. Everything else is marked by
 * what it did, so a reader scanning the rail can tell talk from state changes.
 */
export type TriageActivityKindV1 =
  | 'comment'
  | 'review'
  | 'change'
  | 'state'
  | 'label'
  | 'assignment'
  | 'check'
  | 'escalation'
  | 'session'
  | 'other';

/** One event in an entry's Activity, mapped by its source from the provider's own record. */
export type TriageActivityEventV1 = Readonly<{
  /** Stable provider identity; never a page position. */
  id: string;
  /** When it happened. An undated event sorts after every dated one rather than to the epoch. */
  atMs: number | null;
  kind: TriageActivityKindV1;
  /** Who acted, as the provider names them. */
  actor?: string | null;
  /** What happened, already in the reader's language. It follows the actor's name. */
  summary: string;
  /** Quiet context after the sentence: the label, the commit subject, the changed fields. */
  detail?: string | null;
  /** A remark's own words, or source-rendered document content, quoted under the sentence. */
  quote?: React.ReactNode;
  /** Colours the marker: a failing check, a regression, a resolution. */
  tone?: TextTone;
  /** The provider's own page for this event. */
  href?: string | null;
  /** The accessible name of the open control; the source states it in the reader's language. */
  hrefLabel?: string;
  /** Source-owned content under the sentence: a thread's replies and controls, a reveal. */
  inset?: React.ReactNode;
  /** Source-owned quiet controls beside the open control, such as editing the viewer's own remark. */
  actions?: React.ReactNode;
}>;

/** A source's own continuation for one of the collections it pages into this stream. */
export type TriageActivityContinuationV1 = Readonly<{
  key: string;
  title: string;
  titleKey?: string;
  pending: boolean;
  onLoadMore: () => void;
  /**
   * Which end of the stream the next page lands at. A collection paged newest first reads
   * EARLIER remarks next, so its control sits above the stream where they will appear;
   * one paged oldest first reads later events, below. Defaults to `later`.
   */
  reads?: 'earlier' | 'later';
}>;

export type TriageActivityTimelineProps = Readonly<{
  events: readonly TriageActivityEventV1[];
  locale: string;
  /** One render-time read, passed in so no row owns a hidden clock. */
  nowMs: number;
  accessibilityLabel: string;
  accessibilityLabelKey?: string;
  /** Above the stream: partial-read banners, a scope note. */
  header?: React.ReactNode;
  /** Shown instead of the stream when no event was read. */
  empty: React.ReactNode;
  /** One per collection the source still has pages of; each keeps its own cursor. */
  continuations?: readonly TriageActivityContinuationV1[];
  /**
   * The source's re-read of every collection it merged (detail panels never poll). The page's one refresh control
   * runs it, once per press; the Activity draws no refresh of its own.
   */
  refresh?: TriageActivityRefreshV1;
  /** After the stream: what was read, the comment box. */
  footer?: React.ReactNode;
}>;

/** A source's re-read of its Activity; the label names the provider it reads ("Re-read this timeline from GitHub"). */
export type TriageActivityRefreshV1 = Readonly<{
  label: string;
  labelKey?: string;
  /** A read already in flight: the control stays in place and inert rather than vanishing. */
  pending: boolean;
  onRefresh: () => unknown;
}>;

const MARKER_ICON: Readonly<Record<TriageActivityKindV1, IconName>> = Object.freeze({
  comment: 'conversations',
  review: 'review',
  change: 'change-open',
  state: 'change-complete',
  label: 'pin',
  assignment: 'assigned',
  check: 'check',
  escalation: 'escalating',
  session: 'terminal',
  other: 'info',
});

/**
 * One reading order over every collection a source merges: by instant, undated last, and
 * otherwise in the order the source handed them over, so a re-read never reshuffles ties.
 */
export function orderTriageActivityEventsV1(
  events: readonly TriageActivityEventV1[],
): readonly TriageActivityEventV1[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftAt = left.event.atMs ?? Number.POSITIVE_INFINITY;
      const rightAt = right.event.atMs ?? Number.POSITIVE_INFINITY;
      return leftAt === rightAt ? left.index - right.index : leftAt - rightAt;
    })
    .map(({ event }) => event);
}

function ActivityGlyph({ event }: Readonly<{ event: TriageActivityEventV1 }>): React.ReactElement {
  const actor = event.actor ?? null;
  if (event.kind === 'comment' && actor !== null) return <Avatar name={actor} size="small" />;
  // A failing check never draws a tick, whatever its tone.
  const icon = event.kind === 'check' && event.tone === 'danger' ? 'failure' : MARKER_ICON[event.kind];
  return <Icon name={icon} size="small" tone={event.tone ?? 'secondary'} />;
}

function activityEventContent(
  event: TriageActivityEventV1,
  locale: string,
  nowMs: number,
  hostApi: ReturnType<typeof usePluginHostApi>,
): TimelineItemContent {
  const actor = event.actor ?? null;
  const detail = event.detail ?? null;
  const quote = event.quote ?? null;
  const href = event.href ?? null;
  const actions = event.actions ?? null;
  // Opening the event where it happened is a rare reach beside a scanned rail: a quiet glyph, not a word per row.
  const open = href === null
    ? null
    : (
      <IconButton
        icon={<Icon name="external" tone="secondary" />}
        accessibilityLabel={event.hrefLabel ?? event.summary}
        onPress={() => { void hostApi.openExternalLink(href).catch(() => undefined); }}
      />
    );
  return {
    glyph: <ActivityGlyph event={event} />,
    heading: (
      <>
        {actor === null ? null : <Text variant="label">{actor}</Text>}
        {actor === null ? null : ' · '}
        {event.summary}
        {detail === null ? null : ' '}
        {detail === null ? null : <Text variant="reading" tone="secondary">{detail}</Text>}
      </>
    ),
    // The rail's age is one short word that never breaks (lab "2d"); hovering a provider's own page says the rest.
    time: event.atMs === null ? null : (
      <Text variant="micro" tone="muted" accessibilityLabel={formatTriageTimestampV1(locale, event.atMs, 'relative', nowMs)}>
        {formatTriageCompactAgeV1(locale, event.atMs, nowMs)}
      </Text>
    ),
    body: (
      <>
        {quote === null || quote === ''
          ? null
          : <Surface tone="muted" padding="small"><TriageTextPreview>{typeof quote === 'string' ? <Markdown value={quote} /> : quote}</TriageTextPreview></Surface>}
        {event.inset ?? null}
      </>
    ),
    trailing: actions === null ? open : <Row gap="small">{actions}{open}</Row>,
  };
}

/** What the rail draws: the source's events, then the agent's card and what happens next. */
type TriageActivityRailItemV1 =
  | Readonly<{ kind: 'event'; id: string; event: TriageActivityEventV1 }>
  | Readonly<{ kind: 'tail' | 'next'; id: string; node: React.ReactNode }>;

function ContinuationButtons({ continuations }: Readonly<{
  continuations: readonly TriageActivityContinuationV1[];
}>): React.ReactElement | null {
  if (continuations.length === 0) return null;
  // Quiet controls at the rail's edge, not full-width blocks: paging is a rare reach, the events lead.
  return (
    <Row gap="small" align="center" wrap>
      {continuations.map((continuation) => (
        <Button
          key={continuation.key}
          title={continuation.title}
          {...(continuation.titleKey === undefined ? {} : { titleKey: continuation.titleKey })}
          variant="plain"
          size="small"
          busy={continuation.pending}
          onPress={continuation.onLoadMore}
        />
      ))}
    </Row>
  );
}

/**
 * An entry's Activity: one chronological stream for every source.
 *
 * A source maps what its provider recorded — remarks, reviews, pushes, state and label
 * changes — into events and hands them over unsorted; this owner puts them in one reading
 * order and draws each as a marker on a rail, one sentence, an optional quoted remark and
 * the time. The source keeps its reads, cursors and controls; each paged collection keeps
 * its own continuation here.
 */
export function TriageActivityTimeline(props: TriageActivityTimelineProps): React.ReactElement {
  // The entry's Session events (handed over by Triage, when it mounts this detail) read in the same order.
  const agent = useTriageActivityAgent();
  const events = React.useMemo(
    () => orderTriageActivityEventsV1(agent.events.length === 0 ? props.events : [...props.events, ...agent.events]),
    [agent.events, props.events],
  );
  const tail = agent.tail ?? null;
  const next = agent.next ?? null;
  // The agent's card and what happens next stay on the rail after the events (lab c7). With no event to follow,
  // they stand under the source's empty state instead.
  const items = React.useMemo<readonly TriageActivityRailItemV1[]>(() => events.length === 0 ? [] : [
    ...events.map((event) => ({ kind: 'event' as const, id: event.id, event })),
    ...(tail === null ? [] : [{ kind: 'tail' as const, id: 'triage-activity-tail', node: tail }]),
    ...(next === null ? [] : [{ kind: 'next' as const, id: 'triage-activity-next', node: next }]),
  ], [events, next, tail]);
  // The page's one refresh re-reads this Activity: once per press, through the source's own re-read.
  useTriagePageRefresh(props.refresh === undefined ? undefined : props.refresh.onRefresh);
  const hostApi = usePluginHostApi();
  const continuations = props.continuations ?? [];
  const earlier = continuations.filter((continuation) => continuation.reads === 'earlier');
  const later = continuations.filter((continuation) => continuation.reads !== 'earlier');
  const header = earlier.length === 0 ? props.header : (
    <Stack gap="small">
      {props.header}
      <ContinuationButtons continuations={earlier} />
    </Stack>
  );
  return (
    <Timeline
      accessibilityLabel={props.accessibilityLabel}
      {...(props.accessibilityLabelKey === undefined ? {} : { accessibilityLabelKey: props.accessibilityLabelKey })}
      items={items}
      keyForItem={(item) => item.id}
      {...(header === undefined ? {} : { header })}
      // An earlier page is a pure prepend: the row the reader was on stays where it was.
      preserveVisibleContentPositionOnPrepend
      empty={props.empty}
      endContent={later.length === 0 && props.footer === undefined && (items.length > 0 || (tail === null && next === null)) ? undefined : (
        <Stack gap="small" style={{ paddingTop: 8 }}>
          <ContinuationButtons continuations={later} />
          {items.length > 0 ? null : tail}
          {items.length > 0 ? null : next}
          {props.footer}
        </Stack>
      )}
      renderItem={(item) => item.kind === 'event' ? activityEventContent(item.event, props.locale, props.nowMs, hostApi)
        : item.kind === 'tail' ? {
          glyph: <Icon name={MARKER_ICON.session} size="small" tone="secondary" />,
          ...(agent.tailHeading === undefined ? {} : { heading: agent.tailHeading }),
          body: item.node,
        }
        : { glyph: <Icon name="waiting" size="small" tone="muted" />, heading: item.node }}
    />
  );
}
