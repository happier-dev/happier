/**
 * The GitLab Triage detail surface artifact entry.
 *
 * Triage mounts this renderer inside its own detail pane and hands it exactly one value: the
 * published `TriageDetailSurfaceInputV1` launch input. This file admits that value through the
 * published closed schema rather than casting it — a mount that hands over something else is a
 * contract break the surface reports, not one it renders around.
 *
 * It begins directly below Triage's permanently mounted common header and renders none of that
 * header's facts. The title, kind, state, scope, provider link, attention and Session
 * relationship belong to the aggregate (`CONTRACT.md` §7, `core/SURFACE.md` §2.2); repeating them
 * here is a second renderer of one header, and the copy that drifts is the one the user is
 * looking at.
 *
 * What it does own are GitLab's own facts: the note/event activity of an item, the files a merge
 * request changes, its pipelines, and its review discussions and approval state. Every one of them
 * is a real read with its own lifetime, issued when its tab becomes active and never on mount —
 * GitLab involvement scanning already spends real provider budget, and the Activity panel alone
 * owns four independent walks.
 *
 * Two compositions, not one with disabled entries. A merge request shows `Overview · Activity ·
 * Changes · Pipelines · Reviews`; an issue shows `Overview · Activity · Comments · Work Sessions`.
 * An issue has no pipelines at all, and an empty Pipelines tab would state that nothing ran.
 *
 * Diffs are not rendered here. The rich diff body is held at the shared component catalog under
 * `B6`, so the Changes panel presents the changed-file LIST through the approved `List` family
 * with GitLab's own per-file truncation evidence. It neither wraps an app-private diff component
 * nor invents a partial one.
 */

import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Action,
  Badge,
  Banner,
  Button,
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

import { readGitlabTriageKindId } from '../triage/contribution.js';
import type {
  GitlabProjectedActivityEventRowV1,
  GitlabProjectedChangedFileRowV1,
  GitlabProjectedDiscussionRowV1,
  GitlabProjectedNoteRowV1,
  GitlabProjectedPipelineRowV1,
} from '../triage/detail/projection.js';
import { GITLAB_ACTIVITY_EVENT_SOURCES_V1 } from '../triage/detail/routes.js';
import type { GitlabKindId } from '../triage/types.js';

import {
  projectGitlabDetailBody,
  type GitlabDetailBodyV1,
  type GitlabDetailFieldV1,
} from './detail/model.js';
import {
  useGitlabActivityEvents,
  useGitlabApprovals,
  useGitlabChanges,
  useGitlabDiscussions,
  useGitlabNotes,
  useGitlabPipelines,
  type GitlabApprovalsViewV1,
  type GitlabPagedControllerV1,
} from './detail/panelReaders.js';
import type { GitlabPagedStateV1, GitlabReadStateV1 } from './detail/panelState.js';
import {
  GITLAB_DEFAULT_DETAIL_TAB_V1,
  gitlabResolveSelectedTab,
  gitlabVisibleDetailTabs,
  type GitlabDetailTabIdV1,
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
  field: GitlabDetailFieldV1,
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
 * The sentence a walk owes its reader when it stopped without finishing.
 *
 * GitLab documents no collection ceiling on these resources, so the only reason a walk here stops
 * short is a next page this build refused to follow — and it says exactly that rather than
 * inventing a provider cap.
 */
function incompleteDescription(incomplete: 'pagination' | null): string | null {
  return incomplete === null
    ? null
    : 'GitLab offered another page in a form this build will not follow, so this list stops here.';
}

/**
 * The banner a later-page failure owes its reader.
 *
 * It appears only over rows that already arrived. A first-page failure is a different
 * presentation entirely — the panel says it could not look.
 */
function PageFailureBanner({
  state,
}: Readonly<{ state: GitlabPagedStateV1<unknown> }>): React.ReactElement | null {
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
 * GitLab rate budget for a reader who is not looking at it.
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

/** The footer every paged panel shares: what was read, what was not, and how to ask for more. */
function PagedFooter({
  state,
  loadMoreTitle,
  onLoadMore,
  onRefresh,
  refreshLabel,
  summary,
}: Readonly<{
  state: GitlabPagedStateV1<unknown>;
  loadMoreTitle: string;
  onLoadMore: () => void;
  onRefresh: () => void;
  refreshLabel: string;
  summary: string;
}>): React.ReactElement {
  const incomplete = incompleteDescription(state.incomplete);
  return (
    <Stack gap="small">
      <Text variant="caption" tone="neutral">
        {state.omittedRowCount === 0
          ? summary
          : `${summary} ${String(state.omittedRowCount)} row(s) on the pages read could not be understood.`}
      </Text>
      {incomplete === null ? null : <Text variant="caption" tone="neutral">{incomplete}</Text>}
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
      <RefreshRow onRefresh={onRefresh} pending={state.pending} accessibilityLabel={refreshLabel} />
    </Stack>
  );
}

/* --------------------------------------------------------------------- Overview */

function OverviewPanel({
  body,
  locale,
  nowMs,
}: Readonly<{
  body: GitlabDetailBodyV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const statusFields = body.fields.filter(
    (field): field is Extract<GitlabDetailFieldV1, { kind: 'status' }> => field.kind === 'status',
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
          ? <EmptyState title="No projected facts" description="This observation carried no displayable GitLab facts." />
          : <Metadata title="GitLab" entries={entries} />}
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

/* --------------------------------------------------------------------- Activity */

/**
 * GitLab serves a state change as a "system note" on the notes collection AND as a typed row on
 * its resource-event collections. The reader is told which it is looking at, because a system
 * note rendered as somebody's remark reads as a person saying "added label bug".
 */
function noteHeadline(row: GitlabProjectedNoteRowV1): string {
  const author = row.author ?? 'Someone';
  const base = row.system ? `${author} · activity` : author;
  return row.editedAtMs === undefined ? base : `${base} · edited`;
}

const EVENT_SOURCE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  state: 'State changes',
  label: 'Label changes',
  milestone: 'Milestone changes',
});

function eventHeadline(row: GitlabProjectedActivityEventRowV1): string {
  const actor = row.actor === undefined ? '' : ` · ${row.actor}`;
  const subject = row.subject === undefined ? '' : ` ${row.subject}`;
  return `${row.action}${subject}${actor}`;
}

/**
 * One event source's own list, with its own cursor and its own control.
 *
 * The three sources are rendered as three regions rather than merged into one, because their
 * cursors are independent: one `Show more` that advanced all three would silently skip rows in the
 * two the reader did not ask about, and GitLab's Discussions/events APIs document no shared
 * temporal order to merge them by.
 */
function ActivityEventSection({
  input,
  source,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  source: (typeof GITLAB_ACTIVITY_EVENT_SOURCES_V1)[number];
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const controller = useGitlabActivityEvents(input, source);
  const { state } = controller;
  const title = EVENT_SOURCE_TITLES[source] ?? source;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title={`Reading ${title.toLowerCase()} from GitLab`} />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title={`${title} are unavailable`}
        description={failureDescription(state.failure, 'GitLab did not return these events.')}
      />
    );
  }
  return (
    <List
      accessibilityLabel={`${title} GitLab recorded for this entry`}
      items={state.rows}
      keyForItem={(row) => `${row.source}:${row.id}`}
      header={<PageFailureBanner state={state} />}
      empty={(
        <EmptyState
          title={`No ${title.toLowerCase()}`}
          description="GitLab has recorded none of these events for this entry yet."
        />
      )}
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle={`Show more ${title.toLowerCase()}`}
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel={`Re-read ${title.toLowerCase()} from GitLab`}
          summary={`${String(state.rows.length)} event(s) read.`}
        />
      )}
      renderItem={(row) => (
        <Item
          title={eventHeadline(row)}
          {...(row.atMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.atMs, 'relative', nowMs) })}
        />
      )}
    />
  );
}

function NotesSection({
  input,
  locale,
  nowMs,
  accessibilityLabel,
  emptyTitle,
  emptyDescription,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
  accessibilityLabel: string;
  emptyTitle: string;
  emptyDescription: string;
}>): React.ReactElement {
  const controller: GitlabPagedControllerV1<GitlabProjectedNoteRowV1> = useGitlabNotes(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading notes from GitLab" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The notes are unavailable"
        description={failureDescription(state.failure, 'GitLab did not return these notes.')}
      />
    );
  }
  return (
    <List
      accessibilityLabel={accessibilityLabel}
      items={state.rows}
      keyForItem={(row) => row.id}
      header={<PageFailureBanner state={state} />}
      empty={<EmptyState title={emptyTitle} description={emptyDescription} />}
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle="Show earlier notes"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read these notes from GitLab"
          summary={`${String(state.rows.length)} note(s) read.`}
        />
      )}
      renderItem={(row) => (
        <Item
          title={noteHeadline(row)}
          {...(row.body === '' ? {} : { subtitle: row.body })}
          {...(row.atMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.atMs, 'relative', nowMs) })}
        />
      )}
    />
  );
}

/**
 * The activity composition: the notes walk plus one region per resource-event source.
 *
 * Reading only notes loses every state change, and reading only events loses the conversation.
 * Both are read, and each keeps its own cursor.
 */
function ActivityPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  return (
    <ScrollArea>
      <Stack gap="large">
        <NotesSection
          input={input}
          locale={locale}
          nowMs={nowMs}
          accessibilityLabel="Notes GitLab recorded for this entry"
          emptyTitle="No notes"
          emptyDescription="GitLab has recorded no notes on this entry yet."
        />
        {GITLAB_ACTIVITY_EVENT_SOURCES_V1.map((source) => (
          <ActivityEventSection
            key={source}
            input={input}
            source={source}
            locale={locale}
            nowMs={nowMs}
          />
        ))}
      </Stack>
    </ScrollArea>
  );
}

/* --------------------------------------------------------------------- Comments */

function CommentsPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  return (
    <NotesSection
      input={input}
      locale={locale}
      nowMs={nowMs}
      accessibilityLabel="Comments on this GitLab issue"
      emptyTitle="No comments"
      emptyDescription="Nobody has commented on this issue yet."
    />
  );
}

/* ---------------------------------------------------------------------- Changes */

function changedFileSubtitle(row: GitlabProjectedChangedFileRowV1): string {
  if (row.tooLarge === true) return 'Too large for GitLab to return a diff.';
  if (row.collapsed === true) return 'GitLab collapsed this file; it can be fetched on request.';
  if (row.deletedFile) return 'Deleted';
  if (row.newFile) return 'Added';
  if (row.renamedFile && row.previousPath !== undefined) return `Renamed from ${row.previousPath}`;
  return 'Modified';
}

function ChangesPanel({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const controller = useGitlabChanges(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the changed files from GitLab" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The changed files are unavailable"
        description={failureDescription(
          state.failure,
          'GitLab did not return the files this merge request changes.',
        )}
      />
    );
  }
  return (
    <List
      accessibilityLabel="Files this GitLab merge request changes"
      items={state.rows}
      keyForItem={(row) => row.path}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          {controller.diffLimitStatus === 'reported'
            ? null
            : (
              // The prohibition that matters: a diff whose completeness GitLab
              // did not state is never rendered as a complete one.
              <Banner
                tone="warning"
                title="Diff-limit status unknown"
                description="This deployment did not say whether it left any file out, so this list is not a claim that the diff is whole."
              />
            )}
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No changed files"
          description="GitLab reports that this merge request changes no files."
        />
      )}
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle="Show more files"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read the changed files from GitLab"
          summary={`${String(state.rows.length)} file(s) read.`}
        />
      )}
      renderItem={(row) => (
        <Item
          title={row.path}
          subtitle={changedFileSubtitle(row)}
          accessory={(
            <Action.Copy
              value={row.path}
              variant="plain"
              accessibilityLabel={`Copy the path ${row.path}`}
            />
          )}
        />
      )}
    />
  );
}

/* -------------------------------------------------------------------- Pipelines */

function pipelineTone(row: GitlabProjectedPipelineRowV1): 'success' | 'danger' | 'warning' | 'neutral' {
  if (row.status === 'success') return 'success';
  if (row.status === 'failed') return 'danger';
  if (row.status === 'running' || row.status === 'pending') return 'warning';
  return 'neutral';
}

function PipelinesPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const controller = useGitlabPipelines(input);
  const { rollup, state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the pipelines from GitLab" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The pipelines are unavailable"
        description={failureDescription(
          state.failure,
          'GitLab did not return the pipelines of this merge request.',
        )}
      />
    );
  }

  // Every count is present or every count is absent. A partial rollup would be a
  // number the reader cannot interpret, and a zeroed one is a number they trust.
  const rollupEntries: readonly MetadataEntry[] = rollup.failingCount === undefined
    ? []
    : [
      { label: 'Failing', value: String(rollup.failingCount) },
      { label: 'Running', value: String(rollup.runningCount ?? 0) },
      { label: 'Passing', value: String(rollup.passingCount ?? 0) },
    ];

  return (
    <List
      accessibilityLabel="Pipelines GitLab ran for this merge request"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          {rollupEntries.length > 0
            ? <Metadata title="Newest pipeline jobs" entries={rollupEntries} />
            : state.rows.length === 0
              ? null
              : (
                // `no breakdown` and `nothing failing` are different answers, and
                // a rendered `0 failing` over a job list nobody could read is the
                // fabrication a reviewer acts on.
                <Text variant="caption" tone="neutral">
                  {'GitLab did not return a per-job breakdown for the newest pipeline, so no job counts are shown.'}
                </Text>
              )}
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No pipelines"
          description="GitLab has run no pipeline for this merge request."
        />
      )}
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle="Show older pipelines"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read the pipelines from GitLab"
          summary={`${String(state.rows.length)} pipeline(s) read.`}
        />
      )}
      renderItem={(row) => (
        <Item
          title={`#${row.id} · ${row.status}`}
          {...(row.ref === undefined ? {} : { subtitle: row.ref })}
          tone={pipelineTone(row)}
          {...(row.updatedAtMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.updatedAtMs, 'relative', nowMs) })}
          {...(row.webUrl === undefined
            ? {}
            : {
              accessory: (
                <Action.OpenExternal
                  url={row.webUrl}
                  variant="plain"
                  accessibilityLabel={`Open pipeline ${row.id} on GitLab`}
                />
              ),
            })}
        />
      )}
    />
  );
}

/* ---------------------------------------------------------------------- Reviews */

/**
 * The approval half of the Reviews tab.
 *
 * Approve is `Tier: Free, Premium, Ultimate`. Only the rule-aware detail is Premium, so a Free
 * account sees working approval state with one explanatory line — not a tab that reports the whole
 * feature as unavailable, which is what a coarse "approvals are Premium" reading would produce.
 */
function ApprovalsSection({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const controller = useGitlabApprovals(input);
  const state: GitlabReadStateV1<GitlabApprovalsViewV1> = controller.state;

  if (state.kind === 'loading') {
    return <LoadingState title="Reading the approvals from GitLab" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The approvals are unavailable"
        description={failureDescription(
          state.failure,
          'GitLab did not return the approval state of this merge request.',
        )}
      />
    );
  }

  const view = state.value;
  const entries: readonly MetadataEntry[] = [
    ...(view.approvalsRequired === undefined
      ? []
      : [{ label: 'Required', value: String(view.approvalsRequired) }]),
    ...(view.approvalsLeft === undefined
      ? []
      : [{ label: 'Still needed', value: String(view.approvalsLeft) }]),
    ...(view.approvedBy.length === 0
      ? []
      : [{ label: 'Approved by', value: view.approvedBy.join(', ') }]),
    ...(view.userHasApproved === undefined
      ? []
      : [{ label: 'You approved', value: view.userHasApproved ? 'Yes' : 'No' }]),
  ];

  return (
    <Stack gap="small">
      <Metadata title="Approvals" entries={entries} />
      {view.rules.kind === 'available'
        ? (
          <Metadata
            title="Approval rules"
            entries={view.rules.rules.map((rule) => ({
              label: rule.name,
              value: rule.approved === true
                ? 'Satisfied'
                : rule.approvalsRequired === undefined
                  ? 'Not satisfied'
                  : `${String(rule.approvalsRequired)} required`,
            }))}
          />
        )
        : view.rules.kind === 'editionUnsupported'
          ? (
            <Text variant="caption" tone="neutral">
              {'Approval rules are a paid GitLab tier feature and are not available on this deployment. The approval state above is complete.'}
            </Text>
          )
          : (
            <Banner
              tone="warning"
              title="The approval rules could not be read"
              description={failureDescription(view.rules.failure, 'GitLab did not answer.')}
            />
          )}
      <RefreshRow
        onRefresh={controller.refresh}
        pending={false}
        accessibilityLabel="Re-read the approvals from GitLab"
      />
    </Stack>
  );
}

function discussionHeadline(row: GitlabProjectedDiscussionRowV1): string {
  const first = row.notes[0];
  const author = first?.author ?? 'Someone';
  return row.individualNote ? `${author} · comment` : `${author} · thread`;
}

/**
 * Each discussion opens its latest four returned notes.
 *
 * The window is client-local over the notes the boundary already published: GitLab documents no
 * per-discussion note cursor, so inventing a nested HTTP page would be a request nobody offered.
 */
const DISCUSSION_REPLY_WINDOW = 4;

function discussionSubtitle(row: GitlabProjectedDiscussionRowV1): string {
  const shown = row.notes.slice(-DISCUSSION_REPLY_WINDOW);
  const earlier = row.notes.length - shown.length;
  const bodies = shown.map((note) => note.body).filter((body) => body !== '').join(' — ');
  const omitted = row.omittedNoteCount === 0
    ? ''
    : ` (${String(row.omittedNoteCount)} further reply/replies were not published)`;
  return earlier === 0
    ? `${bodies}${omitted}`
    : `${String(earlier)} earlier reply/replies · ${bodies}${omitted}`;
}

function DiscussionsSection({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const controller = useGitlabDiscussions(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the discussions from GitLab" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The discussions are unavailable"
        description={failureDescription(state.failure, 'GitLab did not return these discussions.')}
      />
    );
  }
  return (
    <List
      accessibilityLabel="Review discussions on this GitLab merge request"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={<PageFailureBanner state={state} />}
      empty={(
        <EmptyState
          title="No discussions"
          description="Nobody has opened a review discussion on this merge request yet."
        />
      )}
      footer={(
        <PagedFooter
          state={state}
          // Deliberately not "earlier": the Discussions API documents pagination
          // but no temporal order control, so claiming the next page is older
          // would be a fact this product invented.
          loadMoreTitle="Show more discussions"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read the discussions from GitLab"
          summary={`${String(state.rows.length)} discussion(s) read.`}
        />
      )}
      renderItem={(row) => (
        <Item title={discussionHeadline(row)} subtitle={discussionSubtitle(row)} />
      )}
    />
  );
}

function ReviewsPanel({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  return (
    <ScrollArea>
      <Stack gap="large">
        <ApprovalsSection input={input} />
        <DiscussionsSection input={input} />
      </Stack>
    </ScrollArea>
  );
}

/* ----------------------------------------------------------------- Work Sessions */

/**
 * The issue composition's `Work Sessions` panel: the exact bounded projection the input carried,
 * rendered read-only. It performs no Session-store read and owns no Session.
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
    <List accessibilityLabel="Sessions linked to this GitLab issue">
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

function GitlabDetailBody({
  input,
  kindId,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GitlabKindId;
}>): React.ReactElement {
  const { locale } = useSurfaceContext();
  const [selected, setSelected] = React.useState<GitlabDetailTabIdV1>(
    GITLAB_DEFAULT_DETAIL_TAB_V1,
  );
  // One render-time read, passed down as data, so no child owns a hidden clock.
  const nowMs = Date.now();
  const body = React.useMemo(() => projectGitlabDetailBody(input), [input]);

  const visible = gitlabVisibleDetailTabs(kindId);
  const tab = gitlabResolveSelectedTab(selected, visible);

  const panels: Readonly<Record<GitlabDetailTabIdV1, React.ReactNode>> = {
    overview: <OverviewPanel body={body} locale={locale} nowMs={nowMs} />,
    activity: <ActivityPanel input={input} locale={locale} nowMs={nowMs} />,
    changes: <ChangesPanel input={input} />,
    pipelines: <PipelinesPanel input={input} locale={locale} nowMs={nowMs} />,
    reviews: <ReviewsPanel input={input} />,
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
        ariaLabel="GitLab entry detail"
      >
        {visible.map((declaration) => (
          <Tabs.Item
            key={declaration.id}
            value={declaration.id}
            title={declaration.title}
            // Stated, never inherited: the shared primitive would otherwise discard a panel this
            // source means to keep, or keep one it means to discard.
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

function GitlabDetailSurface(context: RenderContext): React.ReactElement {
  const admitted = React.useMemo(() => {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
    if (!parsed.success) return { ok: false as const };
    const kindId = readGitlabTriageKindId(parsed.data.observation.entryRef.kindId);
    // A kind this source never declared cannot select a composition, and guessing one would render
    // a merge request's panels over an entry that is not one.
    return kindId === null
      ? { ok: false as const }
      : { ok: true as const, input: parsed.data, kindId };
  }, [context.launchInput]);

  if (!admitted.ok) {
    return (
      <Screen safeArea>
        <ErrorState
          title="This entry cannot be shown"
          description="Triage supplied a detail input this GitLab build does not accept."
        />
      </Screen>
    );
  }

  return <GitlabDetailBody input={admitted.input} kindId={admitted.kindId} />;
}

/**
 * The exact export name the build target's Module Federation identity names. Renaming it breaks
 * the native artifact contract, not just this file.
 */
export const renderSurface = defineUiSurface(GitlabDetailSurface);
