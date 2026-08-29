/**
 * The Azure DevOps Triage detail surface artifact entry.
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
 * What it does own are Azure's own facts, and one structural rule shapes the whole body: **the
 * detail ROOT reads the iteration list, once.** Every push to the source branch produces an
 * iteration, and both `Activity` and `Files` need to know which one is current. Two readers would
 * answer from two snapshots, and the tab that lost the race would compare against an iteration the
 * other has already moved past — so there is one read here and its projection is passed down.
 *
 * `Threads` is the only consumer of the review-thread resource. `Activity` is valuable precisely
 * because it shows the iteration and commit chronology WITHOUT turning discussion rows into a
 * second feed of the same conversation.
 *
 * There is no Sessions tab. Azure declares one kind — the pull request — and a pull request's
 * Session relationship is already a common-header fact; a tab for it here would be a second owner
 * of one relationship. There is no Work Items affordance either: Azure Boards is a separate
 * product domain this source deliberately does not model. No rich hunk or body diff is rendered — that capability is held at
 * the shared component catalog under `B6`, and `Files` presents the changed-file list instead.
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
  usePluginTranslation,
  useSurfaceContext,
  type MetadataEntry,
  type PluginTranslate,
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
  formatTriageTimestampV1 as formatTimestamp,
  projectTriageDetailFieldTextV1 as fieldValueText,
} from '@happier-dev/triage-protocol/v1';

import {
  projectAzureDetailOverview,
  type AzureDetailFieldV1,
  type AzureDetailOverviewV1,
} from '../triage/detail.js';
import type {
  AzureProjectedChangedFileRowV1,
  AzureProjectedCommitRowV1,
  AzureProjectedIterationRowV1,
  AzureProjectedThreadRowV1,
} from '../triage/detail/projection.js';

import { AzureMutationControls, AzureThreadStatusControl } from './detail/mutations.js';
import {
  AzureReviewPublicationControls,
  AzureThreadReplyPublicationControl,
} from './detail/reviewPublication.js';
import {
  useAzureCommits,
  useAzureIterationChanges,
  useAzureIterations,
  useAzurePolicies,
  useAzureThreads,
  type AzureIterationsViewV1,
  type AzurePoliciesViewV1,
  type AzureThreadsViewV1,
} from './detail/panelReaders.js';
import type { AzurePagedStateV1, AzureReadStateV1 } from './detail/panelState.js';
import {
  AZURE_DEFAULT_DETAIL_TAB_V1,
  AZURE_DETAIL_TABS_V1,
  AZURE_THREAD_REPLY_WINDOW_V1,
  AZURE_THREAD_WINDOW_V1,
  type AzureDetailTabIdV1,
} from './detail/tabDeclarations.js';


function PageFailureBanner({
  state,
}: Readonly<{ state: AzurePagedStateV1<unknown> }>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (state.failure === null && state.incomplete === null) return null;
  return (
    <Banner
      tone="warning"
      title="Showing what was read so far"
      titleKey="plugins.azureDevops.ui.partial"
      description={state.failure === null
        ? text(
          'plugins.azureDevops.ui.pagePositionUnsafe',
          'Azure DevOps returned a next-page position that could not be carried safely, so this walk stopped here.',
        )
        : failureDescription(
          state.failure,
          text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.'),
        )}
    />
  );
}

function SettledReadEvidence({
  state,
}: Readonly<{
  state: AzureReadStateV1<Readonly<{
    omittedRowCount: number;
    projectionTruncated: boolean;
  }>>;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (state.kind !== 'ready') return null;
  return (
    <Stack gap="small">
      {state.failure === null ? null : (
        <Banner
          tone="warning"
          title="Showing the last details Azure DevOps returned"
          titleKey="plugins.azureDevops.ui.partial"
          description={failureDescription(
            state.failure,
            text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.'),
          )}
        />
      )}
      {state.value.omittedRowCount === 0 ? null : (
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.azureDevops.ui.rowsUnreadable"
          fallback="{count} row(s) in this response could not be understood."
          values={{ count: state.value.omittedRowCount }}
        />
      )}
      {!state.value.projectionTruncated ? null : (
        <Banner
          tone="neutral"
          title="Some details were shortened"
          titleKey="plugins.azureDevops.ui.shortened"
          description="Open the pull request in Azure DevOps to read the complete text."
          descriptionKey="plugins.azureDevops.ui.shortened.description"
        />
      )}
    </Stack>
  );
}

/** The footer every paged panel shares: what was read, and how to ask for more. */
function PagedFooter({
  state,
  loadMoreTitle,
  onLoadMore,
  onRefresh,
  refreshLabel,
  refreshLabelKey,
  summary,
  summaryKey,
  summaryValues,
}: Readonly<{
  state: AzurePagedStateV1<unknown>;
  loadMoreTitle: string;
  onLoadMore: () => void;
  onRefresh: () => void;
  refreshLabel: string;
  refreshLabelKey: string;
  summary: string;
  summaryKey: string;
  summaryValues: Readonly<Record<string, string | number>>;
}>): React.ReactElement {
  return (
    <Stack gap="small">
      <Text variant="caption" tone="neutral" valueKey={summaryKey} fallback={summary} values={summaryValues} />
      {state.omittedRowCount === 0
        ? null
        : (
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.azureDevops.ui.rowsUnreadable"
            fallback="{count} row(s) on the pages read could not be understood."
            values={{ count: state.omittedRowCount }}
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
      <Row gap="small">
        <Action.Refresh
          onRefresh={onRefresh}
          disabled={state.pending}
          variant="plain"
          accessibilityLabel={refreshLabel}
          accessibilityLabelKey={refreshLabelKey}
        />
      </Row>
    </Stack>
  );
}

/* -------------------------------------------------------------------- Overview */

function azureFactLabel(field: AzureDetailFieldV1, text: PluginTranslate): string {
  switch (field.id) {
    case 'azure-devops/reviewer-vote': return text('plugins.azureDevops.ui.fact.yourVote', field.label);
    case 'azure-devops/merge-status': return text('plugins.azureDevops.ui.fact.merge', field.label);
    case 'azure-devops/draft': return text('plugins.azureDevops.ui.fact.draft', 'Draft');
    case 'azure-devops/auto-complete': return text('plugins.azureDevops.ui.fact.autoComplete', field.label);
    default: return field.label;
  }
}

function OverviewPanel({
  input,
  overview,
  iterations,
  locale,
  nowMs,
  onRefreshIterations,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  overview: AzureDetailOverviewV1;
  iterations: AzureReadStateV1<AzureIterationsViewV1>;
  locale: string;
  nowMs: number;
  onRefreshIterations: () => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const statusFields = overview.fields.filter(
    (field): field is Extract<AzureDetailFieldV1, { kind: 'status' }> => field.kind === 'status',
  );
  const pendingFields = overview.fields.filter((field) => field.kind === 'pending');
  const entries: readonly MetadataEntry[] = overview.fields.flatMap((field) => {
    if (field.kind === 'pending' || field.kind === 'status') return [];
    const value = fieldValueText(field, locale, nowMs);
    return value === null ? [] : [{ label: azureFactLabel(field, text), value }];
  });

  return (
    <ScrollArea>
      <Stack gap="large">
        <SettledReadEvidence state={iterations} />
        {iterations.kind !== 'unavailable' ? null : (
          <Banner
            tone="warning"
            title="The iterations could not be read"
            titleKey="plugins.azureDevops.ui.iterationsUnavailable"
            description={failureDescription(
              iterations.failure,
              text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.'),
            )}
          />
        )}
        {!overview.projectionTruncated ? null : (
          <Banner
            tone="neutral"
            title="Some details were shortened"
            titleKey="plugins.azureDevops.ui.shortened"
            description="Open the pull request in Azure DevOps to read the complete text."
            descriptionKey="plugins.azureDevops.ui.shortened.description"
          />
        )}
        {statusFields.length === 0 ? null : (
          <Row gap="small">
            {statusFields.map((field) => (
              <Status key={field.id} tone={field.tone} label={`${azureFactLabel(field, text)}: ${field.value}`} />
            ))}
          </Row>
        )}
        {entries.length === 0
          ? <EmptyState title="No projected facts" titleKey="plugins.azureDevops.ui.noFacts" description="This observation carried no displayable facts." descriptionKey="plugins.azureDevops.ui.noFacts.description" />
          : <Metadata title="Facts" titleKey="plugins.azureDevops.ui.facts" entries={entries} />}
        {pendingFields.length === 0 ? null : (
          <Stack gap="small">
            <Text
              variant="caption"
              tone="neutral"
              valueKey="plugins.azureDevops.ui.pendingPanels.description"
              fallback="Answered in the panels beside this one, not on the list row:"
            />
            <Row gap="small">
              {pendingFields.map((field) => <Badge key={field.id} value={azureFactLabel(field, text)} />)}
            </Row>
          </Stack>
        )}
        {/*
          * The writes live on Overview because it is the tab a detail opens on and the one that
          * already states what this pull request currently is. A tab of their own would put a
          * destructive control behind a click that says nothing about what is behind it.
          */}
        <AzureMutationControls input={input} overview={overview} />
        {overview.state.presentation === 'active'
          ? <AzureReviewPublicationControls input={input} />
          : null}
        <Divider />
        <Metadata
          title="Observation"
          titleKey="plugins.azureDevops.ui.observation"
          entries={[
            {
              label: text('plugins.azureDevops.ui.metadata.observed', 'Observed'),
              value: formatTimestamp(locale, overview.observedAtMs, 'relative', nowMs),
            },
            ...(overview.sourceUpdatedAtMs === null
              ? []
              : [{
                label: text('plugins.azureDevops.ui.metadata.lastChanged', 'Azure DevOps last changed'),
                value: formatTimestamp(locale, overview.sourceUpdatedAtMs, 'relative', nowMs),
              }]),
            ...(overview.nativeRevision === null
              ? []
              : [{ label: text('plugins.azureDevops.ui.metadata.sourceCommit', 'Source commit'), value: overview.nativeRevision }]),
            // The one iteration fact the root already knows, shown once. It is
            // read here and in no tab.
            ...(iterations.kind === 'ready' && iterations.value.currentIterationId !== undefined
              ? [{ label: text('plugins.azureDevops.ui.metadata.currentIteration', 'Current iteration'), value: String(iterations.value.currentIterationId) }]
              : []),
          ]}
        />
        <Row gap="small">
          <Action.Refresh
            onRefresh={onRefreshIterations}
            disabled={iterations.kind === 'loading'
              || (iterations.kind === 'ready' && iterations.pending)}
            variant="plain"
            accessibilityLabel="Re-read the pull request iterations from Azure DevOps"
            accessibilityLabelKey="plugins.azureDevops.ui.rereadIterations"
          />
        </Row>
      </Stack>
    </ScrollArea>
  );
}

/* -------------------------------------------------------------------- Activity */

function commitHeadline(row: AzureProjectedCommitRowV1): string {
  const short = row.commitId.slice(0, 8);
  return row.author === undefined ? short : `${short} · ${row.author}`;
}

export type AzureActivityChronologyRowV1 =
  | Readonly<{ kind: 'iteration'; row: AzureProjectedIterationRowV1 }>
  | Readonly<{ kind: 'commit'; row: AzureProjectedCommitRowV1 }>;

/**
 * Merge Azure's two native activity resources without reordering either one.
 * Their provider order wins within each resource; timestamps decide only which
 * resource contributes the next row. An unknown timestamp never becomes zero.
 */
export function projectAzureActivityChronology(
  iterations: readonly AzureProjectedIterationRowV1[],
  commits: readonly AzureProjectedCommitRowV1[],
): readonly AzureActivityChronologyRowV1[] {
  const timestampDirection = (values: readonly (number | undefined)[]): 'ascending' | 'descending' | null => {
    const known = values.filter((value): value is number => value !== undefined);
    const first = known[0];
    const last = known[known.length - 1];
    if (first === undefined || last === undefined || first === last) return null;
    return first < last ? 'ascending' : 'descending';
  };
  const direction = timestampDirection(iterations.map((row) => row.createdAtMs))
    ?? timestampDirection(commits.map((row) => row.authoredAtMs))
    ?? 'descending';
  const chronology: AzureActivityChronologyRowV1[] = [];
  let iterationIndex = 0;
  let commitIndex = 0;
  while (iterationIndex < iterations.length || commitIndex < commits.length) {
    const iteration = iterations[iterationIndex];
    const commit = commits[commitIndex];
    if (iteration === undefined) {
      if (commit === undefined) break;
      chronology.push({ kind: 'commit', row: commit });
      commitIndex += 1;
      continue;
    }
    if (commit === undefined) {
      chronology.push({ kind: 'iteration', row: iteration });
      iterationIndex += 1;
      continue;
    }
    const iterationAt = iteration.createdAtMs;
    const commitAt = commit.authoredAtMs;
    const commitComesFirst = commitAt !== undefined && (
      iterationAt === undefined
      || (direction === 'descending' ? commitAt > iterationAt : commitAt < iterationAt)
    );
    if (commitComesFirst) {
      chronology.push({ kind: 'commit', row: commit });
      commitIndex += 1;
    } else {
      chronology.push({ kind: 'iteration', row: iteration });
      iterationIndex += 1;
    }
  }
  return Object.freeze(chronology);
}

/**
 * The iteration and commit chronology, from the shared iteration projection plus this tab's own
 * paged commit read.
 *
 * It reads no threads. Azure's review discussion is a different resource with its own tab, and
 * folding it in here would give the reader the same conversation twice.
 */
function ActivityPanel({
  input,
  iterations,
  locale,
  nowMs,
  onRefreshIterations,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  iterations: AzureReadStateV1<AzureIterationsViewV1>;
  locale: string;
  nowMs: number;
  onRefreshIterations: () => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useAzureCommits(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the commits from Azure DevOps" titleKey="plugins.azureDevops.ui.readingCommits" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The activity is unavailable"
        titleKey="plugins.azureDevops.ui.activityUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.'),
        )}
      />
    );
  }

  const chronology = projectAzureActivityChronology(
    iterations.kind === 'ready' ? iterations.value.rows : [],
    state.rows,
  );

  return (
    <List
      accessibilityLabel="Commits and iterations of this Azure DevOps pull request"
      accessibilityLabelKey="plugins.azureDevops.ui.activityLabel"
      items={chronology}
      keyForItem={(event) => event.kind === 'iteration'
        ? `iteration:${String(event.row.id)}`
        : `commit:${event.row.commitId}`}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          <SettledReadEvidence state={iterations} />
          {iterations.kind === 'unavailable'
            ? (
              <Banner
                tone="warning"
                title="The iterations could not be read"
                titleKey="plugins.azureDevops.ui.iterationsUnavailable"
        description={failureDescription(
          iterations.failure,
          text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.'),
        )}
              />
            )
            : null}
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No commits"
          titleKey="plugins.azureDevops.ui.noCommits"
          description="Azure DevOps reports no commit on this pull request yet."
          descriptionKey="plugins.azureDevops.ui.noCommits.description"
        />
      )}
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle="Show 30 more commits"
          onLoadMore={controller.loadMore}
          onRefresh={() => {
            onRefreshIterations();
            controller.refresh();
          }}
          refreshLabel="Re-read the commits from Azure DevOps"
          refreshLabelKey="plugins.azureDevops.ui.rereadCommits"
          summary={`${String(state.rows.length)} commit(s) read.`}
          summaryKey="plugins.azureDevops.ui.commitsRead"
          summaryValues={{ count: state.rows.length }}
        />
      )}
      renderItem={(event) => {
        if (event.kind === 'iteration') {
          const row = event.row;
          const iterationLabel = text(
            'plugins.azureDevops.ui.iterationTitle',
            'Iteration {id}',
            { id: String(row.id) },
          );
          return (
            <Item
              title={row.author === undefined ? iterationLabel : `${iterationLabel} · ${row.author}`}
              subtitle={row.reason ?? row.description ?? text('plugins.azureDevops.ui.iterationUpdated', 'Updated')}
              {...(row.createdAtMs === undefined
                ? {}
                : { detail: formatTimestamp(locale, row.createdAtMs, 'relative', nowMs) })}
            />
          );
        }
        const row = event.row;
        return (
          <Item
            title={commitHeadline(row)}
            {...(row.comment === '' ? {} : { subtitle: row.comment })}
            {...(row.authoredAtMs === undefined
              ? {}
              : { detail: formatTimestamp(locale, row.authoredAtMs, 'relative', nowMs) })}
            {...(row.url === undefined
              ? {}
              : {
                accessory: (
                  <Action.OpenExternal
                    url={row.url}
                    variant="plain"
                    accessibilityLabel={text(
                      'plugins.azureDevops.ui.openValue',
                      'Open {item}',
                      { item: row.commitId.slice(0, 8) },
                    )}
                  />
                ),
              })}
          />
        );
      }}
    />
  );
}

/* ----------------------------------------------------------------------- Files */

function changedFileSubtitle(row: AzureProjectedChangedFileRowV1): string {
  return row.isFolder ? `${row.changeType} (folder)` : row.changeType;
}

function FilesPanel({
  input,
  iterations,
  onRefreshIterations,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  iterations: AzureReadStateV1<AzureIterationsViewV1>;
  onRefreshIterations: () => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const currentIterationId = iterations.kind === 'ready'
    ? iterations.value.currentIterationId
    : undefined;
  const controller = useAzureIterationChanges(input, currentIterationId);
  const { state } = controller;

  if (iterations.kind === 'loading') {
    return <LoadingState title="Reading the iterations from Azure DevOps" titleKey="plugins.azureDevops.ui.readingIterations" />;
  }
  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the changed files from Azure DevOps" titleKey="plugins.azureDevops.ui.readingFiles" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The changed files are unavailable"
        titleKey="plugins.azureDevops.ui.filesUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.'),
        )}
      />
    );
  }

  return (
    <List
      accessibilityLabel="Files this Azure DevOps pull-request iteration changes"
      accessibilityLabelKey="plugins.azureDevops.ui.filesLabel"
      items={state.rows}
      keyForItem={(row) => row.path}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          <SettledReadEvidence state={iterations} />
          <Text
            variant="caption"
            tone="neutral"
            valueKey={currentIterationId === undefined
              ? 'plugins.azureDevops.ui.noComparisonIteration'
              : 'plugins.azureDevops.ui.comparingIteration'}
            fallback={currentIterationId === undefined
              ? 'No iteration to compare against.'
              : "Comparing iteration {iteration} against the pull request's base."}
            values={{ iteration: currentIterationId ?? '' }}
          />
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No changed files"
          titleKey="plugins.azureDevops.ui.noFiles"
          description="Azure DevOps reports that this iteration changes no files."
          descriptionKey="plugins.azureDevops.ui.noFiles.description"
        />
      )}
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle="Show more files"
          onLoadMore={controller.loadMore}
          onRefresh={() => {
            onRefreshIterations();
            controller.refresh();
          }}
          refreshLabel="Re-read the changed files from Azure DevOps"
          refreshLabelKey="plugins.azureDevops.ui.rereadFiles"
          summary={`${String(state.rows.length)} file(s) read.`}
          summaryKey="plugins.azureDevops.ui.filesRead"
          summaryValues={{ count: state.rows.length }}
        />
      )}
      renderItem={(row) => (
        <Item
          title={row.path}
          subtitle={changedFileSubtitle(row)}
          accessoryOutsidePressable
          accessory={(
            <Action.Copy
              value={row.path}
              variant="plain"
              accessibilityLabel={text('plugins.azureDevops.ui.copyValue', 'Copy {item}', {
                item: row.path,
              })}
            />
          )}
        />
      )}
    />
  );
}

/* -------------------------------------------------------------------- Policies */

function PoliciesPanel({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useAzurePolicies(input);
  const state: AzureReadStateV1<AzurePoliciesViewV1> = controller.state;

  if (state.kind === 'loading') {
    return <LoadingState title="Reading the policies from Azure DevOps" titleKey="plugins.azureDevops.ui.readingPolicies" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The policies are unavailable"
        titleKey="plugins.azureDevops.ui.policiesUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.'),
        )}
      />
    );
  }

  const view = state.value;
  const blocking = view.evaluations.filter((row) => row.isBlocking);
  const builds = view.evaluations.filter((row) => row.isBuildValidation);
  const policies = view.evaluations.filter((row) => !row.isBuildValidation);

  const renderEvaluation = (row: AzurePoliciesViewV1['evaluations'][number]) => (
    <Item
      title={row.displayName ?? row.evaluationId}
      subtitle={row.isBlocking
        ? `${row.status} · ${text('plugins.azureDevops.ui.value.required', 'required')}`
        : `${row.status} · ${text('plugins.azureDevops.ui.value.optional', 'optional')}`}
      // A missing completion time is unknown, never a zero duration.
      detail={row.completedAtMs === undefined
        ? text('plugins.azureDevops.ui.value.completionUnknown', 'Completion time unknown')
        : undefined}
    />
  );

  // This is embedded `content`; Triage owns the document scroller. These
  // bounded policy groups therefore use static List semantics rather than
  // mounting independent virtualized scroll owners inside it.
  return (
    <Stack gap="large">
        <SettledReadEvidence state={state} />
        {!view.evaluationsPartial ? null : (
          <Banner
            tone="warning"
            title="The policy evaluations could not be read"
            titleKey="plugins.azureDevops.ui.policyEvaluationsUnavailable"
            description="The statuses below are real. Whether any of them is enforced is unknown."
            descriptionKey="plugins.azureDevops.ui.policyEvaluationsUnavailable.description"
          />
        )}
        <Metadata
          title="Policy evaluations"
          titleKey="plugins.azureDevops.ui.policyEvaluations"
          entries={view.evaluations.length === 0
            ? [{
              label: text('plugins.azureDevops.ui.metadata.evaluations', 'Evaluations'),
              value: view.evaluationsPartial
                ? text('plugins.azureDevops.ui.value.unknown', 'Unknown')
                : text('plugins.azureDevops.ui.value.none', 'None'),
            }]
            : [
              { label: text('plugins.azureDevops.ui.metadata.total', 'Total'), value: String(view.evaluations.length) },
              { label: text('plugins.azureDevops.ui.metadata.blocking', 'Blocking'), value: String(blocking.length) },
              { label: text('plugins.azureDevops.ui.metadata.buildValidations', 'Build validations'), value: String(builds.length) },
            ]}
        />
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.azureDevops.ui.statusInformational.description"
          fallback="A status is informational unless a policy evaluation above marks it required."
        />
        {view.statuses.length === 0 ? (
          <EmptyState
            title="No statuses"
            titleKey="plugins.azureDevops.ui.noStatuses"
            description="Nothing has reported a status against this pull request."
            descriptionKey="plugins.azureDevops.ui.noStatuses.description"
          />
        ) : (
          <List accessibilityLabel="Statuses reported against this Azure DevOps pull request" accessibilityLabelKey="plugins.azureDevops.ui.statusesLabel">
            <ItemGroup>
              {view.statuses.map((row) => (
                <Item
                  key={row.id}
                  title={row.contextName ?? row.id}
                  subtitle={row.description ?? row.state}
                  {...(row.targetUrl === undefined
                    ? {}
                    : {
                      accessory: (
                        <Action.OpenExternal
                          url={row.targetUrl}
                          variant="plain"
                          accessibilityLabel="Open this status"
                          accessibilityLabelKey="plugins.azureDevops.ui.openStatus"
                        />
                      ),
                    })}
                />
              ))}
            </ItemGroup>
          </List>
        )}
        <Divider />
        {policies.length === 0 ? (
          <EmptyState
            title="No policies"
            titleKey="plugins.azureDevops.ui.noPolicies"
            description="Azure DevOps reports no ordinary policy evaluation for this pull request."
            descriptionKey="plugins.azureDevops.ui.noPolicies.description"
          />
        ) : (
          <List accessibilityLabel="Policies for this Azure DevOps pull request" accessibilityLabelKey="plugins.azureDevops.ui.policiesLabel">
            <ItemGroup>{policies.map((row) => <React.Fragment key={row.evaluationId}>{renderEvaluation(row)}</React.Fragment>)}</ItemGroup>
          </List>
        )}
        <Divider />
        {builds.length === 0 ? (
          <EmptyState
            title="No build validations"
            titleKey="plugins.azureDevops.ui.noBuildValidations"
            description="Azure DevOps reports no build-validation policy for this pull request."
            descriptionKey="plugins.azureDevops.ui.noBuildValidations.description"
          />
        ) : (
          <List accessibilityLabel="Build validations for this Azure DevOps pull request" accessibilityLabelKey="plugins.azureDevops.ui.buildValidationsLabel">
            <ItemGroup>{builds.map((row) => <React.Fragment key={row.evaluationId}>{renderEvaluation(row)}</React.Fragment>)}</ItemGroup>
          </List>
        )}
        <Row gap="small">
          <Action.Refresh
            onRefresh={controller.refresh}
            disabled={state.pending}
            variant="plain"
            accessibilityLabel="Re-read the policies from Azure DevOps"
            accessibilityLabelKey="plugins.azureDevops.ui.rereadPolicies"
          />
        </Row>
    </Stack>
  );
}

/* --------------------------------------------------------------------- Threads */

function threadHeadline(row: AzureProjectedThreadRowV1): string {
  const anchor = row.path === undefined
    ? 'On the pull request'
    : row.rightFileStartLine === undefined
      ? row.path
      : `${row.path}:${String(row.rightFileStartLine)}`;
  return row.status === undefined ? anchor : `${anchor} · ${row.status}`;
}

/**
 * The latest replies a thread opens with, plus how many are behind them.
 *
 * The window is a slice of comments the panel already holds. Azure publishes no per-thread cursor,
 * so expanding it issues no request — and a control that claimed otherwise would be pagination
 * this product invented.
 */
export function projectAzureThreadSubtitle(
  row: AzureProjectedThreadRowV1,
  replyWindow: number,
): string {
  const shown = row.comments.slice(-replyWindow);
  const earlier = row.comments.length - shown.length;
  const bodies = shown.map((comment) => comment.content).filter((body) => body !== '').join(' — ');
  const omitted = row.omittedCommentCount === 0
    ? ''
    : ` (${String(row.omittedCommentCount)} further comment(s) were not published)`;
  return earlier === 0
    ? `${bodies}${omitted}`
    : `${String(earlier)} earlier repl(y/ies) · ${bodies}${omitted}`;
}

export function advanceAzureThreadReplyWindow(current: number, commentCount: number): number {
  return Math.min(commentCount, current + AZURE_THREAD_REPLY_WINDOW_V1);
}

function ThreadItem({
  onOpenStatus,
  onOpenReply,
  onExpandReplies,
  replyWindow,
  row,
}: Readonly<{
  onOpenStatus: (threadId: string) => void;
  onOpenReply: (threadId: string) => void;
  onExpandReplies: (threadId: string, nextWindow: number) => void;
  replyWindow: number;
  row: AzureProjectedThreadRowV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const earlier = Math.max(0, row.comments.length - replyWindow);
  const expansion = Math.min(earlier, AZURE_THREAD_REPLY_WINDOW_V1);

  return (
    <Item
      title={threadHeadline(row)}
      subtitle={projectAzureThreadSubtitle(row, replyWindow)}
      accessoryOutsidePressable
      accessory={(
        <Row gap="small">
          {earlier === 0 ? null : (
            <Button
              title={text(
                'plugins.azureDevops.ui.showEarlierReplies',
                'Show {count} earlier replies',
                { count: expansion },
              )}
              variant="plain"
              onPress={() => onExpandReplies(
                row.id,
                advanceAzureThreadReplyWindow(replyWindow, row.comments.length),
              )}
            />
          )}
          <Button
            title={text('plugins.azureDevops.ui.threadReplyRow', 'Reply')}
            titleKey="plugins.azureDevops.ui.threadReplyRow"
            variant="plain"
            accessibilityLabel={text(
              'plugins.azureDevops.ui.replyToThread',
              'Reply to thread {thread}',
              { thread: row.id },
            )}
            onPress={() => onOpenReply(row.id)}
          />
          <Button
            title={text('plugins.azureDevops.ui.threadStatusRow', 'Status')}
            titleKey="plugins.azureDevops.ui.threadStatusRow"
            variant="plain"
            accessibilityLabel={text(
              'plugins.azureDevops.ui.setThreadStatus',
              'Set the status of thread {thread}',
              { thread: row.id },
            )}
            onPress={() => onOpenStatus(row.id)}
          />
        </Row>
      )}
    />
  );
}

function ThreadsPanel({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useAzureThreads(input);
  const state: AzureReadStateV1<AzureThreadsViewV1> = controller.state;
  const [window, setWindow] = React.useState(AZURE_THREAD_WINDOW_V1);
  const [replyWindows, setReplyWindows] = React.useState<Readonly<Record<string, number>>>({});
  const [insertAnchor, setInsertAnchor] = React.useState<Readonly<{
    anchorKey: string;
    revision: number;
  }> | null>(null);
  // Which thread's status control is open, and never more than one. Every row carrying its own
  // status picker would put six radio buttons on every line of a review conversation; opening one
  // from the row it belongs to keeps the write beside its thread without burying the thread.
  const [openThreadId, setOpenThreadId] = React.useState<string | null>(null);
  const [openReplyThreadId, setOpenReplyThreadId] = React.useState<string | null>(null);
  const expandReplies = React.useCallback((threadId: string, nextWindow: number) => {
    setInsertAnchor({ anchorKey: threadId, revision: nextWindow });
    setReplyWindows((current) => ({ ...current, [threadId]: nextWindow }));
  }, []);
  const openStatus = React.useCallback((threadId: string) => {
    setOpenReplyThreadId(null);
    setOpenThreadId(threadId);
  }, []);
  const openReply = React.useCallback((threadId: string) => {
    setOpenThreadId(null);
    setOpenReplyThreadId(threadId);
  }, []);

  if (state.kind === 'loading') {
    return <LoadingState title="Reading the threads from Azure DevOps" titleKey="plugins.azureDevops.ui.readingThreads" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The threads are unavailable"
        titleKey="plugins.azureDevops.ui.threadsUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.'),
        )}
      />
    );
  }

  const { rows } = state.value;
  const shown = rows.slice(0, window);
  const remaining = rows.length - shown.length;
  // A thread that scrolled out of the shown window takes its open control with it, rather than
  // leaving a status picker addressing a thread the reader can no longer see.
  const openThread = shown.find((row) => row.id === openThreadId) ?? null;
  const openReplyThread = shown.find((row) => row.id === openReplyThreadId) ?? null;

  return (
    <List
      accessibilityLabel="Review threads on this Azure DevOps pull request"
      accessibilityLabelKey="plugins.azureDevops.ui.threadsLabel"
      {...(insertAnchor === null
        ? {}
        : { preserveVisibleContentPositionOnInsert: insertAnchor })}
      items={shown}
      keyForItem={(row) => row.id}
      header={(
        <Stack gap="small">
          <SettledReadEvidence state={state} />
          {openThread === null ? null : (
            <AzureThreadStatusControl
              input={input}
              thread={openThread}
              onClose={() => setOpenThreadId(null)}
            />
          )}
          {openReplyThread === null ? null : (
            <AzureThreadReplyPublicationControl
              input={input}
              thread={openReplyThread}
            />
          )}
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No threads"
          titleKey="plugins.azureDevops.ui.noThreads"
          description="Nobody has opened a review thread on this pull request yet."
          descriptionKey="plugins.azureDevops.ui.noThreads.description"
        />
      )}
      footer={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.azureDevops.ui.threadsShown"
            fallback="{shown} of {total} thread(s) shown."
            values={{ shown: shown.length, total: rows.length }}
          />
          {remaining > 0
            ? (
              <Button
              title={text(
                'plugins.azureDevops.ui.showMoreThreads',
                'Show {count} more threads',
                { count: Math.min(remaining, AZURE_THREAD_WINDOW_V1) },
              )}
                variant="secondary"
                // No request: the rows are already here, and this only widens
                // the slice the panel renders.
                onPress={() => setWindow((current) => current + AZURE_THREAD_WINDOW_V1)}
              />
            )
            : null}
          <Row gap="small">
            <Action.Refresh
              onRefresh={controller.refresh}
              disabled={state.pending}
              variant="plain"
              accessibilityLabel="Re-read the threads from Azure DevOps"
              accessibilityLabelKey="plugins.azureDevops.ui.rereadThreads"
            />
          </Row>
        </Stack>
      )}
      renderItem={(row) => (
        <ThreadItem
          row={row}
          replyWindow={replyWindows[row.id] ?? AZURE_THREAD_REPLY_WINDOW_V1}
          onExpandReplies={expandReplies}
          onOpenStatus={openStatus}
          onOpenReply={openReply}
        />
      )}
    />
  );
}

/* ------------------------------------------------------------------------ shell */

function AzureDetailBody({
  input,
}: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const { locale } = useSurfaceContext();
  const text = usePluginTranslation();
  const [selected, setSelected] = React.useState<AzureDetailTabIdV1>(AZURE_DEFAULT_DETAIL_TAB_V1);
  // One render-time read, passed down as data, so no child owns a hidden clock.
  const nowMs = Date.now();
  const overview = React.useMemo(() => projectAzureDetailOverview(input), [input]);

  // The body's own lifetime. The iteration read belongs to the ROOT, so it must
  // outlive any one tab: a read that died when `Files` was left would leave
  // `Activity` comparing against nothing.
  const bodyLifetime = React.useMemo(() => new AbortController(), []);
  React.useEffect(() => () => bodyLifetime.abort(), [bodyLifetime]);
  const iterations = useAzureIterations(input, bodyLifetime.signal);

  const panels: Readonly<Record<AzureDetailTabIdV1, React.ReactNode>> = {
    overview: (
      <OverviewPanel
        input={input}
        overview={overview}
        iterations={iterations.state}
        locale={locale}
        nowMs={nowMs}
        onRefreshIterations={iterations.refresh}
      />
    ),
    activity: (
      <ActivityPanel
        input={input}
        iterations={iterations.state}
        locale={locale}
        nowMs={nowMs}
        onRefreshIterations={iterations.refresh}
      />
    ),
    files: (
      <FilesPanel
        input={input}
        iterations={iterations.state}
        onRefreshIterations={iterations.refresh}
      />
    ),
    policies: <PoliciesPanel input={input} />,
    threads: <ThreadsPanel input={input} />,
  };

  return (
    <Screen safeArea>
      <Tabs
        value={selected}
        onValueChange={(next) => {
          // The declarations are the only tab identities this body renders, so a value that is
          // not one of them selects nothing rather than becoming a tab id by assertion.
          const declared = AZURE_DETAIL_TABS_V1.find((candidate) => candidate.id === next);
          if (declared !== undefined) setSelected(declared.id);
        }}
        ariaLabel={text(
          'plugins.azureDevops.ui.tabsLabel',
          'Azure DevOps pull request detail',
        )}
      >
        {AZURE_DETAIL_TABS_V1.map((declaration) => (
          <Tabs.Item
            key={declaration.id}
            value={declaration.id}
            title={text(declaration.titleKey, declaration.title)}
            // Stated, never inherited: the shared primitive would otherwise discard a panel this
            // source means to keep, or keep one it means to discard.
            retention={declaration.retention}
          >
            {panels[declaration.id]}
          </Tabs.Item>
        ))}
      </Tabs>
    </Screen>
  );
}

function AzureDetailSurface(context: RenderContext): React.ReactElement {
  const admitted = React.useMemo(() => {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
    return parsed.success ? { ok: true as const, input: parsed.data } : { ok: false as const };
  }, [context.launchInput]);

  if (!admitted.ok) {
    return (
      <Screen safeArea>
        <ErrorState
          title="This pull request cannot be shown"
          titleKey="plugins.azureDevops.ui.invalidInput"
          description="Triage supplied a detail input this Azure DevOps build does not accept."
          descriptionKey="plugins.azureDevops.ui.invalidInput.description"
        />
      </Screen>
    );
  }

  return <AzureDetailBody input={admitted.input} />;
}

/**
 * The exact export name the build target's Module Federation identity names. Renaming it breaks
 * the native artifact contract, not just this file.
 */
export const renderSurface = defineUiSurface(AzureDetailSurface);
