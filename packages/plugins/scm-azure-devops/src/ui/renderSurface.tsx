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
  TriageActivityTimeline,
  TriageDetailInstance,
  TriageDetailPanel,
  TriageDetailStory,
  TriageDetailChangeSummary,
  TriageDetailChecks,
  type TriageActivityEventV1,
} from '@happier-dev/triage-sources/ui';
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
  /** Absent where the Activity stream owns this collection's continuation. */
  loadMoreTitle?: string;
  onLoadMore?: () => void;
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
      {state.canLoadMore && loadMoreTitle !== undefined && onLoadMore !== undefined
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

/** The write controls as the Triage detail header's `actions` panel (r0.42). */
function AzureActionsPanel({
  input,
  overview,
}: Readonly<{ input: TriageDetailSurfaceInputV1; overview: AzureDetailOverviewV1 }>): React.ReactElement {
  return (
    <Stack gap="small">
      <AzureMutationControls input={input} overview={overview} />
      {overview.state.presentation === 'active'
        ? <AzureReviewPublicationControls input={input} />
        : null}
    </Stack>
  );
}

/**
 * Azure's policy evaluation status vocabulary (`PolicyEvaluationStatus`), as the checks step
 * counts it: `notApplicable` blocks nothing and counts in none of the three, `broken` (the
 * policy could not be evaluated) fails like `rejected`.
 */
const AZURE_POLICY_ROLLUP_V1: Readonly<Record<string, 'passing' | 'failing' | 'running' | 'none'>> = Object.freeze({
  approved: 'passing',
  rejected: 'failing',
  broken: 'failing',
  running: 'running',
  queued: 'running',
  notApplicable: 'none',
});

function AzureStoryChecks({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement | null {
  const { state } = useAzurePolicies(input);
  if (state.kind !== 'ready' || state.failure !== null) return null;
  const view = state.value;
  // Counts need every evaluation: an unread or unparsed row could be the failing one. A shortened
  // display name is not such a row; its status was read whole.
  if (view.evaluationsPartial || view.omittedRowCount > 0) return null;
  const rollup = { failingCount: 0, runningCount: 0, passingCount: 0 };
  const failing: { id: string; name: string }[] = [];
  for (const row of view.evaluations) {
    const counted = Object.hasOwn(AZURE_POLICY_ROLLUP_V1, row.status) ? AZURE_POLICY_ROLLUP_V1[row.status] : undefined;
    // A status outside Azure's documented vocabulary has no aggregate meaning.
    if (counted === undefined) return null;
    if (counted === 'passing') rollup.passingCount += 1;
    else if (counted === 'running') rollup.runningCount += 1;
    else if (counted === 'failing') {
      rollup.failingCount += 1;
      failing.push({ id: row.evaluationId, name: row.displayName ?? row.evaluationId });
    }
  }
  return <TriageDetailChecks title="Policies" titleKey="plugins.azureDevops.ui.tab.policies" rollup={rollup} failing={failing} />;
}

function AzureStoryChanges({ input, iterations, onRefreshIterations }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  iterations: AzureReadStateV1<AzureIterationsViewV1>;
  onRefreshIterations: () => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useAzureIterationChanges(input, iterations.kind === 'ready' ? iterations.value.currentIterationId : undefined);
  const { state } = controller;
  // Azure's iteration changes carry a change type, never line counts: the shared step lists
  // the files with Azure's own word for each change and says the counts are not reported.
  const rows = React.useMemo(() => state.rows.map((row) => ({ path: row.path, note: changedFileSubtitle(row) })), [state.rows]);
  return <TriageDetailChangeSummary rows={state.kind === 'ready' ? rows : []}
    more={state.canLoadMore || state.incomplete !== null}>
    {state.kind === 'idle' || state.kind === 'loading' ? <LoadingState title="Reading changed files" titleKey="plugins.azureDevops.ui.readingFiles" />
      : state.kind === 'unavailable' ? <ErrorState title="The changed files are unavailable" titleKey="plugins.azureDevops.ui.filesUnavailable"
        description={failureDescription(state.failure, text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.'))} />
      : <PageFailureBanner state={state} />}
    {iterations.kind !== 'unavailable' ? null : <Row gap="small">
      <Action.Refresh onRefresh={onRefreshIterations} variant="plain"
        accessibilityLabel="Re-read the pull request iterations from Azure DevOps"
        accessibilityLabelKey="plugins.azureDevops.ui.rereadIterations" />
    </Row>}
  </TriageDetailChangeSummary>;
}

function OverviewPanel({
  input,
  overview,
  iterations,
  locale,
  nowMs,
  onRefreshIterations,
  withWrites = true,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  overview: AzureDetailOverviewV1;
  iterations: AzureReadStateV1<AzureIterationsViewV1>;
  locale: string;
  nowMs: number;
  onRefreshIterations: () => void;
  /** False when the Triage detail places the write controls in its header (r0.42). */
  withWrites?: boolean;
}>): React.ReactElement {
  const text = usePluginTranslation();
  // The story rail (r0.42) draws the facts only: no observation block or empty-state stand-ins.
  // The current iteration lives in Files, its source commit and iterations in Activity.
  const story = !withWrites;
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
      <TriageDetailStory kind={withWrites ? undefined : 'ask'}
        changes={withWrites ? null : <AzureStoryChanges input={input} iterations={iterations} onRefreshIterations={onRefreshIterations} />}
        checks={withWrites ? null : <AzureStoryChecks input={input} />}>
        {input.observation.snapshot.summary === undefined ? null : <Text value={input.observation.snapshot.summary} />}
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
          ? story ? null : <EmptyState title="No projected facts" titleKey="plugins.azureDevops.ui.noFacts" description="This observation carried no displayable facts." descriptionKey="plugins.azureDevops.ui.noFacts.description" />
          : <Metadata title="Facts" titleKey="plugins.azureDevops.ui.facts" entries={entries} />}
        {story || pendingFields.length === 0 ? null : (
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
        {withWrites ? <AzureActionsPanel input={input} overview={overview} /> : null}
        {story ? null : <>
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
        </>}
      </TriageDetailStory>
  );
}

/* -------------------------------------------------------------------- Activity */

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

/** A thread's row controls: widen its reply window, and open its reply or status write. */
function ThreadControls({
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
  );
}

/* -------------------------------------------------------------------- Activity */

/**
 * Activity: the shared iteration projection, this panel's paged commit read and the review
 * threads as one chronological stream.
 *
 * A thread stands at the instant its first comment was published; its latest replies are quoted
 * under it, and its reply and status writes open beside it.
 */
function ActivityStreamPanel({
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
  const commits = useAzureCommits(input);
  const threads = useAzureThreads(input);
  const threadState: AzureReadStateV1<AzureThreadsViewV1> = threads.state;
  const [window, setWindow] = React.useState(AZURE_THREAD_WINDOW_V1);
  const [replyWindows, setReplyWindows] = React.useState<Readonly<Record<string, number>>>({});
  // Which thread's status or reply control is open, and never more than one: every row carrying
  // its own picker would put six radio buttons on every line of a review conversation.
  const [openThreadId, setOpenThreadId] = React.useState<string | null>(null);
  const [openReplyThreadId, setOpenReplyThreadId] = React.useState<string | null>(null);
  const expandReplies = React.useCallback((threadId: string, nextWindow: number) => {
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

  const threadRows = threadState.kind === 'ready' ? threadState.value.rows : [];
  const shownThreads = threadRows.slice(0, window);
  const remainingThreads = threadRows.length - shownThreads.length;
  const iterationRows = iterations.kind === 'ready' ? iterations.value.rows : [];

  const events: readonly TriageActivityEventV1[] = [
    ...iterationRows.map((row): TriageActivityEventV1 => ({
      id: `iteration:${String(row.id)}`,
      atMs: row.createdAtMs ?? null,
      kind: 'change',
      actor: row.author ?? null,
      summary: text('plugins.azureDevops.ui.iterationTitle', 'Iteration {id}', { id: String(row.id) }),
      detail: row.reason ?? row.description ?? text('plugins.azureDevops.ui.iterationUpdated', 'Updated'),
    })),
    ...commits.state.rows.map((row): TriageActivityEventV1 => ({
      id: `commit:${row.commitId}`,
      atMs: row.authoredAtMs ?? null,
      kind: 'change',
      actor: row.author ?? null,
      summary: row.commitId.slice(0, 8),
      detail: row.comment === '' ? null : row.comment,
      ...(row.url === undefined ? {} : {
        href: row.url,
        hrefLabel: text('plugins.azureDevops.ui.openValue', 'Open {item}', { item: row.commitId.slice(0, 8) }),
      }),
    })),
    ...shownThreads.map((row): TriageActivityEventV1 => ({
      id: `thread:${row.id}`,
      atMs: row.comments[0]?.publishedAtMs ?? null,
      kind: 'comment',
      actor: row.comments[0]?.author ?? null,
      summary: threadHeadline(row),
      quote: projectAzureThreadSubtitle(row, replyWindows[row.id] ?? AZURE_THREAD_REPLY_WINDOW_V1),
      inset: (
        <Stack gap="small">
          <ThreadControls
            row={row}
            replyWindow={replyWindows[row.id] ?? AZURE_THREAD_REPLY_WINDOW_V1}
            onExpandReplies={expandReplies}
            onOpenStatus={openStatus}
            onOpenReply={openReply}
          />
          {openThreadId !== row.id ? null : (
            <AzureThreadStatusControl input={input} thread={row} onClose={() => setOpenThreadId(null)} />
          )}
          {openReplyThreadId !== row.id ? null : (
            <AzureThreadReplyPublicationControl input={input} thread={row} />
          )}
        </Stack>
      ),
    })),
  ];

  if (commits.state.kind === 'idle' || commits.state.kind === 'loading' || threadState.kind === 'loading') {
    return <LoadingState title="Reading the commits from Azure DevOps" titleKey="plugins.azureDevops.ui.readingCommits" />;
  }
  const readFailed = text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.');
  if (commits.state.kind === 'unavailable' && threadState.kind === 'unavailable') {
    return (
      <ErrorState
        title="The activity is unavailable"
        titleKey="plugins.azureDevops.ui.activityUnavailable"
        description={failureDescription(commits.state.failure, readFailed)}
      />
    );
  }

  return (
    <TriageActivityTimeline
      events={events}
      locale={locale}
      nowMs={nowMs}
      accessibilityLabel="Commits, iterations and review threads of this Azure DevOps pull request"
      accessibilityLabelKey="plugins.azureDevops.ui.activityLabel"
      header={(
        <Stack gap="small">
          {commits.state.kind === 'unavailable' ? (
            <Banner
              tone="warning"
              title="The activity is unavailable"
              titleKey="plugins.azureDevops.ui.activityUnavailable"
              description={failureDescription(commits.state.failure, readFailed)}
            />
          ) : <PageFailureBanner state={commits.state} />}
          <SettledReadEvidence state={iterations} />
          {iterations.kind === 'unavailable' ? (
            <Banner
              tone="warning"
              title="The iterations could not be read"
              titleKey="plugins.azureDevops.ui.iterationsUnavailable"
              description={failureDescription(iterations.failure, readFailed)}
            />
          ) : null}
          {threadState.kind === 'unavailable' ? (
            <Banner
              tone="warning"
              title="The threads are unavailable"
              titleKey="plugins.azureDevops.ui.threadsUnavailable"
              description={failureDescription(threadState.failure, readFailed)}
            />
          ) : <SettledReadEvidence state={threadState} />}
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
      continuations={[
        // Azure lists a pull request's commits newest first, so the next page is older.
        ...(commits.state.kind === 'ready' && commits.state.canLoadMore ? [{
          key: 'commits',
          title: 'Show 30 more commits',
          pending: commits.state.pending,
          onLoadMore: commits.loadMore,
          reads: 'earlier' as const,
        }] : []),
        // No request: the threads are already here, and this only widens the slice shown.
        ...(remainingThreads > 0 ? [{
          key: 'threads',
          title: text(
            'plugins.azureDevops.ui.showMoreThreads',
            'Show {count} more threads',
            { count: Math.min(remainingThreads, AZURE_THREAD_WINDOW_V1) },
          ),
          pending: false,
          onLoadMore: () => setWindow((current) => current + AZURE_THREAD_WINDOW_V1),
        }] : []),
      ]}
      footer={(
        <Stack gap="small">
          {commits.state.kind === 'unavailable' ? null : (
            <PagedFooter
              state={commits.state}
              onRefresh={() => {
                onRefreshIterations();
                commits.refresh();
              }}
              refreshLabel="Re-read the commits from Azure DevOps"
              refreshLabelKey="plugins.azureDevops.ui.rereadCommits"
              summary={`${String(commits.state.rows.length)} commit(s) read.`}
              summaryKey="plugins.azureDevops.ui.commitsRead"
              summaryValues={{ count: commits.state.rows.length }}
            />
          )}
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.azureDevops.ui.threadsShown"
            fallback="{shown} of {total} thread(s) shown."
            values={{ shown: shownThreads.length, total: threadRows.length }}
          />
          <Row gap="small">
            <Action.Refresh
              onRefresh={threads.refresh}
              disabled={threadState.kind === 'ready' && threadState.pending}
              variant="plain"
              accessibilityLabel="Re-read the threads from Azure DevOps"
              accessibilityLabelKey="plugins.azureDevops.ui.rereadThreads"
            />
          </Row>
        </Stack>
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

  const iterations = useAzureIterations(input);

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
      <ActivityStreamPanel
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
  };

  // The Triage detail asked for one panel (r0.42): its frame draws the tabs.
  // Branch policies are this source's Checks.
  if (input.panel !== undefined) {
    return (
      <Screen safeArea>
        <TriageDetailPanel
          panel={input.panel}
          ariaLabel={text('plugins.azureDevops.ui.tabsLabel', 'Azure DevOps pull request detail')}
          retention={Object.fromEntries(AZURE_DETAIL_TABS_V1
            .map((declaration) => [declaration.id === 'policies' ? 'checks' : declaration.id, declaration.retention]))}
          panels={{
            overview: (
              <OverviewPanel
                input={input}
                overview={overview}
                iterations={iterations.state}
                locale={locale}
                nowMs={nowMs}
                onRefreshIterations={iterations.refresh}
                withWrites={false}
              />
            ),
            activity: panels.activity,
            files: panels.files,
            checks: panels.policies,
            actions: <AzureActionsPanel input={input} overview={overview} />,
          }}
        />
      </Screen>
    );
  }

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

  return <TriageDetailInstance><AzureDetailBody input={admitted.input} /></TriageDetailInstance>;
}

/**
 * The manifest names this exact universal CommonJS export.
 */
export const renderSurface = defineUiSurface(AzureDetailSurface);
