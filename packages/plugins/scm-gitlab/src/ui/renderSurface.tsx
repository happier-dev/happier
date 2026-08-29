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
 * Rich structured diffs are not rendered here. The rich diff body is held at the shared component
 * catalog under `B6`, so the Changes panel presents the changed-file LIST through the approved
 * `List` family with GitLab's own per-file truncation evidence. GitLab's separate raw-text evidence
 * is shown only after an explicit user request; it neither wraps an app-private diff component nor
 * pretends that raw text is the structured file model.
 */

import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { createReviewCommentLinkedIssueIdV1 } from '@happier-dev/plugin-sdk/reviews';
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
  useExecutePluginAction,
  useReviewCommentProposalsForEntry,
  useSurfaceContext,
  type PluginTranslate,
  type ReviewCommentProposalReadV1,
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
  useGitlabRawDiff,
  type GitlabApprovalsViewV1,
  type GitlabPagedControllerV1,
} from './detail/panelReaders.js';
import type { GitlabPagedStateV1, GitlabReadStateV1 } from './detail/panelState.js';
import { GitlabDiscussionResolutionControl, GitlabMutationControls } from './detail/mutationControls.js';
import {
  GitlabIssueCommentPublicationControl,
  GitlabMergeRequestPublicationControls,
  GitlabThreadReplyPublicationControl,
} from './detail/reviewPublicationControls.js';
import { chronologicalGitlabRowsV1, projectGitlabActivityTimelineV1 } from './detail/activityTimeline.js';
import {
  hasEarlierGitlabDiscussionRepliesV1,
  projectGitlabDiscussionRepliesV1,
} from './detail/discussionReplies.js';
import { gitlabChangesEvidenceUrlV1 } from './detail/changeEvidence.js';
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
      {incomplete === null ? null : (
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.gitlab.ui.paginationUnfollowable"
          fallback={incomplete}
        />
      )}
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
  input,
  locale,
  nowMs,
}: Readonly<{
  body: GitlabDetailBodyV1;
  /**
   * The mounted input, carried alongside the projected body for one reason: the
   * write controls dispatch against the exact observation the user is reading —
   * its instance, its entry ref and its revision pin — and the display projection
   * deliberately drops all three.
   */
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const statusFields = body.fields.filter(
    (field): field is Extract<GitlabDetailFieldV1, { kind: 'status' }> => field.kind === 'status',
  );
  const pendingFields = body.fields.filter((field) => field.kind === 'pending');
  const entries: readonly MetadataEntry[] = body.fields.flatMap((field) => {
    if (field.kind === 'pending' || field.kind === 'status') return [];
    const value = fieldValueText(field, locale, nowMs);
    return value === null ? [] : [{
      label: text(`plugins.gitlab.ui.field.${field.id.replace('gitlab/', '')}`, field.label),
      value,
    }];
  });

  return (
    <ScrollArea>
      <Stack gap="large">
        {statusFields.length === 0 ? null : (
          <Row gap="small">
            {statusFields.map((field) => (
              <Status key={field.id} tone={field.tone} label={`${text(`plugins.gitlab.ui.field.${field.id.replace('gitlab/', '')}`, field.label)}: ${field.value}`} />
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
              {pendingFields.map((field) => <Badge key={field.id} value={text(`plugins.gitlab.ui.field.${field.id.replace('gitlab/', '')}`, field.label)} />)}
            </Row>
          </Stack>
        )}
        <GitlabMutationControls input={input} />
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
function noteHeadline(
  text: ReturnType<typeof usePluginTranslation>,
  row: GitlabProjectedNoteRowV1,
): string {
  const author = row.author ?? text('plugins.gitlab.ui.someone', 'Someone');
  const base = row.system ? `${author} · ${text('plugins.gitlab.ui.activity', 'activity')}` : author;
  return row.editedAtMs === undefined ? base : `${base} · ${text('plugins.gitlab.ui.edited', 'edited')}`;
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
      items={chronologicalGitlabRowsV1(state.rows)}
      keyForItem={(row) => row.id}
      header={<PageFailureBanner state={state} />}
      empty={<EmptyState title={emptyTitle} description={emptyDescription} />}
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle={text('plugins.gitlab.ui.showEarlierNotes', 'Show earlier notes')}
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel={text('plugins.gitlab.ui.rereadNotes', 'Re-read these notes from GitLab')}
          summary={`${String(state.rows.length)} note(s) read.`}
          summaryKey="plugins.gitlab.ui.notesRead"
          summaryValues={{ count: state.rows.length }}
        />
      )}
      renderItem={(row) => (
        <Item
          title={noteHeadline(text, row)}
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
function UnifiedActivityPanel({
  input,
  locale,
  nowMs,
  notes,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
  notes: GitlabPagedControllerV1<GitlabProjectedNoteRowV1> | null;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const stateEvents = useGitlabActivityEvents(input, 'state');
  const labelEvents = useGitlabActivityEvents(input, 'label');
  const milestoneEvents = useGitlabActivityEvents(input, 'milestone');
  const controllers = [stateEvents, labelEvents, milestoneEvents] as const;
  const allStates = [...(notes === null ? [] : [notes.state]), ...controllers.map((controller) => controller.state)];
  if (allStates.some((state) => state.kind === 'idle' || state.kind === 'loading')) {
    return <LoadingState title="Reading activity from GitLab" titleKey="plugins.gitlab.ui.readingActivity" />;
  }
  const rows = projectGitlabActivityTimelineV1({
    kindId: input.observation.entryRef.kindId === 'issue' ? 'issue' : 'merge-request',
    notes: notes?.state.kind === 'ready' ? notes.state.rows : [],
    events: controllers.flatMap((controller) => controller.state.kind === 'ready' ? controller.state.rows : []),
  });
  // Triage mounts this `content` surface inside its document scroller. Keep
  // activity rows static so the embedded child never becomes a second
  // same-axis scroll owner.
  return (
    <Stack gap="small">
      {allStates.map((state, index) => state.kind === 'unavailable' ? <Banner key={index} tone="warning" title="Part of the activity is unavailable" titleKey="plugins.gitlab.ui.activityUnavailable" description={failureDescription(state.failure, text('plugins.gitlab.ui.readFailed', 'GitLab could not complete this read.'))} /> : null)}
      {rows.length === 0 ? <EmptyState title="No activity" titleKey="plugins.gitlab.ui.noActivity" description="GitLab has recorded no activity on this entry yet." descriptionKey="plugins.gitlab.ui.noActivity.description" /> : (
      <List
        accessibilityLabel={text(
          'plugins.gitlab.ui.activityLabel',
          'Chronological activity GitLab recorded for this entry',
        )}
      >
        <ItemGroup>
          {rows.map((timeline) => timeline.kind === 'note'
            ? <Item key={`${timeline.kind}:${timeline.id}`} title={noteHeadline(text, timeline.row)} {...(timeline.row.body === '' ? {} : { subtitle: timeline.row.body })} {...(timeline.atMs === undefined ? {} : { detail: formatTimestamp(locale, timeline.atMs, 'relative', nowMs) })} />
            : <Item key={`${timeline.kind}:${timeline.id}`} title={eventHeadline(timeline.row)} {...(timeline.atMs === undefined ? {} : { detail: formatTimestamp(locale, timeline.atMs, 'relative', nowMs) })} />)}
        </ItemGroup>
      </List>)}
      {notes?.state.kind === 'ready' ? <PagedFooter state={notes.state} loadMoreTitle={text('plugins.gitlab.ui.showEarlierNotes', 'Show earlier notes')} onLoadMore={notes.loadMore} onRefresh={notes.refresh} refreshLabel={text('plugins.gitlab.ui.rereadNotes', 'Re-read notes from GitLab')} summary={`${String(notes.state.rows.length)} note(s) read.`} summaryKey="plugins.gitlab.ui.notesRead" summaryValues={{ count: notes.state.rows.length }} /> : null}
      {controllers.map((controller, index) => {
        const source = GITLAB_ACTIVITY_EVENT_SOURCES_V1[index] ?? 'state';
        return controller.state.kind === 'ready' ? <PagedFooter key={source} state={controller.state} loadMoreTitle={text('plugins.gitlab.ui.showMoreEvents', 'Show more {event}', { event: text(`plugins.gitlab.ui.eventSource.${source}`, EVENT_SOURCE_TITLES[source] ?? 'Activity').toLocaleLowerCase(locale) })} onLoadMore={controller.loadMore} onRefresh={controller.refresh} refreshLabel={text('plugins.gitlab.ui.rereadActivity', 'Re-read activity from GitLab')} summary={`${String(controller.state.rows.length)} event(s) read.`} summaryKey="plugins.gitlab.ui.eventsRead" summaryValues={{ count: controller.state.rows.length }} /> : null;
      })}
    </Stack>
  );
}

function MergeRequestActivityPanel(props: Readonly<{ input: TriageDetailSurfaceInputV1; locale: string; nowMs: number }>): React.ReactElement {
  const notes = useGitlabNotes(props.input);
  return <UnifiedActivityPanel {...props} notes={notes} />;
}

function IssueActivityPanel(props: Readonly<{ input: TriageDetailSurfaceInputV1; locale: string; nowMs: number }>): React.ReactElement {
  return <UnifiedActivityPanel {...props} notes={null} />;
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
  const proposals = useReviewCommentProposalsForEntry({
    linkedSessionIds: input.linkedSessions.map((session) => session.sessionId),
    entry: {
      kind: 'issue',
      id: createReviewCommentLinkedIssueIdV1(input.observation.entryRef),
    },
  });
  return (
    <Stack gap="large">
      <GitlabIssueCommentPublicationControl input={input} proposals={proposals} />
      <NotesSection
        input={input}
        locale={locale}
        nowMs={nowMs}
        accessibilityLabel="Comments on this GitLab issue"
        accessibilityLabelKey="plugins.gitlab.ui.commentsLabel"
        emptyTitle="No comments"
        emptyDescription="Nobody has commented on this issue yet."
      />
    </Stack>
  );
}

/* ---------------------------------------------------------------------- Changes */

function changedFileSubtitle(
  text: PluginTranslate,
  row: GitlabProjectedChangedFileRowV1,
): string {
  if (row.tooLarge === true) {
    return text('plugins.gitlab.ui.files.tooLarge', 'Too large for GitLab to return a diff.');
  }
  if (row.collapsed === true) {
    return text(
      'plugins.gitlab.ui.files.collapsed',
      'GitLab collapsed this file; it can be fetched on request.',
    );
  }
  if (row.deletedFile) return text('plugins.gitlab.ui.files.deleted', 'Deleted');
  if (row.newFile) return text('plugins.gitlab.ui.files.added', 'Added');
  if (row.renamedFile && row.previousPath !== undefined) {
    return text('plugins.gitlab.ui.files.renamed', 'Renamed from {previous}', {
      previous: row.previousPath,
    });
  }
  return text('plugins.gitlab.ui.files.modified', 'Modified');
}

function ChangesPanel({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGitlabChanges(input);
  const rawDiff = useGitlabRawDiff(input);
  const { state } = controller;
  const changesUrl = gitlabChangesEvidenceUrlV1(input.observation.locator.webUrl);

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
          <Button
            title="Load raw diff evidence"
            titleKey="plugins.gitlab.ui.loadRawDiff"
            variant="secondary"
            busy={rawDiff.state.kind === 'loading'}
            onPress={rawDiff.load}
          />
          {rawDiff.state.kind !== 'unavailable' ? null : (
            <Banner
              tone="warning"
              title="Raw diff evidence is unavailable"
              titleKey="plugins.gitlab.ui.rawDiffUnavailable"
              description={failureDescription(
                rawDiff.state.failure,
                text('plugins.gitlab.ui.readFailed', 'GitLab could not complete this read.'),
              )}
            />
          )}
          {rawDiff.state.kind !== 'ready' ? null : (
            <Stack gap="small">
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.gitlab.ui.rawDiffLabel"
                fallback="Raw diff evidence · returned as text by GitLab"
              />
              {rawDiff.state.truncated ? (
                <Banner
                  tone="neutral"
                  title="The raw diff was shortened"
                  titleKey="plugins.gitlab.ui.rawDiffShortened"
                  description="The returned prefix fits Happier’s Action-result boundary."
                  descriptionKey="plugins.gitlab.ui.rawDiffShortened.description"
                />
              ) : null}
              <Text variant="code" value={rawDiff.state.text} />
            </Stack>
          )}
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
          loadMoreTitle={text('plugins.gitlab.ui.showMoreFiles', 'Show more files')}
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel={text('plugins.gitlab.ui.rereadFiles', 'Re-read the changed files from GitLab')}
          summary={`${String(state.rows.length)} file(s) read.`}
          summaryKey="plugins.gitlab.ui.filesRead"
          summaryValues={{ count: state.rows.length }}
        />
      )}
      renderItem={(row) => (
        <Item
          title={row.path}
          subtitle={changedFileSubtitle(text, row)}
          accessoryOutsidePressable
          accessory={<Row gap="small">
            <Action.Copy value={row.path} variant="plain" accessibilityLabel={text('plugins.gitlab.ui.copyValue', 'Copy {item}', { item: row.path })} />
            {row.collapsed !== true || changesUrl === null ? null : (
              <Action.OpenExternal url={changesUrl} variant="plain" accessibilityLabel={text(
                'plugins.gitlab.ui.openCollapsedFile',
                'Open collapsed file evidence for {file} on GitLab',
                { file: row.path },
              )} />
            )}
          </Row>}
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
      { label: text('plugins.gitlab.ui.status.failing', 'Failing'), value: String(rollup.failingCount) },
      { label: text('plugins.gitlab.ui.status.running', 'Running'), value: String(rollup.runningCount ?? 0) },
      { label: text('plugins.gitlab.ui.status.passing', 'Passing'), value: String(rollup.passingCount ?? 0) },
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
          loadMoreTitle={text('plugins.gitlab.ui.showOlderPipelines', 'Show older pipelines')}
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel={text('plugins.gitlab.ui.rereadPipelines', 'Re-read the pipelines from GitLab')}
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
      : [{ label: text('plugins.gitlab.ui.status.required', 'Required'), value: String(view.approvalsRequired) }]),
    ...(view.approvalsLeft === undefined
      ? []
      : [{ label: text('plugins.gitlab.ui.status.stillNeeded', 'Still needed'), value: String(view.approvalsLeft) }]),
    ...(view.approvedBy.length === 0
      ? []
      : [{ label: text('plugins.gitlab.ui.status.approvedBy', 'Approved by'), value: view.approvedBy.join(', ') }]),
    ...(view.userHasApproved === undefined
      ? []
      : [{
        label: text('plugins.gitlab.ui.status.youApproved', 'You approved'),
        value: view.userHasApproved
          ? text('plugins.gitlab.ui.status.yes', 'Yes')
          : text('plugins.gitlab.ui.status.no', 'No'),
      }]),
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

function discussionHeadline(
  text: PluginTranslate,
  row: GitlabProjectedDiscussionRowV1,
): string {
  const first = row.notes[0];
  const author = first?.author ?? text('plugins.gitlab.ui.someone', 'Someone');
  return row.individualNote
    ? `${author} · ${text('plugins.gitlab.ui.discussion.comment', 'comment')}`
    : `${author} · ${text('plugins.gitlab.ui.discussion.thread', 'thread')}`;
}

/**
 * Each discussion opens its latest four returned notes.
 *
 * The window is client-local over the notes the boundary already published: GitLab documents no
 * per-discussion note cursor, so inventing a nested HTTP page would be a request nobody offered.
 */
function DiscussionsSection({ input, proposals }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  proposals: ReviewCommentProposalReadV1;
}>): React.ReactElement {
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
          loadMoreTitle={text('plugins.gitlab.ui.showMoreDiscussions', 'Show more discussions')}
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel={text('plugins.gitlab.ui.rereadDiscussions', 'Re-read the discussions from GitLab')}
          summary={`${String(state.rows.length)} discussion(s) read.`}
          summaryKey="plugins.gitlab.ui.discussionsRead"
          summaryValues={{ count: state.rows.length }}
        />
      )}
      renderItem={(row) => <DiscussionRow input={input} row={row} proposals={proposals} />}
    />
  );
}

function DiscussionRow({ input, row, proposals }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  row: GitlabProjectedDiscussionRowV1;
  proposals: ReviewCommentProposalReadV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const hasEarlier = hasEarlierGitlabDiscussionRepliesV1(row.notes);
  const shown = projectGitlabDiscussionRepliesV1(row.notes, expanded);
  const bodies = shown.map((note) => note.body).filter((body) => body !== '').join(' — ');
  const subtitle = row.omittedNoteCount === 0
    ? bodies
    : `${bodies} ${text(
      'plugins.gitlab.ui.discussion.omittedReplies',
      '({count} further reply/replies were not published)',
      { count: row.omittedNoteCount },
    )}`;
  return (
    <Stack gap="small">
      <Item title={discussionHeadline(text, row)} subtitle={subtitle} />
      {hasEarlier ? (
        <Button
          title={expanded
            ? text('plugins.gitlab.ui.discussion.showLatest', 'Show latest replies')
            : text('plugins.gitlab.ui.discussion.showEarlier', 'Show earlier replies')}
          variant="plain"
          onPress={() => setExpanded((value) => !value)}
        />
      ) : null}
      {row.individualNote ? null : <GitlabDiscussionResolutionControl input={input} discussionId={row.id} resolved={row.notes[0]?.resolved === true} />}
      {row.individualNote ? null : (
        <GitlabThreadReplyPublicationControl
          input={input}
          discussionId={row.id}
          proposals={proposals}
        />
      )}
    </Stack>
  );
}

function ReviewsPanel({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const proposals = useReviewCommentProposalsForEntry({
    linkedSessionIds: input.linkedSessions.map((session) => session.sessionId),
    entry: { kind: 'pullRequest', url: input.observation.locator.webUrl },
  });
  // Triage owns the detail document scroller. Discussions is a virtualized
  // List, so this panel must not wrap it in a second same-axis ScrollArea.
  return (
    <Stack gap="large">
      <GitlabMergeRequestPublicationControls input={input} proposals={proposals} />
      <ApprovalsSection input={input} />
      <DiscussionsSection input={input} proposals={proposals} />
    </Stack>
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
  const text = usePluginTranslation();
  const { execute } = useExecutePluginAction('session.open');
  const [pendingSessionId, setPendingSessionId] = React.useState<string | null>(null);
  const [failedSessionId, setFailedSessionId] = React.useState<string | null>(null);
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
            title={session.displayTitle ?? text(
              'plugins.gitlab.ui.session.untitled',
              'Untitled session',
            )}
            subtitle={session.displayTitle === undefined
              ? text(
                'plugins.gitlab.ui.session.detailsUnavailable',
                'Session details are unavailable',
              )
              : failedSessionId === session.sessionId
                ? text('plugins.gitlab.ui.session.openFailed', 'This Session could not be opened.')
                : undefined}
            accessoryOutsidePressable
            accessory={<Button
              title={session.displayTitle === undefined
                ? text('plugins.gitlab.ui.session.openUntitled', 'Open session')
                : text(
                  'plugins.gitlab.ui.session.open',
                  'Open {session}',
                  { session: session.displayTitle },
                )}
              variant="plain"
              busy={pendingSessionId === session.sessionId}
              disabled={pendingSessionId !== null}
              onPress={() => {
                setPendingSessionId(session.sessionId);
                setFailedSessionId(null);
                void execute({ sessionId: session.sessionId }).then((settled) => {
                  setPendingSessionId(null);
                  if (settled.status !== 'success') setFailedSessionId(session.sessionId);
                });
              }}
            />}
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
  const text = usePluginTranslation();
  const [selected, setSelected] = React.useState<GitlabDetailTabIdV1>(
    GITLAB_DEFAULT_DETAIL_TAB_V1,
  );
  // One render-time read, passed down as data, so no child owns a hidden clock.
  const nowMs = Date.now();
  const body = React.useMemo(() => projectGitlabDetailBody(input), [input]);

  const visible = gitlabVisibleDetailTabs(kindId);
  const tab = gitlabResolveSelectedTab(selected, visible);

  const panels: Readonly<Record<GitlabDetailTabIdV1, React.ReactNode>> = {
    overview: <OverviewPanel body={body} input={input} locale={locale} nowMs={nowMs} />,
    activity: kindId === 'merge-request'
      ? <MergeRequestActivityPanel input={input} locale={locale} nowMs={nowMs} />
      : <IssueActivityPanel input={input} locale={locale} nowMs={nowMs} />,
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
        ariaLabel={text('plugins.gitlab.ui.detailLabel', 'GitLab entry detail')}
      >
        {visible.map((declaration) => (
          <Tabs.Item
            key={declaration.id}
            value={declaration.id}
            title={text(declaration.titleKey, declaration.title)}
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
