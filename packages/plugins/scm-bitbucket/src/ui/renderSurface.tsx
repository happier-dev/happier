/**
 * The Bitbucket Cloud Triage detail surface artifact entry.
 *
 * Triage mounts this renderer inside its own detail pane and hands it exactly one value: the
 * published `TriageDetailSurfaceInputV1` launch input. This file admits that value through the
 * published closed schema rather than casting it — a mount that hands over something else is a
 * contract break the surface reports, not one it renders around.
 *
 * It begins directly below Triage's permanently mounted common header and renders none of that
 * header's facts. The title, kind, state, scope, provider link, attention and Session relationship
 * belong to the aggregate (`CONTRACT.md` §7, `core/SURFACE.md` §2.2); repeating them here is a
 * second renderer of one header, and the copy that drifts is the one the user is looking at.
 *
 * What it does own are Bitbucket's own facts: the combined activity stream, the build statuses
 * reported against the pull request, and the conversation. Each is a real read with its own
 * lifetime, issued when its tab becomes active and never on mount.
 *
 * `Diff` is deliberately absent rather than empty. Bitbucket serves a diff as a redirected raw
 * text stream rather than a JSON file array, and its reader is a separate unit; a `Diff` tab that
 * rendered nothing would read as "this pull request changes nothing". There is likewise no Issues
 * affordance — Atlassian is removing the Bitbucket Cloud issue tracker, so there is no durable
 * product to build a tab against.
 */

import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Action,
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
  type MetadataEntry,
} from '@happier-dev/plugin-ui';
import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
  type TriageLinkedSessionProjectionV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import type {
  BitbucketProjectedActivityRowV1,
  BitbucketProjectedCommentRowV1,
  BitbucketProjectedStatusRowV1,
} from '../triage/detail/projection.js';
import {
  projectBitbucketDetailOverview,
  type BitbucketDetailFieldV1,
  type BitbucketDetailOverviewV1,
} from '../triage/source/detail.js';

import {
  useBitbucketActivity,
  useBitbucketBuilds,
  useBitbucketComments,
} from './detail/panelReaders.js';
import type { BitbucketPagedStateV1 } from './detail/panelState.js';
import {
  BITBUCKET_DEFAULT_DETAIL_TAB_V1,
  BITBUCKET_DETAIL_TABS_V1,
  type BitbucketDetailTabIdV1,
} from './detail/tabDeclarations.js';

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = Object.freeze([
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
] as const);

/**
 * `relative` is relative to the reader's present, which is what a triage reader means by "updated
 * 4 minutes ago". `nowMs` is passed in rather than read here so the value is a render input and
 * not a hidden clock read.
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

function fieldValueText(
  field: BitbucketDetailFieldV1,
  locale: string,
  nowMs: number,
): string | null {
  switch (field.kind) {
    case 'text':
    case 'status':
      return field.value;
    case 'number': {
      const formatted = new Intl.NumberFormat(
        locale,
        field.format === 'compact' ? { notation: 'compact', maximumFractionDigits: 1 } : {},
      ).format(field.value);
      // A count the source could not promise as exact is never presented as a total.
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

/**
 * The banner a later-page failure owes its reader.
 *
 * It appears only over rows that already arrived. A first-page failure is a different
 * presentation entirely — the panel says it could not look.
 */
function PageFailureBanner({
  state,
}: Readonly<{ state: BitbucketPagedStateV1<unknown> }>): React.ReactElement | null {
  if (state.failure === null) return null;
  return (
    <Banner
      tone="warning"
      title="Showing what was read so far"
      description={failureDescription(state.failure, 'The next page could not be read.')}
    />
  );
}

/** The footer every paged panel shares: what was read, and how to ask for more. */
function PagedFooter({
  state,
  loadMoreTitle,
  onLoadMore,
  onRefresh,
  refreshLabel,
  summary,
}: Readonly<{
  state: BitbucketPagedStateV1<unknown>;
  loadMoreTitle: string;
  onLoadMore: () => void;
  onRefresh: () => void;
  refreshLabel: string;
  summary: string;
}>): React.ReactElement {
  return (
    <Stack gap="small">
      <Text variant="caption" tone="neutral">
        {state.omittedRowCount === 0
          ? summary
          : `${summary} ${String(state.omittedRowCount)} row(s) on the pages read could not be understood.`}
      </Text>
      {state.canLoadMore
        ? (
          <Button
            title={loadMoreTitle}
            variant="secondary"
            busy={state.pending}
            onPress={onLoadMore}
          />
        )
        : null}
      <Row gap="small">
        <Action.Refresh
          onRefresh={onRefresh}
          disabled={state.pending}
          variant="plain"
          accessibilityLabel={refreshLabel}
        />
      </Row>
    </Stack>
  );
}

/* -------------------------------------------------------------------- Overview */

function OverviewPanel({
  overview,
  locale,
  nowMs,
}: Readonly<{
  overview: BitbucketDetailOverviewV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const statusFields = overview.fields.filter(
    (field): field is Extract<BitbucketDetailFieldV1, { kind: 'status' }> => field.kind === 'status',
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
        {!overview.projectionTruncated ? null : (
          <Banner
            tone="neutral"
            title="Some details were shortened"
            description="Open the pull request in Bitbucket to read the complete text."
          />
        )}
        {statusFields.length === 0 ? null : (
          <Row gap="small">
            {statusFields.map((field) => (
              <Status key={field.id} tone={field.tone} label={`${field.label}: ${field.value}`} />
            ))}
          </Row>
        )}
        {entries.length === 0
          ? <EmptyState title="No projected facts" description="This observation carried no displayable facts." />
          : <Metadata title="Facts" entries={entries} />}
        {pendingFields.length === 0 ? null : (
          <Stack gap="small">
            <Text variant="caption" tone="neutral">
              {'Answered in the panels beside this one, not on the list row:'}
            </Text>
            <Row gap="small">
              {pendingFields.map((field) => <Badge key={field.id} value={field.label} />)}
            </Row>
          </Stack>
        )}
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
                label: 'Bitbucket last changed',
                value: formatTimestamp(locale, overview.sourceUpdatedAtMs, 'relative', nowMs),
              }]),
          ]}
        />
      </Stack>
    </ScrollArea>
  );
}

/* -------------------------------------------------------------------- Activity */

const ACTIVITY_HEADLINES: Readonly<Record<string, string | undefined>> = Object.freeze({
  approval: 'Approved',
  changesRequested: 'Requested changes',
  update: 'Updated the pull request',
  comment: 'Commented',
});

function activityHeadline(row: BitbucketProjectedActivityRowV1): string {
  // An entry this build does not model keeps Bitbucket's own word for it rather
  // than disappearing or being described as something it is not.
  const headline = ACTIVITY_HEADLINES[row.kind] ?? row.rawKind;
  return row.actor === undefined ? headline : `${headline} · ${row.actor}`;
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
  const controller = useBitbucketActivity(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading this activity from Bitbucket" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The activity is unavailable"
        description={failureDescription(state.failure, 'Bitbucket did not return this activity.')}
      />
    );
  }
  return (
    <List
      accessibilityLabel="Activity Bitbucket recorded for this pull request"
      items={state.rows}
      keyForItem={(row) => row.key}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          <Text variant="caption" tone="neutral">
            {'Bitbucket serves approvals, updates and comments from one collection, so this is all of them.'}
          </Text>
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No recorded activity"
          description="Bitbucket has recorded nothing on this pull request yet."
        />
      )}
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle="Show more activity"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read this activity from Bitbucket"
          summary={`${String(state.rows.length)} entry/entries read.`}
        />
      )}
      renderItem={(row) => (
        <Item
          title={activityHeadline(row)}
          {...(row.summary === undefined ? {} : { subtitle: row.summary })}
          {...(row.atMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.atMs, 'relative', nowMs) })}
        />
      )}
    />
  );
}

/* ---------------------------------------------------------------------- Builds */

function buildTone(row: BitbucketProjectedStatusRowV1): 'success' | 'danger' | 'warning' | 'neutral' {
  const state = row.state.trim().toUpperCase();
  if (state === 'SUCCESSFUL') return 'success';
  if (state === 'FAILED' || state === 'ERROR') return 'danger';
  if (state === 'INPROGRESS') return 'warning';
  return 'neutral';
}

function BuildsPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const controller = useBitbucketBuilds(input);
  const { rollup, state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the builds from Bitbucket" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The builds are unavailable"
        description={failureDescription(
          state.failure,
          'Bitbucket did not return the build statuses of this pull request.',
        )}
      />
    );
  }

  // Every count is present or every count is absent. A rollup exists only when
  // the first page WAS the whole collection, because three counts over the
  // statuses that fit one page is a number a reviewer would act on.
  const rollupEntries: readonly MetadataEntry[] = rollup.failingCount === undefined
    ? []
    : [
      { label: 'Failing', value: String(rollup.failingCount) },
      { label: 'Running', value: String(rollup.runningCount ?? 0) },
      { label: 'Passing', value: String(rollup.passingCount ?? 0) },
    ];

  return (
    <List
      accessibilityLabel="Build statuses reported against this Bitbucket pull request"
      items={state.rows}
      keyForItem={(row) => row.key}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          {rollupEntries.length > 0
            ? <Metadata title="All reported builds" entries={rollupEntries} />
            : state.rows.length === 0
              ? null
              : (
                <Text variant="caption" tone="neutral">
                  {'Bitbucket has more build statuses than this page holds, so no totals are shown for them.'}
                </Text>
              )}
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No builds"
          description="No build has reported a status against this pull request."
        />
      )}
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle="Show more builds"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read the builds from Bitbucket"
          summary={`${String(state.rows.length)} build status(es) read.`}
        />
      )}
      renderItem={(row) => (
        <Item
          title={row.name}
          subtitle={row.description ?? row.state}
          tone={buildTone(row)}
          {...(row.updatedAtMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.updatedAtMs, 'relative', nowMs) })}
          {...(row.url === undefined
            ? {}
            : {
              accessory: (
                <Action.OpenExternal
                  url={row.url}
                  variant="plain"
                  accessibilityLabel={`Open the ${row.name} results`}
                />
              ),
            })}
        />
      )}
    />
  );
}

/* -------------------------------------------------------------------- Comments */

const RESOLUTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  resolved: 'Resolved',
  unresolved: 'Open',
  // Never "Open": a deployment that did not report resolution said nothing, and
  // saying "Open" on its behalf tells a reviewer their resolved thread is not.
  unknown: 'Resolution not reported',
});

function commentHeadline(row: BitbucketProjectedCommentRowV1): string {
  const author = row.author ?? 'Someone';
  const edited = row.editedAtMs === undefined ? '' : ' · edited';
  const reply = row.parentId === undefined ? '' : ' · reply';
  return `${author}${reply}${edited}`;
}

function CommentsPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const controller = useBitbucketComments(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the comments from Bitbucket" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The comments are unavailable"
        description={failureDescription(state.failure, 'Bitbucket did not return these comments.')}
      />
    );
  }
  return (
    <List
      accessibilityLabel="Comments on this Bitbucket pull request"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={<PageFailureBanner state={state} />}
      empty={(
        <EmptyState
          title="No comments"
          description="Nobody has commented on this pull request yet."
        />
      )}
      footer={(
        <PagedFooter
          state={state}
          // Deliberately not "earlier": Bitbucket publishes pagination but no
          // chronological ordering contract for this collection.
          loadMoreTitle="Show 30 more comments"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read the comments from Bitbucket"
          summary={`${String(state.rows.length)} comment(s) read.`}
        />
      )}
      renderItem={(row) => (
        <Item
          title={commentHeadline(row)}
          subtitle={row.deleted ? 'This comment was deleted.' : row.body}
          detail={RESOLUTION_LABELS[row.resolution]}
          {...(row.atMs === undefined
            ? {}
            : { caption: formatTimestamp(locale, row.atMs, 'relative', nowMs) })}
          {...(row.url === undefined
            ? {}
            : {
              accessory: (
                <Action.OpenExternal
                  url={row.url}
                  variant="plain"
                  accessibilityLabel="Open this comment in Bitbucket"
                />
              ),
            })}
        />
      )}
    />
  );
}

/* -------------------------------------------------------------------- Sessions */

function SessionsPanel({
  sessions,
}: Readonly<{ sessions: readonly TriageLinkedSessionProjectionV1[] }>): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No linked sessions"
        description="Sessions started from this pull request will be listed here."
      />
    );
  }
  return (
    <List accessibilityLabel="Sessions linked to this Bitbucket pull request">
      <ItemGroup>
        {sessions.map((session) => (
          <Item
            key={session.sessionId}
            title={session.displayTitle ?? session.sessionId}
            // A retained link whose Session summary is unavailable keeps its id and loses only
            // its display text. It is never presented as "never linked".
            subtitle={session.displayTitle === undefined ? 'Session details are unavailable' : undefined}
          />
        ))}
      </ItemGroup>
    </List>
  );
}

/* ------------------------------------------------------------------------ shell */

function BitbucketDetailBody({
  input,
}: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const { locale } = useSurfaceContext();
  const [selected, setSelected] = React.useState<BitbucketDetailTabIdV1>(
    BITBUCKET_DEFAULT_DETAIL_TAB_V1,
  );
  // One render-time read, passed down as data, so no child owns a hidden clock.
  const nowMs = Date.now();
  const overview = React.useMemo(() => projectBitbucketDetailOverview(input), [input]);

  const panels: Readonly<Record<BitbucketDetailTabIdV1, React.ReactNode>> = {
    overview: <OverviewPanel overview={overview} locale={locale} nowMs={nowMs} />,
    activity: <ActivityPanel input={input} locale={locale} nowMs={nowMs} />,
    builds: <BuildsPanel input={input} locale={locale} nowMs={nowMs} />,
    comments: <CommentsPanel input={input} locale={locale} nowMs={nowMs} />,
    sessions: <SessionsPanel sessions={overview.linkedSessions} />,
  };

  return (
    <Screen safeArea>
      <Tabs
        value={selected}
        onValueChange={(next) => {
          // The declarations are the only tab identities this body renders, so a value that is
          // not one of them selects nothing rather than becoming a tab id by assertion.
          const declared = BITBUCKET_DETAIL_TABS_V1.find((candidate) => candidate.id === next);
          if (declared !== undefined) setSelected(declared.id);
        }}
        ariaLabel="Bitbucket pull request detail"
      >
        {BITBUCKET_DETAIL_TABS_V1.map((declaration) => (
          <Tabs.Item
            key={declaration.id}
            value={declaration.id}
            title={declaration.title}
            // Stated, never inherited: the shared primitive would otherwise discard a panel this
            // source means to keep, or keep one it means to discard.
            retention={declaration.retention}
            {...(declaration.id === 'sessions' && overview.linkedSessions.length > 0
              ? { badge: String(overview.linkedSessions.length) }
              : {})}
          >
            {panels[declaration.id]}
          </Tabs.Item>
        ))}
      </Tabs>
    </Screen>
  );
}

function BitbucketDetailSurface(context: RenderContext): React.ReactElement {
  const admitted = React.useMemo(() => {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
    return parsed.success ? { ok: true as const, input: parsed.data } : { ok: false as const };
  }, [context.launchInput]);

  if (!admitted.ok) {
    return (
      <Screen safeArea>
        <ErrorState
          title="This pull request cannot be shown"
          description="Triage supplied a detail input this Bitbucket build does not accept."
        />
      </Screen>
    );
  }

  return <BitbucketDetailBody input={admitted.input} />;
}

/**
 * The exact export name the build target's Module Federation identity names. Renaming it breaks
 * the native artifact contract, not just this file.
 */
export const renderSurface = defineUiSurface(BitbucketDetailSurface);
