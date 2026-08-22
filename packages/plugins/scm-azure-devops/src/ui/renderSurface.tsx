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
  AzureProjectedThreadRowV1,
} from '../triage/detail/projection.js';

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
  if (state.failure === null) return null;
  return (
    <Banner
      tone="warning"
      title="Showing what was read so far"
      titleKey="plugins.azureDevops.ui.partial"
      description={failureDescription(
        state.failure,
        text('plugins.azureDevops.ui.readFailed', 'Azure DevOps could not complete this read.'),
      )}
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
  summaryKey,
  summaryValues,
}: Readonly<{
  state: AzurePagedStateV1<unknown>;
  loadMoreTitle: string;
  onLoadMore: () => void;
  onRefresh: () => void;
  refreshLabel: string;
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
        />
      </Row>
    </Stack>
  );
}

/* -------------------------------------------------------------------- Overview */

function OverviewPanel({
  overview,
  iterations,
  locale,
  nowMs,
}: Readonly<{
  overview: AzureDetailOverviewV1;
  iterations: AzureReadStateV1<AzureIterationsViewV1>;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const statusFields = overview.fields.filter(
    (field): field is Extract<AzureDetailFieldV1, { kind: 'status' }> => field.kind === 'status',
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
            titleKey="plugins.azureDevops.ui.shortened"
            description="Open the pull request in Azure DevOps to read the complete text."
            descriptionKey="plugins.azureDevops.ui.shortened.description"
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
              {pendingFields.map((field) => <Badge key={field.id} value={field.label} />)}
            </Row>
          </Stack>
        )}
        <Divider />
        <Metadata
          title="Observation"
          titleKey="plugins.azureDevops.ui.observation"
          entries={[
            {
              label: 'Observed',
              value: formatTimestamp(locale, overview.observedAtMs, 'relative', nowMs),
            },
            ...(overview.sourceUpdatedAtMs === null
              ? []
              : [{
                label: 'Azure DevOps last changed',
                value: formatTimestamp(locale, overview.sourceUpdatedAtMs, 'relative', nowMs),
              }]),
            ...(overview.nativeRevision === null
              ? []
              : [{ label: 'Source commit', value: overview.nativeRevision }]),
            // The one iteration fact the root already knows, shown once. It is
            // read here and in no tab.
            ...(iterations.kind === 'ready' && iterations.value.currentIterationId !== undefined
              ? [{ label: 'Current iteration', value: String(iterations.value.currentIterationId) }]
              : []),
          ]}
        />
      </Stack>
    </ScrollArea>
  );
}

/* -------------------------------------------------------------------- Activity */

function commitHeadline(row: AzureProjectedCommitRowV1): string {
  const short = row.commitId.slice(0, 8);
  return row.author === undefined ? short : `${short} · ${row.author}`;
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
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  iterations: AzureReadStateV1<AzureIterationsViewV1>;
  locale: string;
  nowMs: number;
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

  const iterationEntries: readonly MetadataEntry[] = iterations.kind === 'ready'
    ? iterations.value.rows.map((row) => ({
      label: `Iteration ${String(row.id)}`,
      // A push or base-change label is shown only when Azure's own reason
      // supports it; otherwise the neutral native update is what is true.
      value: row.reason ?? row.description ?? 'Updated',
    }))
    : [];

  return (
    <List
      accessibilityLabel="Commits and iterations of this Azure DevOps pull request"
      accessibilityLabelKey="plugins.azureDevops.ui.activityLabel"
      items={state.rows}
      keyForItem={(row) => row.commitId}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
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
            : iterationEntries.length === 0
              ? null
              : <Metadata title="Iterations" titleKey="plugins.azureDevops.ui.iterations" entries={iterationEntries} />}
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
          onRefresh={controller.refresh}
          refreshLabel="Re-read the commits from Azure DevOps"
          summary={`${String(state.rows.length)} commit(s) read.`}
          summaryKey="plugins.azureDevops.ui.commitsRead"
          summaryValues={{ count: state.rows.length }}
        />
      )}
      renderItem={(row) => (
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
      )}
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
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  iterations: AzureReadStateV1<AzureIterationsViewV1>;
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
          onRefresh={controller.refresh}
          refreshLabel="Re-read the changed files from Azure DevOps"
          summary={`${String(state.rows.length)} file(s) read.`}
          summaryKey="plugins.azureDevops.ui.filesRead"
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

  return (
    <ScrollArea>
      <Stack gap="large">
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
            ? [{ label: 'Evaluations', value: view.evaluationsPartial ? 'Unknown' : 'None' }]
            : [
              { label: 'Total', value: String(view.evaluations.length) },
              { label: 'Blocking', value: String(blocking.length) },
              { label: 'Build validations', value: String(builds.length) },
            ]}
        />
        {view.evaluations.length === 0 ? null : (
          <List
            accessibilityLabel="Policy evaluations for this Azure DevOps pull request"
            accessibilityLabelKey="plugins.azureDevops.ui.policyEvaluationsLabel"
            items={view.evaluations}
            keyForItem={(row) => row.evaluationId}
            renderItem={(row) => (
              <Item
                title={row.displayName ?? row.evaluationId}
                subtitle={row.isBlocking ? `${row.status} · required` : `${row.status} · optional`}
                // A missing completion time is unknown, never a zero duration.
                detail={row.completedAtMs === undefined ? 'Completion time unknown' : undefined}
              />
            )}
          />
        )}
        <Divider />
        <List
          accessibilityLabel="Statuses reported against this Azure DevOps pull request"
          accessibilityLabelKey="plugins.azureDevops.ui.statusesLabel"
          items={view.statuses}
          keyForItem={(row) => row.id}
          empty={(
            <EmptyState
              title="No statuses"
              titleKey="plugins.azureDevops.ui.noStatuses"
              description="Nothing has reported a status against this pull request."
              descriptionKey="plugins.azureDevops.ui.noStatuses.description"
            />
          )}
          header={(
            <Text
              variant="caption"
              tone="neutral"
              valueKey="plugins.azureDevops.ui.statusInformational.description"
              fallback="A status is informational unless a policy evaluation above marks it required."
            />
          )}
          renderItem={(row) => (
            <Item
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
          )}
        />
        <Row gap="small">
          <Action.Refresh
            onRefresh={controller.refresh}
            variant="plain"
            accessibilityLabel="Re-read the policies from Azure DevOps"
            accessibilityLabelKey="plugins.azureDevops.ui.rereadPolicies"
          />
        </Row>
      </Stack>
    </ScrollArea>
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
function threadSubtitle(row: AzureProjectedThreadRowV1): string {
  const shown = row.comments.slice(-AZURE_THREAD_REPLY_WINDOW_V1);
  const earlier = row.comments.length - shown.length;
  const bodies = shown.map((comment) => comment.content).filter((body) => body !== '').join(' — ');
  const omitted = row.omittedCommentCount === 0
    ? ''
    : ` (${String(row.omittedCommentCount)} further comment(s) were not published)`;
  return earlier === 0
    ? `${bodies}${omitted}`
    : `${String(earlier)} earlier repl(y/ies) · ${bodies}${omitted}`;
}

function ThreadsPanel({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useAzureThreads(input);
  const state: AzureReadStateV1<AzureThreadsViewV1> = controller.state;
  const [window, setWindow] = React.useState(AZURE_THREAD_WINDOW_V1);

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

  return (
    <List
      accessibilityLabel="Review threads on this Azure DevOps pull request"
      accessibilityLabelKey="plugins.azureDevops.ui.threadsLabel"
      items={shown}
      keyForItem={(row) => row.id}
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
              variant="plain"
              accessibilityLabel="Re-read the threads from Azure DevOps"
              accessibilityLabelKey="plugins.azureDevops.ui.rereadThreads"
            />
          </Row>
        </Stack>
      )}
      renderItem={(row) => (
        <Item title={threadHeadline(row)} subtitle={threadSubtitle(row)} />
      )}
    />
  );
}

/* ------------------------------------------------------------------------ shell */

function AzureDetailBody({
  input,
}: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const { locale } = useSurfaceContext();
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
        overview={overview}
        iterations={iterations.state}
        locale={locale}
        nowMs={nowMs}
      />
    ),
    activity: (
      <ActivityPanel input={input} iterations={iterations.state} locale={locale} nowMs={nowMs} />
    ),
    files: <FilesPanel input={input} iterations={iterations.state} />,
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
        ariaLabel="Azure DevOps pull request detail"
      >
        {AZURE_DETAIL_TABS_V1.map((declaration) => (
          <Tabs.Item
            key={declaration.id}
            value={declaration.id}
            title={declaration.title}
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
