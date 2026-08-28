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
  usePluginTranslation,
  useSurfaceContext,
  useTabPanelActivity,
  type MetadataEntry,
} from '@happier-dev/plugin-ui';
import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
// The presentation rules used below are projections of the Triage contract's own
// closed fact and failure vocabularies, so they are consumed from the one published
// owner rather than re-spelled here: six copies is how one declared `compact` number
// could start meaning two things in one list. They are aliased to this file's local
// vocabulary so the call sites read as the panel language they already are.
import {
  describeTriageSourceFailureV1 as failureDescription,
  formatTriageCountV1 as formatNumber,
  formatTriageTimestampV1 as formatTimestamp,
  projectTriageDetailFieldTextV1 as fieldValueText,
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
import type {
  SentryDetailIncompleteReasonV1,
  SentryReadStateV1,
} from './detail/panelState.js';
import {
  useSentrySelectedEvent,
  type SentrySelectedEventControllerV1,
  type SentrySelectedEventReadV1,
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
  const text = usePluginTranslation();
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
    return <LoadingState title="Reading one occurrence of this issue" titleKey="plugins.sentry.ui.readingOccurrence" />;
  }
  if (read.kind === 'error') {
    return (
      <ErrorState
        title="This occurrence could not be read"
        titleKey="plugins.sentry.ui.occurrenceUnavailable"
        description={failureDescription(
          read.failure,
          text('plugins.sentry.ui.readFailed', 'Sentry could not complete this read.'),
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
      <Text
        variant="caption"
        tone="neutral"
        valueKey={when === null
          ? 'plugins.sentry.ui.showingSelection'
          : 'plugins.sentry.ui.showingSelectionRecorded'}
        fallback={when === null
          ? 'Showing {selection}.'
          : 'Showing {selection}, recorded {when}.'}
        values={{ selection: selectionLabel(controller), when: when ?? '' }}
      />
      <SelectedEventRefreshNotice read={read} />
      {/*
        * Overview is the default tab and renders the exception value and the
        * innermost app frame below, so it owes its reader the same disclosure
        * the other two Tier-B/C regions already carry (`SENTRY.md` §8.2). It
        * sits ABOVE the values it qualifies: a notice under them has already
        * let the reader take a scrubbed value at face value.
        */}
      <RedactionNotice projection={projection} />
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
            titleKey="plugins.sentry.ui.openStack"
            variant="secondary"
            onPress={onOpenStackTrace}
          />
        )}
      <Button
        title="Reread this occurrence"
        titleKey="plugins.sentry.ui.rereadOccurrence"
        variant="plain"
        onPress={controller.refresh}
      />
    </Stack>
  );
}

/**
 * Honest last-known-good state for a same-selection refresh.
 *
 * The controller, not this renderer, decides whether a projection is safe to
 * retain. A selection or detail-identity change clears it synchronously; only
 * refreshing the exact same occurrence can reach this inline notice.
 */
function SelectedEventRefreshNotice({
  read,
}: Readonly<{ read: SentrySelectedEventReadV1 }>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (read.kind !== 'success' || read.refresh === null) return null;
  return (
    <Banner
      tone={read.refresh.kind === 'loading' ? 'neutral' : 'warning'}
      title={read.refresh.kind === 'loading'
        ? text('plugins.sentry.ui.readingOccurrence', 'Reading one occurrence of this issue')
        : text('plugins.sentry.ui.lastObservation', 'Showing the last observation')}
      description={read.refresh.kind === 'loading'
        ? text('plugins.sentry.ui.lastObservation', 'Showing the last observation')
        : failureDescription(
            read.refresh.failure,
            text('plugins.sentry.ui.readFailed', 'Sentry could not complete this read.'),
          )}
    />
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
  const text = usePluginTranslation();
  const scrubbed = projection.redactions.filter(
    (redaction) => redaction.reason === 'providerScrubbed',
  ).length;
  if (scrubbed === 0 && !projection.projectionTruncated) return null;
  return (
    <Banner
      tone="neutral"
      title={scrubbed === 0
        ? text('plugins.sentry.ui.shortened', 'Some details were shortened')
        : text('plugins.sentry.ui.valuesRedacted', 'Sentry redacted some values')}
      description={scrubbed === 0
        ? text(
          'plugins.sentry.ui.shortened.description',
          'Open the issue in Sentry to read the complete text.',
        )
        : text(
          'plugins.sentry.ui.valuesRedacted.description',
          '{count} value(s) were already scrubbed by this organization’s own Sentry rules.',
          { count: scrubbed },
        )}
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
  const text = usePluginTranslation();
  if (summary.kind === 'loading') {
    return <LoadingState title="Reading this issue from Sentry" titleKey="plugins.sentry.ui.readingIssue" />;
  }
  if (summary.kind === 'unavailable') {
    return (
      <Banner
        tone="warning"
        title="Showing the last observation"
        titleKey="plugins.sentry.ui.lastObservation"
        description={failureDescription(
          summary.failure,
          text('plugins.sentry.ui.readFailed', 'Sentry could not complete this read.'),
        )}
      />
    );
  }

  const { value } = summary;
  const entries: readonly MetadataEntry[] = [
    ...(value.eventCount === undefined
      ? []
      : [{ label: text('plugins.sentry.ui.metadata.events', 'Events'), value: `~${value.eventCount}` }]),
    ...(value.userCount === undefined
      ? []
      : [{ label: text('plugins.sentry.ui.metadata.users', 'Users'), value: `~${formatNumber(locale, value.userCount, 'compact')}` }]),
    ...(value.firstSeenAtMs === undefined
      ? []
      : [{
        label: text('plugins.sentry.ui.metadata.firstSeen', 'First seen'),
        value: formatTimestamp(locale, value.firstSeenAtMs, 'relative', nowMs),
      }]),
    ...(value.lastSeenAtMs === undefined
      ? []
      : [{
        label: text('plugins.sentry.ui.metadata.lastSeen', 'Last seen'),
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
        : <Metadata title="Sentry now" titleKey="plugins.sentry.ui.sentryNow" entries={entries} />}
      <Text
        variant="caption"
        tone="neutral"
        valueKey="plugins.sentry.ui.retainedCount.description"
        fallback="Sentry counts what it retained for this project’s window, never every occurrence."
      />
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
  const text = usePluginTranslation();
  const controller = useSentryTagValues(input, tagKey);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title={text('plugins.sentry.ui.readingTagValues', 'Reading {tag} values', { tag: tagKey })} />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title={text('plugins.sentry.ui.tagValuesUnavailable', '{tag} values are unavailable', { tag: tagKey })}
        description={failureDescription(
          state.failure,
          text('plugins.sentry.ui.readFailed', 'Sentry could not complete this read.'),
        )}
      />
    );
  }
  if (state.rows.length === 0) {
    return (
      <EmptyState
        title={text('plugins.sentry.ui.noTagValues', 'No {tag} values', { tag: tagKey })}
        description="Sentry recorded no values for this tag on this issue."
        descriptionKey="plugins.sentry.ui.noTagValues.description"
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
            titleKey="plugins.sentry.ui.partialTagValues"
            description={failureDescription(
              state.failure,
              text('plugins.sentry.ui.readFailed', 'Sentry could not complete this read.'),
            )}
          />
        )}
      <ItemGroup accessibilityLabel={text(
        'plugins.sentry.ui.tagValuesLabel',
        'Values of {tag} on this Sentry issue',
        { tag: tagKey },
      )}>
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
      <Text
        variant="caption"
        tone="neutral"
        valueKey="plugins.sentry.ui.valuesRead"
        fallback="{count} value(s) read."
        values={{ count: state.rows.length }}
      />
      <IncompleteWalkNotice incomplete={state.incomplete} />
      {state.canLoadMore
        ? (
          <Button
            title="Load more values"
            titleKey="plugins.sentry.ui.loadMoreValues"
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
  const text = usePluginTranslation();
  const [openKey, setOpenKey] = React.useState<string | null>(null);

  if (distribution.kind === 'loading') {
    return <LoadingState title="Reading this issue’s tags" titleKey="plugins.sentry.ui.readingTags" />;
  }
  if (distribution.kind === 'unavailable') {
    return (
      <ErrorState
        title="Tags are unavailable"
        titleKey="plugins.sentry.ui.tagsUnavailable"
        description={failureDescription(
          distribution.failure,
          text('plugins.sentry.ui.readFailed', 'Sentry could not complete this read.'),
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
        titleKey="plugins.sentry.ui.noTags"
        description="Sentry recorded no tag distribution for this issue."
        descriptionKey="plugins.sentry.ui.noTags.description"
      />
    );
  }

  return (
    <Stack gap="small">
      {/*
        The disclosure this plane owes its reader (`SENTRY.md` §7.3a).

        Both the row subtitle below and the drill-down that opens under it render a
        tag's VALUE, and the only gate any of them passed is `isSentryRoutableTagKey`
        — a path-segment safety test, not a classification. Keeping every customer
        key here is deliberate: the event allow-list applies to event tags and only
        there, because applying it to this distribution would delete the custom tags
        teams triage by. So the reader is told what these values are instead of being
        shown a bounded subset that looks complete, which is the same honesty rule
        `RedactionNotice` states for a Tier-B/C body.
      */}
      <Banner
        tone="neutral"
        title="These tag values are unclassified"
        titleKey="plugins.sentry.ui.tagsUnclassified"
        description="Your own Sentry SDK chooses which tags exist, so a key such as user, url or server_name can carry personal data. Every tag Sentry indexed for this issue is shown here."
        descriptionKey="plugins.sentry.ui.tagsUnclassified.description"
      />
      <Text
        variant="caption"
        tone="neutral"
        valueKey="plugins.sentry.ui.tagValues.description"
        fallback="Tag values come from the events Sentry retained. Opening one reads its distribution."
      />
      <ItemGroup accessibilityLabel="Tags on this Sentry issue" accessibilityLabelKey="plugins.sentry.ui.tagsLabel">
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
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.sentry.ui.tagsUnreadable"
            fallback="{count} tag(s) on this issue could not be read."
            values={{ count: distribution.value.omittedTagCount }}
          />
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
  const text = usePluginTranslation();
  const factLabel = (field: SentryDetailFieldV1): string => {
    switch (field.id) {
      case 'issue-category': return text('plugins.sentry.ui.fact.issue-category', field.label);
      case 'issue-type': return text('plugins.sentry.ui.fact.issue-type', field.label);
      case 'level': return text('plugins.sentry.ui.fact.level', field.label);
      case 'culprit': return text('plugins.sentry.ui.fact.culprit', field.label);
      case 'unhandled': return text('plugins.sentry.ui.fact.unhandled', field.label);
      case 'project': return text('plugins.sentry.ui.fact.project', field.label);
      case 'events': return text('plugins.sentry.ui.fact.events', field.label);
      case 'users': return text('plugins.sentry.ui.fact.users', field.label);
      case 'last-seen': return text('plugins.sentry.ui.fact.last-seen', field.label);
      case 'first-seen': return text('plugins.sentry.ui.fact.first-seen', field.label);
      case 'assignee': return text('plugins.sentry.ui.fact.assignee', field.label);
      case 'priority': return text('plugins.sentry.ui.fact.priority', field.label);
      case 'last-release': return text('plugins.sentry.ui.fact.last-release', field.label);
      default: return field.label;
    }
  };
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
    return value === null ? [] : [{ label: factLabel(field), value }];
  });

  return (
    <ScrollArea>
      <Stack gap="large">
        {overview.summary === null ? null : <Text variant="body">{overview.summary}</Text>}
        <LiveSummary summary={summary} locale={locale} nowMs={nowMs} />
        {statusFields.length === 0 ? null : (
          <Row gap="small">
            {statusFields.map((field) => (
              <Status key={field.id} tone={field.tone} label={`${factLabel(field)}: ${field.value}`} />
            ))}
          </Row>
        )}
        {entries.length === 0
          ? (
            <EmptyState
              title="No projected facts"
              titleKey="plugins.sentry.ui.noFacts"
              description="This observation carried no displayable facts."
              descriptionKey="plugins.sentry.ui.noFacts.description"
            />
          )
          : <Metadata title="Facts" titleKey="plugins.sentry.ui.facts" entries={entries} />}
        {pendingFields.length === 0 ? null : (
          <Stack gap="small">
            <Text
              variant="caption"
              tone="neutral"
              valueKey="plugins.sentry.ui.detailOnly"
              fallback="Read only in this detail body:"
            />
            <Row gap="small">
              {pendingFields.map((field) => <Badge key={field.id} value={factLabel(field)} />)}
            </Row>
          </Stack>
        )}
        {!overview.projectionTruncated ? null : (
          <Banner
            tone="neutral"
            title="Some details were shortened"
            titleKey="plugins.sentry.ui.shortened"
            description="Open the issue in Sentry to read the complete text."
            descriptionKey="plugins.sentry.ui.shortened.description"
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
          titleKey="plugins.sentry.ui.observation"
          entries={[
            {
              label: text('plugins.sentry.ui.metadata.observed', 'Observed'),
              value: formatTimestamp(locale, overview.observedAtMs, 'relative', nowMs),
            },
            ...(overview.sourceUpdatedAtMs === null
              ? []
              : [{
                label: text('plugins.sentry.ui.metadata.lastChanged', 'Sentry last changed'),
                value: formatTimestamp(locale, overview.sourceUpdatedAtMs, 'relative', nowMs),
              }]),
          ]}
        />
      </Stack>
    </ScrollArea>
  );
}

/* ----------------------------------------------------------------- Occurrences */

/**
 * The sentence a walk owes its reader when it stopped without finishing.
 *
 * Sentry advertises its next page in a `Link` header. When that header is absent,
 * carries a cursor this build will not follow, or names a position this walk has
 * already requested, the walk ends WITHOUT reaching the end of the collection —
 * and saying nothing would present a truncated list as a complete one.
 *
 * `continuationUnavailable` is this side's own serialization failure rather
 * than provider cursor evidence. The generic stopped-short sentence is still
 * accurate for it and avoids inventing a provider fault or a size ceiling.
 */
function incompleteDescription(
  incomplete: SentryDetailIncompleteReasonV1 | null,
): Readonly<{ key: string; fallback: string }> | null {
  if (incomplete === null) return null;
  return {
    key: 'plugins.sentry.ui.walkStoppedShort',
    fallback: 'Sentry offered the next page in a form this build will not follow, so this'
      + ' list stops here.',
  };
}


/** Renders the stopped-short sentence, and nothing at all when the walk finished. */
function IncompleteWalkNotice({
  incomplete,
}: Readonly<{ incomplete: SentryDetailIncompleteReasonV1 | null }>): React.ReactElement | null {
  const text = usePluginTranslation();
  const description = incompleteDescription(incomplete);
  if (description === null) return null;
  return (
    <Text variant="caption" tone="neutral">
      {text(description.key, description.fallback)}
    </Text>
  );
}

/** The one sentence this list owes its reader, every time it is shown. */
const RETENTION_DISCLOSURE_KEY = 'plugins.sentry.ui.retentionDisclosure';
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
      <Text
        variant="caption"
        tone="neutral"
        valueKey={state.omittedRowCount === 0
          ? 'plugins.sentry.ui.retainedEventsRead'
          : 'plugins.sentry.ui.retainedEventsReadWithUnreadable'}
        fallback={state.omittedRowCount === 0
          ? '{count} retained event(s) read.'
          : '{count} retained event(s) read. {unreadable} row(s) on the pages read could not be understood.'}
        values={{ count: state.rows.length, unreadable: state.omittedRowCount }}
      />
      <IncompleteWalkNotice incomplete={state.incomplete} />
      {state.canLoadMore
        ? (
          <Button
            title="Load more retained events"
            titleKey="plugins.sentry.ui.loadMoreEvents"
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
  const text = usePluginTranslation();
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
    return <LoadingState title="Reading this occurrence" titleKey="plugins.sentry.ui.readingSelectedOccurrence" />;
  }
  if (read.kind === 'error') {
    return (
      <ErrorState
        title="This occurrence could not be read"
        titleKey="plugins.sentry.ui.occurrenceUnavailable"
        description={failureDescription(
          read.failure,
          text('plugins.sentry.ui.readFailed', 'Sentry could not complete this read.'),
        )}
      />
    );
  }

  const { projection } = read;
  const user = projection.user;
  const userEntries: readonly MetadataEntry[] = user === null
    ? []
    : [
      ...(user.id === null ? [] : [{ label: text('plugins.sentry.ui.metadata.id', 'Id'), value: user.id }]),
      ...(user.name === null ? [] : [{ label: text('plugins.sentry.ui.metadata.name', 'Name'), value: user.name }]),
      ...(user.username === null ? [] : [{ label: text('plugins.sentry.ui.metadata.username', 'Username'), value: user.username }]),
      ...(user.email === null ? [] : [{ label: text('plugins.sentry.ui.metadata.email', 'Email'), value: user.email }]),
      ...(user.ipAddress === null ? [] : [{ label: text('plugins.sentry.ui.metadata.ipAddress', 'IP address'), value: user.ipAddress }]),
    ];

  return (
    <Stack gap="small">
      <Divider />
      {projection.title === ''
        ? <Text variant="label" valueKey="plugins.sentry.ui.selectedOccurrence" fallback="Selected occurrence" />
        : <Text variant="label" value={projection.title} />}
      <SelectedEventRefreshNotice read={read} />
      <RedactionNotice projection={projection} />
      {projection.tags.length === 0
        ? null
        : (
          <Metadata
            title="This event’s tags"
            titleKey="plugins.sentry.ui.eventTags"
            entries={projection.tags.map((tag) => ({ label: tag.key, value: tag.value }))}
          />
        )}
      {userEntries.length === 0
        ? null
        : (
          <Stack gap="small">
            <Button
              title={revealUser
                ? text('plugins.sentry.ui.hideUserDetails', 'Hide event user details')
                : text('plugins.sentry.ui.showUserDetails', 'Show event user details')}
              variant="secondary"
              onPress={() => {
                setRevealUser((current) => !current);
              }}
            />
            {revealUser ? <Metadata title="Event user" titleKey="plugins.sentry.ui.eventUser" entries={userEntries} /> : null}
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
  const text = usePluginTranslation();
  const controller = useSentryOccurrences(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading retained events" titleKey="plugins.sentry.ui.readingEvents" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="Retained events are unavailable"
        titleKey="plugins.sentry.ui.eventsUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.sentry.ui.readFailed', 'Sentry could not complete this read.'),
        )}
      />
    );
  }

  return (
    <List
      accessibilityLabel="Events Sentry retained for this issue"
      accessibilityLabelKey="plugins.sentry.ui.eventsLabel"
      items={state.rows}
      keyForItem={(row) => row.eventId}
      header={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey={RETENTION_DISCLOSURE_KEY}
            fallback={RETENTION_DISCLOSURE}
          />
          {state.failure === null
            ? null
            : (
              <Banner
                tone="warning"
                title="Showing the events read so far"
                titleKey="plugins.sentry.ui.partialEvents"
                description={failureDescription(
                  state.failure,
                  text('plugins.sentry.ui.readFailed', 'Sentry could not complete this read.'),
                )}
              />
            )}
          <ActivatedOccurrenceDetail controller={selectedEvent} />
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No retained events"
          titleKey="plugins.sentry.ui.noEvents"
          description={RETENTION_DISCLOSURE}
          descriptionKey={RETENTION_DISCLOSURE_KEY}
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

type SentryTraceListRowV1 =
  | Readonly<{ key: string; kind: 'frame'; frame: SentryFrameV1 }>
  | Readonly<{
      key: string;
      kind: 'breadcrumb';
      title: string;
      level: string | null;
      timestampMs: number | null;
    }>;

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
  const text = usePluginTranslation();
  const [showSystemFrames, setShowSystemFrames] = React.useState(false);
  const { read } = controller;

  if (read.kind !== 'success') {
    // Reachable only in the instant between a refresh starting and settling: the
    // tab's own condition is derived from a successful projection.
    return <LoadingState title="Reading this occurrence" titleKey="plugins.sentry.ui.readingSelectedOccurrence" />;
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
  const traceListSections = [
    ...traceSections.map((section, sectionIndex) => ({
      key: `${section.kind}:${String(sectionIndex)}`,
      title: section.kind === 'exception'
        ? `${section.type}: ${section.value}`
        : text('plugins.sentry.ui.tab.stackTrace', 'Stack Trace'),
      data: section.frames.flatMap((frame, frameIndex): readonly SentryTraceListRowV1[] => (
        !showSystemFrames && !frame.inApp
          ? []
          : [{
              // Section identity is part of the row key because List's one
              // flattened navigation/window owner requires collection-wide keys.
              key: `${section.kind}:${String(sectionIndex)}:${String(frameIndex)}:${frame.filename ?? ''}:${String(frame.lineNo ?? 0)}`,
              kind: 'frame',
              frame,
            }]
      )),
    })),
    ...breadcrumbs.map((section, sectionIndex) => ({
      key: `breadcrumbs:${String(sectionIndex)}`,
      title: text('plugins.sentry.ui.breadcrumbs', 'Breadcrumbs'),
      data: section.kind !== 'breadcrumbs'
        ? []
        : section.entries.map((crumb, crumbIndex): SentryTraceListRowV1 => ({
            key: `breadcrumbs:${String(sectionIndex)}:${String(crumbIndex)}:${crumb.category ?? ''}`,
            kind: 'breadcrumb',
            title: crumb.message ?? crumb.category
              ?? text('plugins.sentry.ui.breadcrumbs', 'Breadcrumbs'),
            level: crumb.level,
            timestampMs: crumb.timestampMs,
          })),
    })),
  ];
  const displayedFrameCount = traceSections.reduce(
    (count, section) => count + section.frames.filter(
      (frame) => showSystemFrames || frame.inApp,
    ).length,
    0,
  );

  return (
    <List
      accessibilityLabel="Stack Trace"
      accessibilityLabelKey="plugins.sentry.ui.tab.stackTrace"
      sections={traceListSections}
      keyForItem={(row) => row.key}
      header={(
        <Stack gap="large">
          <Text
            variant="caption"
            tone="neutral"
            valueKey={when === null
              ? 'plugins.sentry.ui.selectionIdentity'
              : 'plugins.sentry.ui.selectionIdentityRecorded'}
            fallback={when === null
              ? 'This is {selection}.'
              : 'This is {selection}, recorded {when}.'}
          values={{ selection: selectionLabel(controller), when: when ?? '' }}
          />
          <SelectedEventRefreshNotice read={read} />
          <RedactionNotice projection={projection} />
          <Row gap="small">
            <Button
              title={showSystemFrames
                ? text('plugins.sentry.ui.hideSystemFrames', 'Hide system frames')
                : text('plugins.sentry.ui.showSystemFrames', 'Show system frames')}
              variant="secondary"
              onPress={() => {
                setShowSystemFrames((current) => !current);
              }}
            />
          </Row>
          {displayedFrameCount === 0
            ? (
              <EmptyState
                title="No application frames"
                titleKey="plugins.sentry.ui.noApplicationFrames"
                description="Every frame in this section came from outside your own code."
                descriptionKey="plugins.sentry.ui.noApplicationFrames.description"
              />
            )
            : null}
        </Stack>
      )}
      renderItem={(row) => row.kind === 'frame'
        ? (
          <Item
            title={frameLabel(row.frame)}
            {...(row.frame.contextLine === null ? {} : { subtitle: row.frame.contextLine })}
            {...(row.frame.inApp ? {} : { detail: 'system' })}
          />
        )
        : (
          <Item
            title={row.title}
            {...(row.level === null ? {} : { subtitle: row.level })}
            {...(row.timestampMs === null
              ? {}
              : { detail: formatTimestamp(locale, row.timestampMs, 'relative', nowMs) })}
          />
        )}
      footer={(
        <Stack gap="large">
          {projection.omitted.frames === 0
            ? null
            : (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.sentry.ui.framesOmitted"
                fallback="{count} outer frame(s) are not shown. The frames nearest the failure are kept."
                values={{ count: projection.omitted.frames }}
              />
            )}
          {messages.map((section, index) => (
            section.kind !== 'message'
              ? null
              : <Text key={`message:${String(index)}`} variant="body">{section.formatted}</Text>
          ))}
        </Stack>
      )}
    />
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
  const text = usePluginTranslation();
  const rows = [
    ...(summary.firstRelease === undefined
      ? []
      : [{ label: text('plugins.sentry.ui.metadata.firstSeenIn', 'First seen in'), release: summary.firstRelease }]),
    ...(summary.lastRelease === undefined
      ? []
      : [{ label: text('plugins.sentry.ui.metadata.lastSeenIn', 'Last seen in'), release: summary.lastRelease }]),
  ];

  return (
    <ScrollArea>
      <Stack gap="large">
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.sentry.ui.releaseEvidence.description"
          fallback="Sentry states these releases on the issue itself; nothing here is inferred from a deploy history."
        />
        <ItemGroup accessibilityLabel="Releases this Sentry issue is associated with" accessibilityLabelKey="plugins.sentry.ui.releasesLabel">
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
        titleKey="plugins.sentry.ui.activityUnreadable"
        description="Sentry returned an activity history this build does not understand."
        descriptionKey="plugins.sentry.ui.activityUnreadable.description"
      />
    );
  }

  return (
    <List
      accessibilityLabel="Recorded activity for this Sentry issue"
      accessibilityLabelKey="plugins.sentry.ui.activityLabel"
      items={history.items}
      keyForItem={(item) => item.id}
      empty={(
        <EmptyState
          title="No recorded activity"
          titleKey="plugins.sentry.ui.noActivity"
          description="Sentry has recorded no changes to this issue."
          descriptionKey="plugins.sentry.ui.noActivity.description"
        />
      )}
      footer={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.sentry.ui.activityRecordsRead"
            fallback="{count} activity record(s) read. Sentry states this history on the issue itself and does not paginate it."
            values={{ count: history.items.length }}
          />
          {history.malformedItemCount + history.omittedItemCount === 0
            ? null
            : (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.sentry.ui.recordsNotShown"
                fallback="{count} record(s) could not be shown."
                values={{ count: history.malformedItemCount + history.omittedItemCount }}
              />
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
  const text = usePluginTranslation();
  const history = useSentryActivityHistory(input);

  if (history.kind === 'loading') {
    return <LoadingState title="Reading this issue’s activity" titleKey="plugins.sentry.ui.readingActivity" />;
  }
  if (history.kind === 'unavailable') {
    return (
      <ErrorState
        title="Activity is unavailable"
        titleKey="plugins.sentry.ui.activityUnavailable"
        description={failureDescription(
          history.failure,
          text('plugins.sentry.ui.readFailed', 'Sentry could not complete this read.'),
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
  const text = usePluginTranslation();
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
        // The strip's own name, and each tab's, reach the shared primitive as plain
        // strings — it takes no key — so this body resolves them itself. An unresolved
        // one would name the sections in English on ten of the eleven locales this
        // plugin ships, and a screen reader is where that is least recoverable.
        ariaLabel={text('plugins.sentry.ui.tabsLabel', 'Sentry issue detail sections')}
      >
        {visible.map((declaration) => (
          <Tabs.Item
            key={declaration.id}
            value={declaration.id}
            title={text(declaration.titleKey, declaration.title)}
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
          titleKey="plugins.sentry.ui.invalidInput"
          description="Triage supplied a detail input this Sentry build does not accept."
          descriptionKey="plugins.sentry.ui.invalidInput.description"
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
