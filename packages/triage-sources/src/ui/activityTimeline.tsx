import * as React from 'react';
import {
  Action,
  Avatar,
  Button,
  Icon,
  List,
  Markdown,
  Row,
  Stack,
  Surface,
  Text,
  usePluginTheme,
  type IconName,
  type TextTone,
} from '@happier-dev/plugin-ui';
import { formatTriageTimestampV1 } from '@happier-dev/triage-protocol/v1';

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
  /** A remark's own words, quoted under the sentence. */
  quote?: string | null;
  /** Colours the marker: a failing check, a regression, a resolution. */
  tone?: TextTone;
  /** The provider's own page for this event. */
  href?: string | null;
  /** The accessible name of the open control; the source states it in the reader's language. */
  hrefLabel?: string;
  /** Source-owned content under the sentence: a thread's replies and controls, a reveal. */
  inset?: React.ReactNode;
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
  /** After the stream: what was read, a re-read control. */
  footer?: React.ReactNode;
}>;

const MARKER_PX = 24;
const RAIL_PX = 1.5;
const ROW_INSET_PX = 7;
/** Where the rail meets a marker's centre, measured from the row's top. */
const MARKER_CENTER_PX = ROW_INSET_PX + MARKER_PX / 2;
const MARKER_ICON: Readonly<Record<TriageActivityKindV1, IconName>> = Object.freeze({
  comment: 'conversations',
  review: 'review',
  change: 'change-open',
  state: 'change-complete',
  label: 'pin',
  assignment: 'assigned',
  check: 'check',
  escalation: 'escalating',
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

function ActivityMarker({ event }: Readonly<{ event: TriageActivityEventV1 }>): React.ReactElement {
  const theme = usePluginTheme();
  const actor = event.actor ?? null;
  return (
    <Stack
      align="center"
      justify="center"
      style={{
        width: MARKER_PX,
        height: MARKER_PX,
        borderRadius: MARKER_PX / 2,
        backgroundColor: theme.colors.surface,
        borderWidth: RAIL_PX,
        borderColor: theme.colors.divider,
      }}
    >
      {event.kind === 'comment' && actor !== null
        ? <Avatar name={actor} size="small" />
        : <Icon name={MARKER_ICON[event.kind]} size="small" tone={event.tone ?? 'secondary'} />}
    </Stack>
  );
}

function ActivityEventRow({
  event,
  first,
  last,
  locale,
  nowMs,
}: Readonly<{
  event: TriageActivityEventV1;
  first: boolean;
  last: boolean;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const theme = usePluginTheme();
  const actor = event.actor ?? null;
  const detail = event.detail ?? null;
  const quote = event.quote ?? null;
  const href = event.href ?? null;
  return (
    <Row gap="medium" align="flex-start" style={{ paddingVertical: ROW_INSET_PX }}>
      <Stack align="center" style={{ width: MARKER_PX, alignSelf: 'stretch' }}>
        {/* The rail runs through every marker and stops at the first and the last. */}
        {first && last ? null : (
          <Stack
            style={{
              position: 'absolute',
              top: first ? MARKER_CENTER_PX : 0,
              ...(last ? { height: MARKER_CENTER_PX } : { bottom: 0 }),
              left: (MARKER_PX - RAIL_PX) / 2,
              width: RAIL_PX,
              backgroundColor: theme.colors.divider,
            }}
          />
        )}
        <ActivityMarker event={event} />
      </Stack>
      <Stack gap="small" style={{ flex: 1, minWidth: 0, paddingTop: 3 }}>
        <Text variant="reading">
          {actor === null ? null : <Text variant="label">{actor}</Text>}
          {actor === null ? null : ' · '}
          {event.summary}
          {detail === null ? null : ' '}
          {detail === null ? null : <Text variant="reading" tone="secondary">{detail}</Text>}
          {event.atMs === null ? null : '  '}
          {event.atMs === null
            ? null
            : (
              <Text variant="caption" tone="muted">
                {formatTriageTimestampV1(locale, event.atMs, 'relative', nowMs)}
              </Text>
            )}
        </Text>
        {quote === null || quote === ''
          ? null
          : <Surface tone="muted" padding="small"><Markdown value={quote} /></Surface>}
        {event.inset ?? null}
      </Stack>
      {href === null
        ? null
        : (
          <Action.OpenExternal
            url={href}
            variant="plain"
            accessibilityLabel={event.hrefLabel ?? event.summary}
          />
        )}
    </Row>
  );
}

function ContinuationButtons({ continuations }: Readonly<{
  continuations: readonly TriageActivityContinuationV1[];
}>): React.ReactElement {
  return (
    <>
      {continuations.map((continuation) => (
        <Button
          key={continuation.key}
          title={continuation.title}
          {...(continuation.titleKey === undefined ? {} : { titleKey: continuation.titleKey })}
          variant="secondary"
          busy={continuation.pending}
          onPress={continuation.onLoadMore}
        />
      ))}
    </>
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
  const events = React.useMemo(() => orderTriageActivityEventsV1(props.events), [props.events]);
  const continuations = props.continuations ?? [];
  const earlier = continuations.filter((continuation) => continuation.reads === 'earlier');
  const later = continuations.filter((continuation) => continuation.reads !== 'earlier');
  const lastIndex = events.length - 1;
  const header = earlier.length === 0 ? props.header : (
    <Stack gap="small">
      {props.header}
      <ContinuationButtons continuations={earlier} />
    </Stack>
  );
  return (
    <List
      accessibilityLabel={props.accessibilityLabel}
      {...(props.accessibilityLabelKey === undefined ? {} : { accessibilityLabelKey: props.accessibilityLabelKey })}
      items={events}
      keyForItem={(event) => event.id}
      {...(header === undefined ? {} : { header })}
      // An earlier page is a pure prepend: the row the reader was on stays where it was.
      preserveVisibleContentPositionOnPrepend
      empty={props.empty}
      endContent={later.length === 0 && props.footer === undefined ? undefined : (
        <Stack gap="small" style={{ paddingTop: 8 }}>
          <ContinuationButtons continuations={later} />
          {props.footer}
        </Stack>
      )}
      renderItem={(event, index) => (
        <ActivityEventRow
          event={event}
          first={index === 0}
          last={index === lastIndex}
          locale={props.locale}
          nowMs={props.nowMs}
        />
      )}
    />
  );
}
