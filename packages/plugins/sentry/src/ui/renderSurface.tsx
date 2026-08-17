/**
 * The Sentry Triage detail surface artifact entry.
 *
 * Triage mounts this renderer inside its own detail pane and hands it exactly one value: the
 * published `TriageDetailSurfaceInputV1` launch input. This file admits that value through the
 * published closed schema rather than casting it — a mount that hands over something else is a
 * contract break the surface reports, not one it renders around.
 *
 * What it deliberately does **not** render is the common chrome. Title, presentation state,
 * scope, attention, viewer involvement and the linked Happier Sessions belong to the aggregate
 * detail shell, which renders and opens them for every source alike. A second rendering of them
 * here would make this source a second owner of facts it does not own.
 *
 * What it does own are Sentry's own facts: the live issue summary, the tag distribution and its
 * value drill-down, the events Sentry retained in the queried window, the release association,
 * and the recorded activity. Every one of them is a real read with its own lifetime. There is no
 * placeholder tab: an empty tab and an unbuilt tab must not look alike, so a plane this build
 * does not read has no tab at all.
 *
 * Every panel distinguishes the same three settled outcomes, because on this source they are
 * genuinely different answers: a collection the provider stated as empty says so; a first read
 * that failed says *that* instead, naming itself; and a later page that failed keeps the rows the
 * reader already had and shows the failure beside them.
 */

import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Badge,
  Banner,
  Button,
  Divider,
  EmptyState,
  ErrorState,
  Item,
  ItemGroup,
  List,
  LoadingState,
  Metadata,
  Row,
  Screen,
  ScrollArea,
  Stack,
  Status,
  Tabs,
  Text,
  defineUiSurface,
  useSurfaceContext,
  useTabPanelActivity,
  type MetadataEntry,
} from '@happier-dev/plugin-ui';
import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import type {
  SentryProjectedEventRowV1,
  SentryProjectedTagV1,
  SentryProjectedTagValueV1,
} from '../detail/detailProjection.js';
import type {
  SentryEventProjectionV1,
  SentryFrameV1,
} from '../privacy/sentryEventProjection.js';
import { sentryProjectionHasTrace } from '../privacy/sentryEventProjection.js';

import {
  projectSentryDetailOverview,
  type SentryDetailFieldV1,
  type SentryDetailOverviewV1,
} from './detail/model.js';
import {
  useSentryActivityHistory,
  useSentryIssueSummary,
  useSentryOccurrences,
  useSentryTagDistribution,
  useSentryTagValues,
  type SentryActivityHistoryV1,
  type SentryIssueSummaryV1,
  type SentryPagedControllerV1,
  type SentryTagDistributionV1,
} from './detail/panelReaders.js';
import type { SentryReadStateV1 } from './detail/panelState.js';
import {
  useSentrySelectedEvent,
  type SentrySelectedEventControllerV1,
} from './detail/selectedEventController.js';
import {
  SENTRY_DEFAULT_DETAIL_TAB_V1,
  sentryResolveSelectedTab,
  sentryVisibleDetailTabs,
  type SentryDetailTabIdV1,
} from './detail/tabDeclarations.js';

const STATE_TONES = Object.freeze({
  active: 'warning',
  resolved: 'success',
  closed: 'neutral',
  suppressed: 'neutral',
  unknown: 'neutral',
} as const);

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = Object.freeze([
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
] as const);

/**
 * `relative` is relative to the reader's present, which is what a triage reader means by "last
 * seen 4 minutes ago". `nowMs` is passed in rather than read here so the value is a render input
 * and not a hidden clock read.
 */
function formatTimestamp(
  locale: string,
  atMs: number,
  format: 'relative' | 'absolute',
  nowMs: number,
): string {
  if (format === 'absolute') {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
      .format(new Date(atMs));
  }
  const deltaMs = atMs - nowMs;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (Math.abs(deltaMs) >= unitMs) return relative.format(Math.round(deltaMs / unitMs), unit);
  }
  return relative.format(Math.round(deltaMs / 1000), 'second');
}

function formatNumber(locale: string, value: number, format: 'compact' | 'plain'): string {
  return new Intl.NumberFormat(
    locale,
    format === 'compact' ? { notation: 'compact', maximumFractionDigits: 1 } : {},
  ).format(value);
}

function fieldValueText(
  field: SentryDetailFieldV1,
  locale: string,
  nowMs: number,
): string | null {
  switch (field.kind) {
    case 'text':
    case 'status':
      return field.value;
    case 'number': {
      const formatted = formatNumber(locale, field.value, field.format);
      // A Sentry count is measured over the project's retention window. Presenting it as a bare
      // total would state a lifetime figure the provider never promised.
      return field.approximate ? `~${formatted}` : formatted;
    }
    case 'timestamp':
      return formatTimestamp(locale, field.atMs, field.format, nowMs);
    case 'pending':
      return null;
    default:
      return null;
  }
}

/** The one sentence every failed read owes its reader, without echoing a provider body. */
function failureDescription(failure: TriageSourceFailureV1 | null, fallback: string): string {
  return failure === null ? fallback : `${fallback} (${failure.code})`;
}

/* ------------------------------------------------------- selected occurrence */

/**
 * The word this surface may use for the current selection.
 *
 * Sentry's own selector is `recommended`, and the one thing this must never say is
 * "latest": `recommended` is a provider heuristic, and calling it the newest event
 * would make a reader draw a conclusion about *when* from a fact that is about
 * *which* (`SENTRY.md` §7.3).
 */
function selectionLabel(controller: SentrySelectedEventControllerV1): string {
  return controller.selected.kind === 'representative'
    ? 'Sentry’s recommended occurrence'
    : 'the selected occurrence';
}

/**
 * The frame a reader opens a trace for.
 *
 * Sentry returns a stack oldest-first, so the innermost application frame is the
 * **last** `inApp` one, not the first. A stack with no application frame at all falls
 * back to its innermost frame rather than showing nothing.
 */
function innermostAppFrame(
  projection: SentryEventProjectionV1,
): SentryFrameV1 | undefined {
  for (let index = projection.sections.length - 1; index >= 0; index -= 1) {
    const section = projection.sections[index];
    if (section === undefined) continue;
    if (section.kind !== 'exception' && section.kind !== 'stacktrace') continue;
    const { frames } = section;
    for (let position = frames.length - 1; position >= 0; position -= 1) {
      const frame = frames[position];
      if (frame?.inApp === true) return frame;
    }
    return frames.at(-1);
  }
  return undefined;
}

function frameLabel(frame: SentryFrameV1): string {
  const where = frame.filename ?? 'unknown file';
  const line = frame.lineNo === null ? '' : `:${String(frame.lineNo)}`;
  return frame.function === null ? `${where}${line}` : `${frame.function} — ${where}${line}`;
}

function firstException(
  projection: SentryEventProjectionV1,
): Readonly<{ type: string; value: string }> | null {
  for (const section of projection.sections) {
    if (section.kind === 'exception') return { type: section.type, value: section.value };
  }
  return null;
}

/**
 * Overview's inline summary of the one selected occurrence.
 *
 * It is where the controller's single read is demanded: the event body is fetched
 * because a mounted consumer asked for it, never because the detail opened. A failure
 * here stays inside this region — the header, the facts and the Tags section below it
 * are unaffected, because a failed event read is not a failed detail.
 */
function SelectedOccurrenceSummary({
  controller,
  locale,
  nowMs,
  onOpenStackTrace,
}: Readonly<{
  controller: SentrySelectedEventControllerV1;
  locale: string;
  nowMs: number;
  onOpenStackTrace: () => void;
}>): React.ReactElement {
  const { demand, read } = controller;
  // The demand is renewed whenever the controller is idle again — on mount, after the
  // exact entry or instance changed, and after a selection replaced the projection this
  // region was showing. It is not renewed after a failure, because a settled failure is
  // an answer and re-demanding it would be a retry loop nobody asked for.
  const readKind = read.kind;
  React.useEffect(() => {
    if (readKind === 'idle') demand();
  }, [demand, readKind]);

  if (read.kind === 'idle' || read.kind === 'loading') {
    return <LoadingState title="Reading one occurrence of this issue" />;
  }
  if (read.kind === 'error') {
    return (
      <ErrorState
        title="This occurrence could not be read"
        description={failureDescription(
          read.failure,
          'Sentry did not return an occurrence of this issue.',
        )}
      />
    );
  }

  const { projection } = read;
  const exception = firstException(projection);
  const frame = innermostAppFrame(projection);
  const when = projection.dateCreatedMs === null
    ? null
    : formatTimestamp(locale, projection.dateCreatedMs, 'absolute', nowMs);

  return (
    <Stack gap="small">
      <Text variant="caption" tone="neutral">
        {when === null
          ? `Showing ${selectionLabel(controller)}.`
          : `Showing ${selectionLabel(controller)}, recorded ${when}.`}
      </Text>
      {exception === null
        ? <Text variant="body">{projection.message === '' ? projection.title : projection.message}</Text>
        : (
          <Stack gap="small">
            <Text variant="body">{`${exception.type}: ${exception.value}`}</Text>
            {frame === undefined
              ? null
              : <Text variant="caption" tone="neutral">{frameLabel(frame)}</Text>}
          </Stack>
        )}
      {!sentryProjectionHasTrace(projection)
        ? null
        : (
          <Button
            title="Open the stack trace"
            variant="secondary"
            onPress={onOpenStackTrace}
          />
        )}
      <Button
        title="Reread this occurrence"
        variant="plain"
        onPress={controller.refresh}
      />
    </Stack>
  );
}

/**
 * The redaction disclosure every Tier-B/C region owes its reader.
 *
 * It is built from the projection's own two arrays rather than from a boolean, so it
 * names what was withheld instead of implying a completeness the projection never had
 * (`SENTRY.md` §8.2, §8.4).
 */
function RedactionNotice({
  projection,
}: Readonly<{ projection: SentryEventProjectionV1 }>): React.ReactElement | null {
  const scrubbed = projection.redactions.filter(
    (redaction) => redaction.reason === 'providerScrubbed',
  ).length;
  if (scrubbed === 0 && !projection.projectionTruncated) return null;
  return (
    <Banner
      tone="neutral"
      title={scrubbed === 0 ? 'Some content was shortened' : 'Sentry redacted some values'}
      description={scrubbed === 0
        ? 'Open the occurrence in Sentry to read the complete text.'
        : `${String(scrubbed)} value(s) were already scrubbed by this organization’s own Sentry rules.`}
    />
  );
}

/* --------------------------------------------------------------------- Overview */

function LiveSummary({
  summary,
  locale,
  nowMs,
}: Readonly<{
  summary: SentryReadStateV1<SentryIssueSummaryV1>;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  if (summary.kind === 'loading') {
    return <LoadingState title="Reading this issue from Sentry" />;
  }
  if (summary.kind === 'unavailable') {
    return (
      <Banner
        tone="warning"
        title="Showing the last observation"
        description={failureDescription(
          summary.failure,
          'Sentry could not be read just now, so these facts are the ones this issue was last observed with.',
        )}
      />
    );
  }

  const { value } = summary;
  const entries: readonly MetadataEntry[] = [
    ...(value.eventCount === undefined
      ? []
      : [{ label: 'Events', value: `~${value.eventCount}` }]),
    ...(value.userCount === undefined
      ? []
      : [{ label: 'Users', value: `~${formatNumber(locale, value.userCount, 'compact')}` }]),
    ...(value.firstSeenAtMs === undefined
      ? []
      : [{
        label: 'First seen',
        value: formatTimestamp(locale, value.firstSeenAtMs, 'relative', nowMs),
      }]),
    ...(value.lastSeenAtMs === undefined
      ? []
      : [{
        label: 'Last seen',
        value: formatTimestamp(locale, value.lastSeenAtMs, 'relative', nowMs),
      }]),
  ];

  return (
    <Stack gap="small">
      <Row gap="small">
        <Status
          tone={STATE_TONES[value.statePresentation]}
          label={value.nativeStateLabel ?? value.statePresentation}
        />
      </Row>
      {entries.length === 0
        ? null
        : <Metadata title="Sentry now" entries={entries} />}
      <Text variant="caption" tone="neutral">
        {'Sentry counts what it retained for this project’s window, never every occurrence.'}
      </Text>
    </Stack>
  );
}

function tagSubtitle(tag: SentryProjectedTagV1): string | undefined {
  const top = tag.topValues[0];
  if (top === undefined) return undefined;
  return top.count === undefined ? top.value : `${top.value} · ${String(top.count)}`;
}

/**
 * The value distribution of one tag key.
 *
 * It is the only nested walk in the body, and it lives inside the Overview panel: leaving
 * Overview ends its active interval, which aborts the page and discards every value it read.
 */
function TagValuesSection({
  input,
  tagKey,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  tagKey: string;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const controller = useSentryTagValues(input, tagKey);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title={`Reading ${tagKey} values`} />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title={`${tagKey} values are unavailable`}
        description={failureDescription(state.failure, 'Sentry did not return this distribution.')}
      />
    );
  }
  if (state.rows.length === 0) {
    return (
      <EmptyState
        title={`No ${tagKey} values`}
        description="Sentry recorded no values for this tag on this issue."
      />
    );
  }

  return (
    <Stack gap="small">
      {state.failure === null
        ? null
        : (
          <Banner
            tone="warning"
            title="Showing the values read so far"
            description={failureDescription(state.failure, 'The next page could not be read.')}
          />
        )}
      <ItemGroup accessibilityLabel={`Values of ${tagKey} on this Sentry issue`}>
        {state.rows.map((row: SentryProjectedTagValueV1) => (
          <Item
            key={row.value}
            title={row.value}
            {...(row.count === undefined
              ? {}
              : { subtitle: `${formatNumber(locale, row.count, 'compact')} event(s)` })}
            {...(row.lastSeenAtMs === undefined
              ? {}
              : { detail: formatTimestamp(locale, row.lastSeenAtMs, 'relative', nowMs) })}
          />
        ))}
      </ItemGroup>
      <Text variant="caption" tone="neutral">
        {`${String(state.rows.length)} value(s) read.`}
      </Text>
      {state.canLoadMore
        ? (
          <Button
            title="Load more values"
            variant="secondary"
            busy={state.pending}
            onPress={controller.loadMore}
          />
        )
        : null}
    </Stack>
  );
}

function TagsSection({
  input,
  distribution,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  distribution: SentryReadStateV1<SentryTagDistributionV1>;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const [openKey, setOpenKey] = React.useState<string | null>(null);

  if (distribution.kind === 'loading') {
    return <LoadingState title="Reading this issue’s tags" />;
  }
  if (distribution.kind === 'unavailable') {
    return (
      <ErrorState
        title="Tags are unavailable"
        description={failureDescription(
          distribution.failure,
          'Sentry did not return this issue’s tag distribution.',
        )}
      />
    );
  }
  if (distribution.value.tags.length === 0) {
    // A hidden section and an absent one are indistinguishable to a returning
    // reader, so an issue with no tags says so rather than rendering nothing.
    return (
      <EmptyState
        title="No tags on this issue"
        description="Sentry recorded no tag distribution for this issue."
      />
    );
  }

  return (
    <Stack gap="small">
      <Text variant="caption" tone="neutral">
        {'Tag values come from the events Sentry retained. Opening one reads its distribution.'}
      </Text>
      <ItemGroup accessibilityLabel="Tags on this Sentry issue">
        {distribution.value.tags.map((tag) => (
          <Item
            key={tag.key}
            title={tag.name ?? tag.key}
            {...(tagSubtitle(tag) === undefined ? {} : { subtitle: tagSubtitle(tag) ?? '' })}
            {...(tag.totalValues === undefined
              ? {}
              : { detail: `${formatNumber(locale, tag.totalValues, 'compact')} value(s)` })}
            accessibilityRole="button"
            accessibilityExpanded={openKey === tag.key}
            selected={openKey === tag.key}
            onPress={() => {
              setOpenKey((current) => (current === tag.key ? null : tag.key));
            }}
          />
        ))}
      </ItemGroup>
      {openKey === null
        ? null
        : <TagValuesSection input={input} tagKey={openKey} locale={locale} nowMs={nowMs} />}
      {distribution.value.omittedTagCount === 0
        ? null
        : (
          <Text variant="caption" tone="neutral">
            {`${String(distribution.value.omittedTagCount)} tag(s) on this issue could not be read.`}
          </Text>
        )}
    </Stack>
  );
}

function OverviewPanel({
  input,
  overview,
  summary,
  selectedEvent,
  locale,
  nowMs,
  onOpenStackTrace,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  overview: SentryDetailOverviewV1;
  summary: SentryReadStateV1<SentryIssueSummaryV1>;
  selectedEvent: SentrySelectedEventControllerV1;
  locale: string;
  nowMs: number;
  onOpenStackTrace: () => void;
}>): React.ReactElement {
  // The tag distribution is Tier B and belongs to this panel alone, so it is read here rather
  // than at the detail root: leaving Overview discards every value it held.
  const distribution = useSentryTagDistribution(input);

  const statusFields = overview.fields.filter(
    (field): field is Extract<SentryDetailFieldV1, { kind: 'status' }> => field.kind === 'status',
  );
  const pendingFields = overview.fields.filter((field) => field.kind === 'pending');
  const entries: readonly MetadataEntry[] = overview.fields.flatMap((field) => {
    if (field.kind === 'pending' || field.kind === 'status') return [];
    const value = fieldValueText(field, locale, nowMs);
    return value === null ? [] : [{ label: field.label, value }];
  });

  return (
    <ScrollArea>
      <Stack gap="large">
        {overview.summary === null ? null : <Text variant="body">{overview.summary}</Text>}
        <LiveSummary summary={summary} locale={locale} nowMs={nowMs} />
        {statusFields.length === 0 ? null : (
          <Row gap="small">
            {statusFields.map((field) => (
              <Status key={field.id} tone={field.tone} label={`${field.label}: ${field.value}`} />
            ))}
          </Row>
        )}
        {entries.length === 0
          ? (
            <EmptyState
              title="No projected facts"
              description="This observation carried no displayable facts."
            />
          )
          : <Metadata title="Facts" entries={entries} />}
        {pendingFields.length === 0 ? null : (
          <Stack gap="small">
            <Text variant="caption" tone="neutral">
              {'Read only in this detail body:'}
            </Text>
            <Row gap="small">
              {pendingFields.map((field) => <Badge key={field.id} value={field.label} />)}
            </Row>
          </Stack>
        )}
        {!overview.projectionTruncated ? null : (
          <Banner
            tone="neutral"
            title="Some details were shortened"
            description="Open the issue in Sentry to read the complete text."
          />
        )}
        <Divider />
        <SelectedOccurrenceSummary
          controller={selectedEvent}
          locale={locale}
          nowMs={nowMs}
          onOpenStackTrace={onOpenStackTrace}
        />
        <Divider />
        <TagsSection input={input} distribution={distribution} locale={locale} nowMs={nowMs} />
        <Divider />
        <Metadata
          title="Observation"
          entries={[
            {
              label: 'Observed',
              value: formatTimestamp(locale, overview.observedAtMs, 'relative', nowMs),
            },
            ...(overview.sourceUpdatedAtMs === null
              ? []
              : [{
                label: 'Sentry last changed',
                value: formatTimestamp(locale, overview.sourceUpdatedAtMs, 'relative', nowMs),
              }]),
          ]}
        />
      </Stack>
    </ScrollArea>
  );
}

/* ----------------------------------------------------------------- Occurrences */

/** The one sentence this list owes its reader, every time it is shown. */
const RETENTION_DISCLOSURE
  = 'These are the events Sentry retained in the queried window, not every occurrence.';

function OccurrencesFooter({
  controller,
}: Readonly<{
  controller: SentryPagedControllerV1<SentryProjectedEventRowV1>;
}>): React.ReactElement {
  const { state } = controller;
  return (
    <Stack gap="small">
      <Text variant="caption" tone="neutral">
        {state.omittedRowCount === 0
          ? `${String(state.rows.length)} retained event(s) read.`
          : `${String(state.rows.length)} retained event(s) read. ${String(state.omittedRowCount)} row(s) on the pages read could not be understood.`}
      </Text>
      {state.canLoadMore
        ? (
          <Button
            title="Load more retained events"
            variant="secondary"
            busy={state.pending}
            onPress={controller.loadMore}
          />
        )
        : null}
    </Stack>
  );
}

/**
 * The detail of the one occurrence a reader activated.
 *
 * It renders the detail-root controller's projection and starts no read of its own. The
 * event's own tags are that event's facts and are never merged into the issue-level
 * distribution Overview shows; the user fields stay behind an explicit reveal, which
 * changes only this local boolean and never rereads anything.
 *
 * Leaving the panel clears the reveal. Occurrences declares `retain`, so its subtree
 * survives a tab leave — which is exactly why the disclosure booleans must be reset
 * against the panel's own active interval rather than left to an unmount that will not
 * happen (`SENTRY.md` §7.2b).
 */
function ActivatedOccurrenceDetail({
  controller,
}: Readonly<{ controller: SentrySelectedEventControllerV1 }>): React.ReactElement | null {
  const [revealUser, setRevealUser] = React.useState(false);
  const { active } = useTabPanelActivity();
  const { read, selected } = controller;

  React.useEffect(() => {
    if (!active) setRevealUser(false);
  }, [active]);
  React.useEffect(() => {
    setRevealUser(false);
  }, [selected]);

  if (selected.kind !== 'event') return null;
  if (read.kind === 'idle' || read.kind === 'loading') {
    return <LoadingState title="Reading this occurrence" />;
  }
  if (read.kind === 'error') {
    return (
      <ErrorState
        title="This occurrence could not be read"
        description={failureDescription(read.failure, 'Sentry did not return this event.')}
      />
    );
  }

  const { projection } = read;
  const user = projection.user;
  const userEntries: readonly MetadataEntry[] = user === null
    ? []
    : [
      ...(user.id === null ? [] : [{ label: 'Id', value: user.id }]),
      ...(user.name === null ? [] : [{ label: 'Name', value: user.name }]),
      ...(user.username === null ? [] : [{ label: 'Username', value: user.username }]),
      ...(user.email === null ? [] : [{ label: 'Email', value: user.email }]),
      ...(user.ipAddress === null ? [] : [{ label: 'IP address', value: user.ipAddress }]),
    ];

  return (
    <Stack gap="small">
      <Divider />
      <Text variant="label">{projection.title === '' ? 'Selected occurrence' : projection.title}</Text>
      <RedactionNotice projection={projection} />
      {projection.tags.length === 0
        ? null
        : (
          <Metadata
            title="This event’s tags"
            entries={projection.tags.map((tag) => ({ label: tag.key, value: tag.value }))}
          />
        )}
      {userEntries.length === 0
        ? null
        : (
          <Stack gap="small">
            <Button
              title={revealUser ? 'Hide event user details' : 'Show event user details'}
              variant="secondary"
              onPress={() => {
                setRevealUser((current) => !current);
              }}
            />
            {revealUser ? <Metadata title="Event user" entries={userEntries} /> : null}
          </Stack>
        )}
      <Divider />
    </Stack>
  );
}

function OccurrencesPanel({
  input,
  locale,
  nowMs,
  selectedEvent,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
  selectedEvent: SentrySelectedEventControllerV1;
}>): React.ReactElement {
  const controller = useSentryOccurrences(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading retained events" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="Retained events are unavailable"
        description={failureDescription(state.failure, 'Sentry did not return this collection.')}
      />
    );
  }

  return (
    <List
      accessibilityLabel="Events Sentry retained for this issue"
      items={state.rows}
      keyForItem={(row) => row.eventId}
      header={(
        <Stack gap="small">
          <Text variant="caption" tone="neutral">{RETENTION_DISCLOSURE}</Text>
          {state.failure === null
            ? null
            : (
              <Banner
                tone="warning"
                title="Showing the events read so far"
                description={failureDescription(state.failure, 'The next page could not be read.')}
              />
            )}
          <ActivatedOccurrenceDetail controller={selectedEvent} />
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No retained events"
          description={RETENTION_DISCLOSURE}
        />
      )}
      footer={<OccurrencesFooter controller={controller} />}
      renderItem={(row) => (
        <Item
          title={row.headline}
          {...(row.location === undefined ? {} : { subtitle: row.location })}
          {...(row.atMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.atMs, 'relative', nowMs) })}
          accessibilityRole="button"
          selected={selectedEvent.selected.kind === 'event'
            && selectedEvent.selected.eventId === row.eventId}
          onPress={() => {
            // Activation is the ONLY writer of the shared selection. Refresh, tab
            // switch and scroll never move it, and the event body is read because
            // this row was chosen rather than because the list rendered.
            selectedEvent.select({ kind: 'event', eventId: row.eventId });
            selectedEvent.demand();
          }}
        />
      )}
    />
  );
}

/* ------------------------------------------------------------------ Stack Trace */

function FrameList({
  frames,
  showSystemFrames,
}: Readonly<{
  frames: readonly SentryFrameV1[];
  showSystemFrames: boolean;
}>): React.ReactElement {
  const shown = showSystemFrames ? frames : frames.filter((frame) => frame.inApp);
  if (shown.length === 0) {
    return (
      <EmptyState
        title="No application frames"
        description="Every frame in this section came from outside your own code."
      />
    );
  }
  return (
    <ItemGroup accessibilityLabel="Frames in this section, in the order Sentry recorded them">
      {shown.map((frame, index) => (
        <Item
          key={`${String(index)}:${frame.filename ?? ''}:${String(frame.lineNo ?? 0)}`}
          title={frameLabel(frame)}
          {...(frame.contextLine === null ? {} : { subtitle: frame.contextLine })}
          {...(frame.inApp ? {} : { detail: 'system' })}
        />
      ))}
    </ItemGroup>
  );
}

/**
 * The full trace of the one selected occurrence.
 *
 * It performs no read: the projection it renders is the detail-root controller's, the
 * same one Overview summarized, so opening this tab costs nothing and leaving it takes
 * nothing away. The tab is present only while that projection carries a trace, so this
 * body never renders an "unavailable" state for a tab whose absence already said so.
 */
function StackTracePanel({
  controller,
  locale,
  nowMs,
}: Readonly<{
  controller: SentrySelectedEventControllerV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const [showSystemFrames, setShowSystemFrames] = React.useState(false);
  const { read } = controller;

  if (read.kind !== 'success') {
    // Reachable only in the instant between a refresh starting and settling: the
    // tab's own condition is derived from a successful projection.
    return <LoadingState title="Reading this occurrence" />;
  }

  const { projection } = read;
  const traceSections = projection.sections.filter(
    (section) => section.kind === 'exception' || section.kind === 'stacktrace',
  );
  const breadcrumbs = projection.sections.filter((section) => section.kind === 'breadcrumbs');
  const messages = projection.sections.filter((section) => section.kind === 'message');
  const when = projection.dateCreatedMs === null
    ? null
    : formatTimestamp(locale, projection.dateCreatedMs, 'absolute', nowMs);

  return (
    <ScrollArea>
      <Stack gap="large">
        <Text variant="caption" tone="neutral">
          {when === null
            ? `This is ${selectionLabel(controller)}.`
            : `This is ${selectionLabel(controller)}, recorded ${when}.`}
        </Text>
        <RedactionNotice projection={projection} />
        <Row gap="small">
          <Button
            title={showSystemFrames ? 'Hide system frames' : 'Show system frames'}
            variant="secondary"
            onPress={() => {
              setShowSystemFrames((current) => !current);
            }}
          />
        </Row>
        {traceSections.map((section, index) => (
          <Stack key={`${section.kind}:${String(index)}`} gap="small">
            {section.kind !== 'exception'
              ? null
              : <Text variant="body">{`${section.type}: ${section.value}`}</Text>}
            <FrameList frames={section.frames} showSystemFrames={showSystemFrames} />
          </Stack>
        ))}
        {projection.omitted.frames === 0
          ? null
          : (
            <Text variant="caption" tone="neutral">
              {`${String(projection.omitted.frames)} outer frame(s) are not shown. The frames nearest the failure are kept.`}
            </Text>
          )}
        {breadcrumbs.map((section, index) => (
          <Stack key={`breadcrumbs:${String(index)}`} gap="small">
            <Text variant="label">Breadcrumbs</Text>
            <ItemGroup accessibilityLabel="Breadcrumbs Sentry recorded before this occurrence">
              {section.kind !== 'breadcrumbs' ? null : section.entries.map((crumb, crumbIndex) => (
                <Item
                  key={`${String(crumbIndex)}:${crumb.category ?? ''}`}
                  title={crumb.message ?? crumb.category ?? 'breadcrumb'}
                  {...(crumb.level === null ? {} : { subtitle: crumb.level })}
                  {...(crumb.timestampMs === null
                    ? {}
                    : { detail: formatTimestamp(locale, crumb.timestampMs, 'relative', nowMs) })}
                />
              ))}
            </ItemGroup>
          </Stack>
        ))}
        {messages.map((section, index) => (
          section.kind !== 'message'
            ? null
            : <Text key={`message:${String(index)}`} variant="body">{section.formatted}</Text>
        ))}
      </Stack>
    </ScrollArea>
  );
}

/* ---------------------------------------------------------- Release association */

function ReleasePanel({
  summary,
  locale,
  nowMs,
}: Readonly<{
  summary: SentryIssueSummaryV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const rows = [
    ...(summary.firstRelease === undefined
      ? []
      : [{ label: 'First seen in', release: summary.firstRelease }]),
    ...(summary.lastRelease === undefined
      ? []
      : [{ label: 'Last seen in', release: summary.lastRelease }]),
  ];

  return (
    <ScrollArea>
      <Stack gap="large">
        <Text variant="caption" tone="neutral">
          {'Sentry states these releases on the issue itself; nothing here is inferred from a deploy history.'}
        </Text>
        <ItemGroup accessibilityLabel="Releases this Sentry issue is associated with">
          {rows.map((row) => {
            // Either date may be absent from the untyped field; a release with
            // neither keeps its version and loses only its date.
            const atMs = row.release.dateReleasedAtMs ?? row.release.dateCreatedAtMs ?? null;
            return (
              <Item
                key={row.label}
                title={row.release.version}
                subtitle={row.label}
                {...(atMs === null
                  ? {}
                  : { detail: formatTimestamp(locale, atMs, 'absolute', nowMs) })}
              />
            );
          })}
        </ItemGroup>
      </Stack>
    </ScrollArea>
  );
}

/* -------------------------------------------------------------------- Activity */

function activityHeadline(item: Readonly<{ type: string; actor?: string }>): string {
  return item.actor === undefined ? item.type : `${item.type} · ${item.actor}`;
}

function ActivityBody({
  history,
  locale,
  nowMs,
}: Readonly<{
  history: SentryActivityHistoryV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  if (history.status === 'unavailable') {
    // A malformed `activity` field is not an issue with no history, and the two
    // must never render the same.
    return (
      <ErrorState
        title="Activity could not be read"
        description="Sentry returned an activity history this build does not understand."
      />
    );
  }

  return (
    <List
      accessibilityLabel="Recorded activity for this Sentry issue"
      items={history.items}
      keyForItem={(item) => item.id}
      empty={(
        <EmptyState
          title="No recorded activity"
          description="Sentry has recorded no changes to this issue."
        />
      )}
      footer={(
        <Stack gap="small">
          <Text variant="caption" tone="neutral">
            {`${String(history.items.length)} activity record(s) read. Sentry states this history on the issue itself and does not paginate it.`}
          </Text>
          {history.malformedItemCount + history.omittedItemCount === 0
            ? null
            : (
              <Text variant="caption" tone="neutral">
                {`${String(history.malformedItemCount + history.omittedItemCount)} record(s) could not be shown.`}
              </Text>
            )}
        </Stack>
      )}
      renderItem={(item) => (
        <Item
          title={activityHeadline(item)}
          {...(item.atMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, item.atMs, 'relative', nowMs) })}
        />
      )}
    />
  );
}

function ActivityPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const history = useSentryActivityHistory(input);

  if (history.kind === 'loading') {
    return <LoadingState title="Reading this issue’s activity" />;
  }
  if (history.kind === 'unavailable') {
    return (
      <ErrorState
        title="Activity is unavailable"
        description={failureDescription(
          history.failure,
          'Sentry did not return this issue’s activity.',
        )}
      />
    );
  }
  return <ActivityBody history={history.value} locale={locale} nowMs={nowMs} />;
}

/* ------------------------------------------------------------------ detail body */

function SentryDetailBody({
  input,
  signal,
}: Readonly<{ input: TriageDetailSurfaceInputV1; signal: AbortSignal }>): React.ReactElement {
  const { locale } = useSurfaceContext();
  const [selected, setSelected] = React.useState<SentryDetailTabIdV1>(
    SENTRY_DEFAULT_DETAIL_TAB_V1,
  );
  // One render-time read, passed down as data, so no child owns a hidden clock.
  const nowMs = Date.now();

  // The one Tier-A read the detail root owns. The Release association tab's very presence
  // depends on it, and a conditional tab cannot read its own condition from inside its panel.
  const summary = useSentryIssueSummary(input, signal);
  // The one selected-event owner. It lives here, above the tabs, because Overview, an
  // activated occurrence and Stack Trace are three consumers of one projection — and
  // because the exact detail instance, not a tab mount, is where an event body's
  // lifetime ends.
  const selectedEvent = useSentrySelectedEvent(input, signal);
  const overview = React.useMemo(() => projectSentryDetailOverview(input), [input]);

  const releaseSummary = summary.kind === 'ready' ? summary.value : null;
  const hasReleaseAssociation = releaseSummary !== null
    && (releaseSummary.firstRelease !== undefined || releaseSummary.lastRelease !== undefined);
  const hasTraceEvidence = selectedEvent.read.kind === 'success'
    && sentryProjectionHasTrace(selectedEvent.read.projection);
  const visible = sentryVisibleDetailTabs({ hasReleaseAssociation, hasTraceEvidence });
  const tab = sentryResolveSelectedTab(selected, visible);

  const panels: Readonly<Record<SentryDetailTabIdV1, React.ReactNode>> = {
    overview: (
      <OverviewPanel
        input={input}
        overview={overview}
        summary={summary}
        selectedEvent={selectedEvent}
        locale={locale}
        nowMs={nowMs}
        onOpenStackTrace={() => {
          setSelected('stack-trace');
        }}
      />
    ),
    occurrences: (
      <OccurrencesPanel
        input={input}
        locale={locale}
        nowMs={nowMs}
        selectedEvent={selectedEvent}
      />
    ),
    'stack-trace': (
      <StackTracePanel controller={selectedEvent} locale={locale} nowMs={nowMs} />
    ),
    release: releaseSummary === null
      ? null
      : <ReleasePanel summary={releaseSummary} locale={locale} nowMs={nowMs} />,
    activity: <ActivityPanel input={input} locale={locale} nowMs={nowMs} />,
  };

  return (
    <Screen safeArea>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          // The visible declarations are the only tab identities this body renders, so a value
          // that is not one of them selects nothing rather than becoming a tab id by assertion.
          const declared = visible.find((candidate) => candidate.id === next);
          if (declared !== undefined) setSelected(declared.id);
        }}
        ariaLabel="Sentry issue detail sections"
      >
        {visible.map((declaration) => (
          <Tabs.Item
            key={declaration.id}
            value={declaration.id}
            title={declaration.title}
            // Stated, never inherited: the shared primitive would otherwise discard a panel
            // this source means to keep, or keep one it means to discard.
            retention={declaration.retention}
          >
            {panels[declaration.id]}
          </Tabs.Item>
        ))}
      </Tabs>
    </Screen>
  );
}

function SentryDetailSurface(context: RenderContext): React.ReactElement {
  const admitted = React.useMemo(() => {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
    return parsed.success
      ? { ok: true as const, input: parsed.data }
      : { ok: false as const };
  }, [context.launchInput]);

  if (!admitted.ok) {
    return (
      <Screen safeArea>
        <ErrorState
          title="This issue cannot be shown"
          description="Triage supplied a detail input this Sentry build does not accept."
        />
      </Screen>
    );
  }

  return <SentryDetailBody input={admitted.input} signal={context.signal} />;
}

/**
 * The exact export name the build target's Module Federation identity names. Renaming it breaks
 * the native artifact contract, not just this file.
 */
export const renderSurface = defineUiSurface(SentryDetailSurface);
