/**
 * The GitHub Triage detail surface artifact entry.
 *
 * Triage mounts this renderer inside its own detail pane and hands it exactly one value: the
 * published `TriageDetailSurfaceInputV1` launch input. This file admits that value through the
 * published closed schema rather than casting it — a mount that hands over something else is a
 * contract break the surface reports, not one it renders around.
 *
 * It begins directly below Triage's permanently mounted common header and renders none of that
 * header's facts. The title, kind, state, scope, provider link, attention and Session
 * relationship belong to the aggregate (`CONTRACT.md` §7); repeating them here is a second
 * renderer of one header, and the copy that drifts is the one the user is looking at.
 *
 * What it does own are GitHub's own facts: the event timeline, the files a pull request changes,
 * its check runs and commit statuses, and the conversation. Every one of them is a real read with
 * its own lifetime, issued when its tab becomes active and never on mount — GitHub involvement
 * scanning already spends real provider budget, and four planes fetched eagerly would multiply it
 * on every detail open.
 *
 * Every panel distinguishes the same four settled outcomes, because on this source they are
 * genuinely different answers: a collection the provider stated as empty says so; a first read
 * that failed says *that* instead, naming itself; a later page that failed keeps the rows the
 * reader already had and shows the failure beside them; and a walk that stopped short of the whole
 * collection keeps its rows and names the reason.
 *
 * Diffs are not rendered here. The rich diff body is held at the shared component catalog under
 * B6, so the Files panel presents the changed-file LIST through the approved `List` family with
 * its counts, its status, its deterministic reading order and its per-file *diff unavailable*
 * state. It neither wraps an app-private diff component nor invents a partial one.
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
  Markdown,
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

import {
  groupGithubChangedFiles,
  orderGithubChangedFiles,
} from '../triage/detail/files/orderChangedFiles.js';
import type {
  GithubProjectedChangedFileRowV1,
  GithubProjectedCheckRowV1,
  GithubProjectedCommentRowV1,
  GithubProjectedTimelineRowV1,
} from '../triage/detail/projection.js';
import { GITHUB_CHANGED_FILES_CEILING_V1 } from '../triage/detail/routes.js';
import { readGithubTriageKindId } from '../triage/contribution.js';
import type { GithubTriageKindIdV1 } from '../triage/types.js';

import {
  projectGithubDetailBody,
  type GithubDetailBodyV1,
  type GithubDetailFieldV1,
} from './detail/model.js';
import {
  useGithubChangedFiles,
  useGithubChecks,
  useGithubComments,
  useGithubTimeline,
  type GithubChecksViewV1,
  type GithubPagedControllerV1,
} from './detail/panelReaders.js';
import type { GithubPagedStateV1, GithubReadStateV1 } from './detail/panelState.js';
import {
  GITHUB_DEFAULT_DETAIL_TAB_V1,
  githubResolveSelectedTab,
  githubVisibleDetailTabs,
  type GithubDetailTabIdV1,
} from './detail/tabDeclarations.js';

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = Object.freeze([
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
] as const);

/**
 * `relative` is relative to the reader's present, which is what a triage reader means by
 * "updated 4 minutes ago". `nowMs` is passed in rather than read here so the value is a render
 * input and not a hidden clock read.
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
  field: GithubDetailFieldV1,
  locale: string,
  nowMs: number,
): string | null {
  switch (field.kind) {
    case 'text':
    case 'status':
      return field.value;
    case 'number': {
      const formatted = formatNumber(locale, field.value, field.format);
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
 * The sentence a walk owes its reader when it stopped without finishing.
 *
 * Only the changed-file plane has a documented ceiling, so only it supplies a
 * ceiling sentence. A plane with no ceiling never claims one — saying "GitHub
 * caps this list" about a timeline would be a fact this product invented.
 */
function incompleteDescription(
  incomplete: 'ceiling' | 'pagination' | null,
  ceilingSentence: string | null,
): string | null {
  if (incomplete === 'pagination') {
    return 'GitHub offered another page in a form this build will not follow, so this list'
      + ' stops here.';
  }
  return incomplete === 'ceiling' ? ceilingSentence : null;
}

/**
 * The banner a later-page failure owes its reader.
 *
 * It appears only over rows that already arrived. A first-page failure is a
 * different presentation entirely — the panel says it could not look.
 */
function PageFailureBanner({
  state,
}: Readonly<{ state: GithubPagedStateV1<unknown> }>): React.ReactElement | null {
  if (state.failure === null) return null;
  return (
    <Banner
      tone="warning"
      title="Showing what was read so far"
      description={failureDescription(state.failure, 'The next page could not be read.')}
    />
  );
}

/**
 * The explicit refresh every panel offers, and the only one it offers.
 *
 * There is no automatic poll inside a detail tab: a panel that re-read on its own would spend
 * GitHub rate budget for a reader who is not looking at it.
 */
function RefreshRow({
  onRefresh,
  pending,
  accessibilityLabel,
}: Readonly<{
  onRefresh: () => void;
  /** A walk already in flight; the control stays mounted and inert rather than vanishing. */
  pending: boolean;
  accessibilityLabel: string;
}>): React.ReactElement {
  return (
    <Row gap="small">
      <Action.Refresh
        onRefresh={onRefresh}
        disabled={pending}
        variant="plain"
        accessibilityLabel={accessibilityLabel}
      />
    </Row>
  );
}

/* --------------------------------------------------------------------- Overview */

function OverviewPanel({
  body,
  locale,
  nowMs,
}: Readonly<{
  body: GithubDetailBodyV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const statusFields = body.fields.filter(
    (field): field is Extract<GithubDetailFieldV1, { kind: 'status' }> => field.kind === 'status',
  );
  const pendingFields = body.fields.filter((field) => field.kind === 'pending');
  const entries: readonly MetadataEntry[] = body.fields.flatMap((field) => {
    if (field.kind === 'pending' || field.kind === 'status') return [];
    const value = fieldValueText(field, locale, nowMs);
    return value === null ? [] : [{ label: field.label, value }];
  });

  return (
    <ScrollArea>
      <Stack gap="large">
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
              description="This observation carried no displayable GitHub facts."
            />
          )
          : <Metadata title="GitHub" entries={entries} />}
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
      </Stack>
    </ScrollArea>
  );
}

/* --------------------------------------------------------------------- Timeline */

/**
 * The reader-facing sentence for one timeline arm.
 *
 * `forcePushed` and `baseChanged` read differently from an ordinary push on
 * purpose: both silently invalidate work computed against the previous head or
 * base, and a reader scanning the timeline is exactly who needs to notice.
 */
const TIMELINE_HEADLINES: Readonly<Record<string, string | undefined>> = Object.freeze({
  commented: 'Commented',
  committed: 'Pushed a commit',
  forcePushed: 'Force-pushed the head branch',
  baseChanged: 'Changed the base branch',
  reviewed: 'Reviewed',
  reviewRequested: 'Requested a review',
  reviewRequestRemoved: 'Removed a review request',
  merged: 'Merged',
  closed: 'Closed',
  reopened: 'Reopened',
  labeled: 'Added a label',
  unlabeled: 'Removed a label',
  assigned: 'Assigned',
  unassigned: 'Unassigned',
  milestoned: 'Added to a milestone',
  demilestoned: 'Removed from a milestone',
  renamed: 'Renamed',
  referenced: 'Referenced',
  crossReferenced: 'Cross-referenced',
});

function timelineHeadline(row: GithubProjectedTimelineRowV1): string {
  // An event this build does not model keeps GitHub's own word for it rather
  // than disappearing or being described as something it is not.
  const headline = TIMELINE_HEADLINES[row.kind] ?? row.rawKind;
  return row.actor === undefined ? headline : `${headline} · ${row.actor}`;
}

function TimelinePanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const controller = useGithubTimeline(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading this timeline from GitHub" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The timeline is unavailable"
        description={failureDescription(state.failure, 'GitHub did not return this timeline.')}
      />
    );
  }

  const incomplete = incompleteDescription(state.incomplete, null);
  return (
    <List
      accessibilityLabel="Events GitHub recorded for this entry"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={<PageFailureBanner state={state} />}
      empty={(
        <EmptyState
          title="No recorded events"
          description="GitHub has recorded no timeline events for this entry yet."
        />
      )}
      footer={(
        <Stack gap="small">
          <Text variant="caption" tone="neutral">
            {state.omittedRowCount === 0
              ? `${String(state.rows.length)} event(s) read.`
              : `${String(state.rows.length)} event(s) read. ${String(state.omittedRowCount)} row(s) on the pages read could not be understood.`}
          </Text>
          {incomplete === null
            ? null
            : <Text variant="caption" tone="neutral">{incomplete}</Text>}
          {state.canLoadMore
            ? (
              <Button
                title="Load earlier events"
                variant="secondary"
                busy={state.pending}
                onPress={controller.loadMore}
              />
            )
            : null}
          <RefreshRow
            onRefresh={controller.refresh}
            pending={state.pending}
            accessibilityLabel="Re-read this timeline from GitHub"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <Item
          title={timelineHeadline(row)}
          {...(row.summary === undefined ? {} : { subtitle: row.summary })}
          {...(row.atMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.atMs, 'relative', nowMs) })}
          {...(row.webUrl === undefined
            ? {}
            : {
              accessory: (
                <Action.OpenExternal
                  url={row.webUrl}
                  variant="plain"
                  accessibilityLabel={`Open this event on GitHub: ${timelineHeadline(row)}`}
                />
              ),
            })}
        />
      )}
    />
  );
}

/* ------------------------------------------------------------------------ Files */

const CHANGED_FILE_TONES: Readonly<Record<string, 'success' | 'danger' | 'info' | 'neutral'>> =
  Object.freeze({
    added: 'success',
    removed: 'danger',
    renamed: 'info',
    copied: 'info',
  });

function changedFileDetail(
  row: GithubProjectedChangedFileRowV1,
  locale: string,
): string {
  return `+${formatNumber(locale, row.additions, 'compact')} −${formatNumber(locale, row.deletions, 'compact')}`;
}

function changedFileSubtitle(row: GithubProjectedChangedFileRowV1): string {
  const renamed = row.previousPath === undefined ? null : `was ${row.previousPath}`;
  // A file GitHub omitted the patch for is a real provider fact, and it renders
  // as that fact rather than as an empty diff.
  const diff = row.diffAvailable ? null : 'diff unavailable for this file';
  return [row.status, renamed, diff].filter((part) => part !== null).join(' · ');
}

function FilesPanel({
  input,
  locale,
}: Readonly<{ input: TriageDetailSurfaceInputV1; locale: string }>): React.ReactElement {
  const controller = useGithubChangedFiles(input);
  const { state } = controller;
  // The reading order is a source-owned fact computed over everything read so
  // far, so appending a page reorders within the same three bands rather than
  // stapling a second, differently ordered list onto the end.
  const sections = React.useMemo(
    () => groupGithubChangedFiles(orderGithubChangedFiles(state.rows))
      .map((section) => ({ key: section.band, title: section.title, data: section.rows })),
    [state.rows],
  );

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the changed files from GitHub" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The changed files are unavailable"
        description={failureDescription(state.failure, 'GitHub did not return this file list.')}
      />
    );
  }

  const incomplete = incompleteDescription(
    state.incomplete,
    `GitHub returns at most ${String(GITHUB_CHANGED_FILES_CEILING_V1)} files for one pull request,`
    + ' and this one reached that limit. Open it on GitHub to see the rest.',
  );

  if (state.rows.length === 0) {
    return (
      <EmptyState
        title="No changed files"
        description="GitHub reports that this pull request changes no files."
      />
    );
  }

  return (
    <List
      accessibilityLabel="Files this pull request changes"
      sections={sections}
      keyForItem={(row) => row.path}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          {incomplete === null
            ? null
            : (
              // Known-incomplete is a rendered state, not a log line: a count
              // that stops at a round number with no explanation reads as a
              // defect in this product rather than a limit of GitHub's.
              <Banner tone="warning" title="This file list is incomplete" description={incomplete} />
            )}
        </Stack>
      )}
      footer={(
        <Stack gap="small">
          <Text variant="caption" tone="neutral">
            {state.omittedRowCount === 0
              ? `${String(state.rows.length)} changed file(s) read.`
              : `${String(state.rows.length)} changed file(s) read. ${String(state.omittedRowCount)} row(s) on the pages read could not be understood.`}
          </Text>
          {state.canLoadMore
            ? (
              <Button
                title="Load more files"
                variant="secondary"
                busy={state.pending}
                onPress={controller.loadMore}
              />
            )
            : null}
          <RefreshRow
            onRefresh={controller.refresh}
            pending={state.pending}
            accessibilityLabel="Re-read the changed files from GitHub"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <Item
          title={row.path}
          subtitle={changedFileSubtitle(row)}
          detail={changedFileDetail(row, locale)}
          tone={CHANGED_FILE_TONES[row.status] ?? 'neutral'}
          accessory={(
            <Row gap="small">
              <Action.Copy
                value={row.path}
                variant="plain"
                accessibilityLabel={`Copy the path ${row.path}`}
              />
              {row.webUrl === undefined
                ? null
                : (
                  <Action.OpenExternal
                    url={row.webUrl}
                    variant="plain"
                    accessibilityLabel={`Open ${row.path} on GitHub`}
                  />
                )}
            </Row>
          )}
        />
      )}
    />
  );
}

/* ----------------------------------------------------------------------- Checks */

function checkTone(row: GithubProjectedCheckRowV1): 'success' | 'danger' | 'warning' | 'neutral' {
  if (row.status !== 'completed') return 'warning';
  if (row.conclusion === undefined) return 'neutral';
  return row.conclusion === 'success' ? 'success' : 'danger';
}

function checksRollup(view: GithubChecksViewV1): readonly MetadataEntry[] {
  // A count is shown only where the source could compute one over a suite it
  // fully read. Rendering `0 failing` for a suite nobody could read would be a
  // fabricated fact, so the entry is absent instead.
  return [
    ...(view.failingCount === undefined
      ? []
      : [{ label: 'Failing', value: String(view.failingCount) }]),
    ...(view.runningCount === undefined
      ? []
      : [{ label: 'Running', value: String(view.runningCount) }]),
    ...(view.passingCount === undefined
      ? []
      : [{ label: 'Passing', value: String(view.passingCount) }]),
  ];
}

function ChecksBody({
  view,
  locale,
  nowMs,
  onRefresh,
}: Readonly<{
  view: GithubChecksViewV1;
  locale: string;
  nowMs: number;
  onRefresh: () => void;
}>): React.ReactElement {
  const rollup = checksRollup(view);
  const failures = [
    ...(view.checkRunsFailure === undefined
      ? []
      : [{ label: 'Check runs', failure: view.checkRunsFailure }]),
    ...(view.commitStatusFailure === undefined
      ? []
      : [{ label: 'Commit statuses', failure: view.commitStatusFailure }]),
  ];

  return (
    <List
      accessibilityLabel="Checks GitHub reports for this pull request"
      items={view.rows}
      keyForItem={(row) => row.key}
      header={(
        <Stack gap="small">
          {failures.length === 0
            ? null
            : (
              <Banner
                tone="warning"
                title="One check surface could not be read"
                description={failures
                  .map((entry) => `${entry.label}: ${entry.failure.code}`)
                  .join(' · ')}
              />
            )}
          {view.state !== 'knownIncomplete'
            ? null
            : (
              <Banner
                tone="warning"
                title="This check suite is larger than GitHub will list"
                description="The rows below are real, but they are not the whole suite."
              />
            )}
          {rollup.length === 0 ? null : <Metadata title="At this head" entries={rollup} />}
          <Text variant="caption" tone="neutral">
            {`Read against ${view.headRevision.slice(0, 7)}.`}
          </Text>
        </Stack>
      )}
      empty={(
        // `none` and `unknown` are different answers and never render alike.
        view.state === 'unknown'
          ? (
            <ErrorState
              title="The checks could not be determined"
              description="GitHub did not answer for this commit, so nothing here says the checks passed."
            />
          )
          : (
            <EmptyState
              title="No checks configured"
              description="No check run or commit status reports against this commit."
            />
          )
      )}
      footer={(
        <Stack gap="small">
          {view.omittedRowCount === 0
            ? null
            : (
              <Text variant="caption" tone="neutral">
                {`${String(view.omittedRowCount)} further check(s) are not listed.`}
              </Text>
            )}
          <RefreshRow
            onRefresh={onRefresh}
            pending={false}
            accessibilityLabel="Re-read the checks from GitHub"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <Item
          title={row.name}
          subtitle={row.conclusion ?? row.status}
          tone={checkTone(row)}
          {...(row.completedAtMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.completedAtMs, 'relative', nowMs) })}
          accessory={(
            <Row gap="small">
              <Action.Copy
                value={row.name}
                variant="plain"
                accessibilityLabel={`Copy the check name ${row.name}`}
              />
              {row.detailsUrl === undefined
                ? null
                : (
                  <Action.OpenExternal
                    url={row.detailsUrl}
                    variant="plain"
                    accessibilityLabel={`Open the ${row.name} results`}
                  />
                )}
            </Row>
          )}
        />
      )}
    />
  );
}

function ChecksPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const controller = useGithubChecks(input);
  const checks: GithubReadStateV1<GithubChecksViewV1> = controller.state;

  if (checks.kind === 'loading') {
    return <LoadingState title="Reading the checks from GitHub" />;
  }
  if (checks.kind === 'unavailable') {
    return (
      <ErrorState
        title="The checks are unavailable"
        description={failureDescription(
          checks.failure,
          'GitHub did not return the checks for this pull request.',
        )}
      />
    );
  }
  return (
    <ChecksBody
      view={checks.value}
      locale={locale}
      nowMs={nowMs}
      onRefresh={controller.refresh}
    />
  );
}

/* --------------------------------------------------------------------- Comments */

/**
 * The one sentence this panel owes its reader, every time it is shown.
 *
 * GitHub serves pull-request-level comments, line comments and review bodies as
 * separate resources with separate cursors. This panel reads the first of them,
 * and saying so is what keeps a reader from believing the conversation is empty
 * when it is only elsewhere.
 */
const COMMENT_SCOPE_DISCLOSURE
  = 'These are the comments on the entry itself. Review comments anchored to a line are a'
  + ' separate GitHub resource this build does not read.';

function commentHeadline(row: GithubProjectedCommentRowV1): string {
  const author = row.author ?? 'Someone';
  return row.editedAtMs === undefined ? author : `${author} · edited`;
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
  const controller = useGithubComments(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading this conversation from GitHub" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The conversation is unavailable"
        description={failureDescription(state.failure, 'GitHub did not return these comments.')}
      />
    );
  }

  const incomplete = incompleteDescription(state.incomplete, null);
  return (
    <List
      accessibilityLabel="Comments on this GitHub entry"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={(
        <Stack gap="small">
          <Text variant="caption" tone="neutral">{COMMENT_SCOPE_DISCLOSURE}</Text>
          <PageFailureBanner state={state} />
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No comments yet"
          description={COMMENT_SCOPE_DISCLOSURE}
        />
      )}
      footer={(
        <Stack gap="small">
          <Text variant="caption" tone="neutral">
            {state.omittedRowCount === 0
              ? `${String(state.rows.length)} comment(s) read.`
              : `${String(state.rows.length)} comment(s) read. ${String(state.omittedRowCount)} row(s) on the pages read could not be understood.`}
          </Text>
          {state.projectionTruncated
            ? (
              <Text variant="caption" tone="neutral">
                {'Some comments were shortened. Open the entry on GitHub to read them in full.'}
              </Text>
            )
            : null}
          {incomplete === null
            ? null
            : <Text variant="caption" tone="neutral">{incomplete}</Text>}
          {state.canLoadMore
            ? (
              <Button
                title="Load more comments"
                variant="secondary"
                busy={state.pending}
                onPress={controller.loadMore}
              />
            )
            : null}
          <RefreshRow
            onRefresh={controller.refresh}
            pending={state.pending}
            accessibilityLabel="Re-read this conversation from GitHub"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <Stack gap="small">
          <Row gap="small">
            <Text variant="caption">{commentHeadline(row)}</Text>
            {row.atMs === undefined
              ? null
              : (
                <Text variant="caption" tone="neutral">
                  {formatTimestamp(locale, row.atMs, 'relative', nowMs)}
                </Text>
              )}
            {row.webUrl === undefined
              ? null
              : (
                <Action.OpenExternal
                  url={row.webUrl}
                  variant="plain"
                  accessibilityLabel={`Open this comment on GitHub: ${commentHeadline(row)}`}
                />
              )}
          </Row>
          {row.body === ''
            ? (
              <Text variant="caption" tone="neutral">
                {'This comment carries no text.'}
              </Text>
            )
            : <Markdown value={row.body} />}
          <Divider />
        </Stack>
      )}
    />
  );
}

/* ---------------------------------------------------------------- Work Sessions */

/**
 * The issue composition's `Work Sessions` panel: the exact bounded projection the input
 * carried, rendered read-only. It performs no Session-store read and owns no Session.
 */
function WorkSessionsPanel({
  sessions,
}: Readonly<{ sessions: readonly TriageLinkedSessionProjectionV1[] }>): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No linked sessions"
        description="Sessions started from this issue will be listed here."
      />
    );
  }
  return (
    <List accessibilityLabel="Sessions linked to this GitHub issue">
      <ItemGroup>
        {sessions.map((session) => (
          <Item
            key={session.sessionId}
            title={session.displayTitle ?? session.sessionId}
            // A retained link whose Session summary is unavailable keeps its id and loses
            // only its display text. It is never presented as "never linked".
            subtitle={session.displayTitle === undefined
              ? 'Session details are unavailable'
              : undefined}
          />
        ))}
      </ItemGroup>
    </List>
  );
}

/* ------------------------------------------------------------------ detail body */

function GithubDetailBody({
  input,
  kindId,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
}>): React.ReactElement {
  const { locale } = useSurfaceContext();
  const [selected, setSelected] = React.useState<GithubDetailTabIdV1>(
    GITHUB_DEFAULT_DETAIL_TAB_V1,
  );
  // One render-time read, passed down as data, so no child owns a hidden clock.
  const nowMs = Date.now();
  const body = React.useMemo(() => projectGithubDetailBody(input), [input]);

  const visible = githubVisibleDetailTabs(kindId);
  const tab = githubResolveSelectedTab(selected, visible);

  const panels: Readonly<Record<GithubDetailTabIdV1, React.ReactNode>> = {
    overview: <OverviewPanel body={body} locale={locale} nowMs={nowMs} />,
    timeline: <TimelinePanel input={input} locale={locale} nowMs={nowMs} />,
    files: <FilesPanel input={input} locale={locale} />,
    checks: <ChecksPanel input={input} locale={locale} nowMs={nowMs} />,
    comments: <CommentsPanel input={input} locale={locale} nowMs={nowMs} />,
    'work-sessions': <WorkSessionsPanel sessions={body.linkedSessions} />,
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
        ariaLabel="GitHub entry detail"
      >
        {visible.map((declaration) => (
          <Tabs.Item
            key={declaration.id}
            value={declaration.id}
            title={declaration.title}
            // Stated, never inherited: the shared primitive would otherwise discard a panel
            // this source means to keep, or keep one it means to discard.
            retention={declaration.retention}
            {...(declaration.id === 'work-sessions' && body.linkedSessions.length > 0
              ? { badge: String(body.linkedSessions.length) }
              : {})}
          >
            {panels[declaration.id]}
          </Tabs.Item>
        ))}
      </Tabs>
    </Screen>
  );
}

function GithubDetailSurface(context: RenderContext): React.ReactElement {
  const admitted = React.useMemo(() => {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
    if (!parsed.success) return { ok: false as const };
    const kindId = readGithubTriageKindId(parsed.data.observation.entryRef.kindId);
    // A kind this source never declared cannot select a composition, and guessing
    // one would render a pull request's panels over an entry that is not one.
    return kindId === null
      ? { ok: false as const }
      : { ok: true as const, input: parsed.data, kindId };
  }, [context.launchInput]);

  if (!admitted.ok) {
    return (
      <Screen safeArea>
        <ErrorState
          title="This entry cannot be shown"
          description="Triage supplied a detail input this GitHub build does not accept."
        />
      </Screen>
    );
  }

  return <GithubDetailBody input={admitted.input} kindId={admitted.kindId} />;
}

/**
 * The exact export name the build target's Module Federation identity names. Renaming it breaks
 * the native artifact contract, not just this file.
 */
export const renderSurface = defineUiSurface(GithubDetailSurface);
