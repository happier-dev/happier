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
  usePluginTranslation,
  useSurfaceContext,
  type MetadataEntry,
} from '@happier-dev/plugin-ui';
import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
  type TriageLinkedSessionProjectionV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
// The presentation rules used below are projections of the Triage contract's own
// closed fact and failure vocabularies, so they are consumed from the one published
// owner rather than re-spelled here: six copies is how one declared `compact` number
// could start meaning two things in one list. They are aliased to this file's local
// vocabulary so the call sites read as the panel language they already are.
import {
  describeTriageSourceFailureV1 as failureDescription,
  formatTriageTimestampV1 as formatTimestamp,
  projectTriageDetailFieldTextV1 as fieldValueText,
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
  const text = usePluginTranslation();
  if (state.failure === null) return null;
  return (
    <Banner
      tone="warning"
      title="Showing what was read so far"
      titleKey="plugins.gitlab.ui.partial"
      description={failureDescription(
        state.failure,
        text('plugins.gitlab.ui.readFailed', 'GitLab could not complete this read.'),
      )}
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
  accessibilityLabelKey,
}: Readonly<{
  onRefresh: () => void;
  /** A walk already in flight; the control stays mounted and inert rather than vanishing. */
  pending: boolean;
  accessibilityLabel: string;
  accessibilityLabelKey?: string;
}>): React.ReactElement {
  return (
    <Row gap="small">
      <Action.Refresh
        onRefresh={onRefresh}
        disabled={pending}
        variant="plain"
        accessibilityLabel={accessibilityLabel}
        accessibilityLabelKey={accessibilityLabelKey}
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
  summaryKey,
  summaryValues,
}: Readonly<{
  state: GitlabPagedStateV1<unknown>;
  loadMoreTitle: string;
  onLoadMore: () => void;
  onRefresh: () => void;
  refreshLabel: string;
  summary: string;
  summaryKey: string;
  summaryValues: Readonly<Record<string, string | number>>;
}>): React.ReactElement {
  const incomplete = incompleteDescription(state.incomplete);
  return (
    <Stack gap="small">
      <Text variant="caption" tone="neutral" valueKey={summaryKey} fallback={summary} values={summaryValues} />
      {state.omittedRowCount === 0 ? null : (
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.gitlab.ui.rowsUnreadable"
          fallback="{count} row(s) on the pages read could not be understood."
          values={{ count: state.omittedRowCount }}
        />
      )}
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
          ? <EmptyState title="No projected facts" titleKey="plugins.gitlab.ui.noFacts" description="This observation carried no displayable GitLab facts." descriptionKey="plugins.gitlab.ui.noFacts.description" />
          : <Metadata title="GitLab" titleKey="plugins.gitlab.ui.facts" entries={entries} />}
        {pendingFields.length === 0 ? null : (
          <Stack gap="small">
            <Text
              variant="caption"
              tone="neutral"
              valueKey="plugins.gitlab.ui.pendingPanels.description"
              fallback="Answered in the panels beside this one, not on the list row:"
            />
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
  const text = usePluginTranslation();
  const controller = useGitlabActivityEvents(input, source);
  const { state } = controller;
  const title = EVENT_SOURCE_TITLES[source] ?? source;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <LoadingState
        title={text('plugins.gitlab.ui.readingCollection', 'Reading {collection} from GitLab', {
          collection: title.toLowerCase(),
        })}
      />
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title={text('plugins.gitlab.ui.collectionUnavailable', '{collection} are unavailable', {
          collection: title,
        })}
        description={failureDescription(
          state.failure,
          text('plugins.gitlab.ui.readFailed', 'GitLab could not complete this read.'),
        )}
      />
    );
  }
  return (
    <List
      accessibilityLabel={text(
        'plugins.gitlab.ui.collectionLabel',
        '{collection} GitLab recorded for this entry',
        { collection: title },
      )}
      items={state.rows}
      keyForItem={(row) => `${row.source}:${row.id}`}
      header={<PageFailureBanner state={state} />}
      empty={(
        <EmptyState
          title={`No ${title.toLowerCase()}`}
          description="GitLab has recorded none of these events for this entry yet."
          descriptionKey="plugins.gitlab.ui.noEvents.description"
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
          summaryKey="plugins.gitlab.ui.eventsRead"
          summaryValues={{ count: state.rows.length }}
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
  accessibilityLabelKey,
  emptyTitle,
  emptyDescription,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
  accessibilityLabel: string;
  accessibilityLabelKey: string;
  emptyTitle: string;
  emptyDescription: string;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller: GitlabPagedControllerV1<GitlabProjectedNoteRowV1> = useGitlabNotes(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading notes from GitLab" titleKey="plugins.gitlab.ui.readingNotes" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The notes are unavailable"
        titleKey="plugins.gitlab.ui.notesUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.gitlab.ui.readFailed', 'GitLab could not complete this read.'),
        )}
      />
    );
  }
  return (
    <List
      accessibilityLabel={accessibilityLabel}
      accessibilityLabelKey={accessibilityLabelKey}
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
          summaryKey="plugins.gitlab.ui.notesRead"
          summaryValues={{ count: state.rows.length }}
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
          accessibilityLabelKey="plugins.gitlab.ui.notesLabel"
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
      accessibilityLabelKey="plugins.gitlab.ui.commentsLabel"
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
  const text = usePluginTranslation();
  const controller = useGitlabChanges(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the changed files from GitLab" titleKey="plugins.gitlab.ui.readingFiles" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The changed files are unavailable"
        titleKey="plugins.gitlab.ui.filesUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.gitlab.ui.readFailed', 'GitLab could not complete this read.'),
        )}
      />
    );
  }
  return (
    <List
      accessibilityLabel="Files this GitLab merge request changes"
      accessibilityLabelKey="plugins.gitlab.ui.filesLabel"
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
                titleKey="plugins.gitlab.ui.diffLimitUnknown"
                description="This deployment did not say whether it left any file out, so this list is not a claim that the diff is whole."
                descriptionKey="plugins.gitlab.ui.diffLimitUnknown.description"
              />
            )}
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No changed files"
          titleKey="plugins.gitlab.ui.noFiles"
          description="GitLab reports that this merge request changes no files."
          descriptionKey="plugins.gitlab.ui.noFiles.description"
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
          summaryKey="plugins.gitlab.ui.filesRead"
          summaryValues={{ count: state.rows.length }}
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
              accessibilityLabel={text('plugins.gitlab.ui.copyValue', 'Copy {item}', {
                item: row.path,
              })}
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
  const text = usePluginTranslation();
  const controller = useGitlabPipelines(input);
  const { rollup, state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the pipelines from GitLab" titleKey="plugins.gitlab.ui.readingPipelines" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The pipelines are unavailable"
        titleKey="plugins.gitlab.ui.pipelinesUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.gitlab.ui.readFailed', 'GitLab could not complete this read.'),
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
      accessibilityLabelKey="plugins.gitlab.ui.pipelinesLabel"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          {rollupEntries.length > 0
            ? <Metadata title="Newest pipeline jobs" titleKey="plugins.gitlab.ui.newestPipelineJobs" entries={rollupEntries} />
            : state.rows.length === 0
              ? null
              : (
                // `no breakdown` and `nothing failing` are different answers, and
                // a rendered `0 failing` over a job list nobody could read is the
                // fabrication a reviewer acts on.
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.gitlab.ui.pipelineJobsUnavailable.description"
                fallback="GitLab did not return a per-job breakdown for the newest pipeline, so no job counts are shown."
              />
              )}
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No pipelines"
          titleKey="plugins.gitlab.ui.noPipelines"
          description="GitLab has run no pipeline for this merge request."
          descriptionKey="plugins.gitlab.ui.noPipelines.description"
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
          summaryKey="plugins.gitlab.ui.pipelinesRead"
          summaryValues={{ count: state.rows.length }}
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
                  accessibilityLabel={text(
                    'plugins.gitlab.ui.openOnGitlab',
                    'Open {item} on GitLab',
                    { item: row.id },
                  )}
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
  const text = usePluginTranslation();
  const controller = useGitlabApprovals(input);
  const state: GitlabReadStateV1<GitlabApprovalsViewV1> = controller.state;

  if (state.kind === 'loading') {
    return <LoadingState title="Reading the approvals from GitLab" titleKey="plugins.gitlab.ui.readingApprovals" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The approvals are unavailable"
        titleKey="plugins.gitlab.ui.approvalsUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.gitlab.ui.readFailed', 'GitLab could not complete this read.'),
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
      <Metadata title="Approvals" titleKey="plugins.gitlab.ui.approvals" entries={entries} />
      {view.rules.kind === 'available'
        ? (
          <Metadata
            title="Approval rules"
            titleKey="plugins.gitlab.ui.approvalRules"
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
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.gitlab.ui.approvalRulesUnavailable.description"
                fallback="Approval rules are a paid GitLab tier feature and are not available on this deployment. The approval state above is complete."
              />
          )
          : (
            <Banner
              tone="warning"
              title="The approval rules could not be read"
              titleKey="plugins.gitlab.ui.approvalRulesUnavailable"
        description={failureDescription(
          view.rules.failure,
          text('plugins.gitlab.ui.readFailed', 'GitLab could not complete this read.'),
        )}
            />
          )}
      <RefreshRow
        onRefresh={controller.refresh}
        pending={false}
        accessibilityLabel="Re-read the approvals from GitLab"
        accessibilityLabelKey="plugins.gitlab.ui.rereadApprovals"
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
  const text = usePluginTranslation();
  const controller = useGitlabDiscussions(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the discussions from GitLab" titleKey="plugins.gitlab.ui.readingDiscussions" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The discussions are unavailable"
        titleKey="plugins.gitlab.ui.discussionsUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.gitlab.ui.readFailed', 'GitLab could not complete this read.'),
        )}
      />
    );
  }
  return (
    <List
      accessibilityLabel="Review discussions on this GitLab merge request"
      accessibilityLabelKey="plugins.gitlab.ui.discussionsLabel"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={<PageFailureBanner state={state} />}
      empty={(
        <EmptyState
          title="No discussions"
          titleKey="plugins.gitlab.ui.noDiscussions"
          description="Nobody has opened a review discussion on this merge request yet."
          descriptionKey="plugins.gitlab.ui.noDiscussions.description"
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
          summaryKey="plugins.gitlab.ui.discussionsRead"
          summaryValues={{ count: state.rows.length }}
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
        titleKey="plugins.gitlab.ui.noSessions"
        description="Sessions started from this issue will be listed here."
        descriptionKey="plugins.gitlab.ui.noSessions.description"
      />
    );
  }
  return (
    <List accessibilityLabel="Sessions linked to this GitLab issue" accessibilityLabelKey="plugins.gitlab.ui.sessionsLabel">
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
          titleKey="plugins.gitlab.ui.invalidInput"
          description="Triage supplied a detail input this GitLab build does not accept."
          descriptionKey="plugins.gitlab.ui.invalidInput.description"
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
