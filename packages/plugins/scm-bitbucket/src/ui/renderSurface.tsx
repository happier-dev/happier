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
 * What it does own are Bitbucket's own facts: the authoritative overview, combined activity
 * stream, raw diff plus diffstat, build statuses, and conversation. Each is a real read with its own
 * lifetime, issued when its tab becomes active and never on mount.
 *
 * Bitbucket serves Diff as a same-origin redirected raw text response paired with JSON diffstat;
 * neither is parsed as the other. There is no Issues
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
  DiffViewer,
  EmptyState,
  ErrorState,
  Item,
  List,
  Markdown,
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
  resolveTriageRowFactStatusToneV1,
  describeTriageSourceFailureV1 as failureDescription,
  formatTriageTimestampV1 as formatTimestamp,
  projectTriageDetailFieldTextV1 as fieldValueText,
} from '@happier-dev/triage-protocol/v1';

import {
  isBitbucketFailingBuildStateV1,
  type BitbucketProjectedCommentRowV1,
  type BitbucketProjectedDiffstatRowV1,
} from '../triage/detail/projection.js';
import {
  projectBitbucketDetailOverview,
  type BitbucketDetailFieldV1,
  type BitbucketDetailOverviewV1,
} from '../triage/source/detail.js';

import {
  TriageActivityTimeline,
  TriageDetailPanel,
  TriageDetailStory,
  TriageDetailChangeSummary,
  TriageDetailChecks,
  type TriageActivityEventV1,
  type TriageActivityKindV1,
} from '@happier-dev/triage-sources/ui';
import {
  BitbucketCommentResolutionControls,
  BitbucketMutationControls,
  BitbucketReviewCommentReplyControls,
} from './detail/mutations.js';
import {
  useBitbucketActivity,
  useBitbucketBuilds,
  useBitbucketComments,
  useBitbucketDiff,
  useBitbucketOverview,
} from './detail/panelReaders.js';
import type { BitbucketPagedStateV1 } from './detail/panelState.js';
import { bitbucketBuildToneV1 } from './detail/rowTone.js';
import {
  BITBUCKET_DEFAULT_DETAIL_TAB_V1,
  BITBUCKET_DETAIL_TABS_V1,
  type BitbucketDetailTabIdV1,
} from './detail/tabDeclarations.js';


/**
 * The banner a later-page failure owes its reader.
 *
 * It appears only over rows that already arrived. A first-page failure is a different
 * presentation entirely — the panel says it could not look.
 */
function PageFailureBanner({
  state,
}: Readonly<{ state: BitbucketPagedStateV1<unknown> }>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (state.failure === null) return null;
  return (
    <Banner
      tone="warning"
      title="Showing what was read so far"
      titleKey="plugins.bitbucket.ui.partial"
      description={failureDescription(
        state.failure,
        text('plugins.bitbucket.ui.readFailed', 'Bitbucket could not complete this read.'),
      )}
    />
  );
}

/** The footer every paged panel shares: what was read, and how to ask for more. */
function PagedFooter({
  state,
  loadMoreTitle,
  loadMoreTitleKey,
  onLoadMore,
  onRefresh,
  refreshLabel,
  refreshLabelKey,
  summary,
  summaryKey,
  summaryValues,
}: Readonly<{
  state: BitbucketPagedStateV1<unknown>;
  /** Absent where the Activity stream owns this collection's continuation. */
  loadMoreTitle?: string;
  loadMoreTitleKey?: string;
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
      {state.omittedRowCount === 0 ? null : (
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.bitbucket.ui.rowsUnreadable"
          fallback="{count} provider row(s) could not be included in this result."
          values={{ count: state.omittedRowCount }}
        />
      )}
      {state.incomplete === null ? null : (
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.bitbucket.ui.paginationIncomplete"
          fallback="Bitbucket offered another page, but this build could not carry its position, so this list stops here."
        />
      )}
      {state.canLoadMore && loadMoreTitle !== undefined && onLoadMore !== undefined
        ? (
          <Button
            title={loadMoreTitle}
            {...(loadMoreTitleKey === undefined ? {} : { titleKey: loadMoreTitleKey })}
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

/**
 * The mounted input with the latest overview read applied, and its projection:
 * the facts the overview shows and the write controls dispatch against.
 */
function bitbucketEffectiveOverview(
  input: TriageDetailSurfaceInputV1,
  result: ReturnType<typeof useBitbucketOverview>['result'],
) {
  const overviewResult = result?.kind === 'overview' ? result : null;
  const freshObservation = overviewResult?.observation.kind === 'present'
    ? overviewResult.observation
    : null;
  const {
    nativeRevision: _launchNativeRevision,
    sourceUpdatedAtMs: _launchSourceUpdatedAtMs,
    ...stableLaunchObservation
  } = input.observation;
  const effectiveInput = freshObservation === null || overviewResult === null ? input : {
    ...input,
    observation: {
      ...stableLaunchObservation,
      locator: freshObservation.locator,
      snapshot: freshObservation.snapshot,
      viewer: freshObservation.viewer,
      observedAtMs: overviewResult.observedAtMs,
      ...(freshObservation.nativeRevision === undefined
        ? {}
        : { nativeRevision: freshObservation.nativeRevision }),
      ...(freshObservation.sourceUpdatedAtMs === undefined
        ? {}
        : { sourceUpdatedAtMs: freshObservation.sourceUpdatedAtMs }),
    },
  };
  const overview: BitbucketDetailOverviewV1 = projectBitbucketDetailOverview(effectiveInput);
  return { overviewResult, effectiveInput, overview };
}

/** The write controls as the Triage detail header's `actions` panel (r0.42). */
function BitbucketActionsPanel({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement | null {
  const controller = useBitbucketOverview(input);
  const { effectiveInput, overview } = bitbucketEffectiveOverview(input, controller.result);
  return <BitbucketMutationControls input={effectiveInput} overview={overview} />;
}

function BitbucketStoryChanges({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useBitbucketDiff(input);
  const { state } = controller;
  // Bitbucket's diffstat counts lines per file; it states no whole-change totals, so the
  // shared step sums the pages read and says "N+ files" while more remain.
  const rows = React.useMemo(() => state.rows.map((row) => ({
    path: row.path, lines: { additions: row.linesAdded, deletions: row.linesRemoved },
  })), [state.rows]);
  return <TriageDetailChangeSummary rows={state.kind === 'ready' ? rows : []}
    more={state.canLoadMore || state.incomplete !== null}>
    {state.kind === 'idle' || state.kind === 'loading' ? <LoadingState title="Reading changed files" titleKey="plugins.bitbucket.ui.readingDiff" />
      : state.kind === 'unavailable' ? <ErrorState title="The diff is unavailable" titleKey="plugins.bitbucket.ui.diffUnavailable"
        description={failureDescription(state.failure, text('plugins.bitbucket.ui.readFailed', 'Bitbucket could not complete this read.'))} />
      : <PageFailureBanner state={state} />}
  </TriageDetailChangeSummary>;
}

function BitbucketStoryChecks({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement | null {
  const { state, rollup } = useBitbucketBuilds(input);
  return <TriageDetailChecks title="Builds" titleKey="plugins.bitbucket.ui.tabs.builds" rollup={state.kind === 'ready' ? rollup : null}
    failing={state.rows.filter((row) => isBitbucketFailingBuildStateV1(row.state)).map((row) => ({ id: row.key, name: row.name }))}>
    <PageFailureBanner state={state} />
  </TriageDetailChecks>;
}

function OverviewPanel({
  input,
  locale,
  nowMs,
  withWrites = true,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
  /** False when the Triage detail places the write controls in its header (r0.42). */
  withWrites?: boolean;
}>): React.ReactElement {
  const text = usePluginTranslation();
  // The story rail (r0.42) draws the facts only: no observation block, empty-state stand-ins or Re-read chrome.
  const story = !withWrites;
  const controller = useBitbucketOverview(input);
  const { overviewResult, effectiveInput, overview } = bitbucketEffectiveOverview(input, controller.result);
  const description = overviewResult === null ? overview.summary : overviewResult.description;
  const statusFields = overview.fields.filter(
    (field): field is Extract<BitbucketDetailFieldV1, { kind: 'status' }> => field.kind === 'status',
  );
  const pendingFields = overview.fields.filter((field) => field.kind === 'pending');
  const entries: readonly MetadataEntry[] = overview.fields.flatMap((field) => {
    if (field.kind === 'pending' || field.kind === 'status') return [];
    const value = fieldValueText(field, locale, nowMs);
    return value === null ? [] : [{
      label: text(`plugins.bitbucket.ui.field.${field.id.replace('bitbucket/', '')}`, field.label),
      value,
    }];
  });

  return (
      <TriageDetailStory kind={withWrites ? undefined : 'ask'}
        changes={withWrites ? null : <BitbucketStoryChanges input={input} />}
        checks={withWrites ? null : <BitbucketStoryChecks input={input} />}>
        {controller.failure === null ? null : (
          <Banner
            tone="warning"
            title={text('plugins.bitbucket.ui.partial', 'Showing what was read so far')}
            description={failureDescription(
              controller.failure,
              text('plugins.bitbucket.ui.overviewRefreshFailed', 'Bitbucket could not refresh this overview.'),
            )}
          />
        )}
        {!(overview.projectionTruncated || overviewResult?.descriptionTruncated) ? null : (
          <Banner
            tone="neutral"
            title="Some details were shortened"
            titleKey="plugins.bitbucket.ui.shortened"
            description="Open the pull request in Bitbucket to read the complete text."
            descriptionKey="plugins.bitbucket.ui.shortened.description"
          />
        )}
        {description === null ? null : (
          <Stack gap="small">
            <Text variant="caption" tone="neutral" valueKey="plugins.bitbucket.ui.description" fallback="Description" />
            <Markdown value={description} />
          </Stack>
        )}
        {statusFields.length === 0 ? null : (
          <Row gap="small">
            {statusFields.map((field) => (
              <Status key={field.id} tone={resolveTriageRowFactStatusToneV1(field.tone)} label={`${text(`plugins.bitbucket.ui.field.${field.id.replace('bitbucket/', '')}`, field.label)}: ${field.value}`} />
            ))}
          </Row>
        )}
        {entries.length === 0
          ? story ? null : <EmptyState title="No projected facts" titleKey="plugins.bitbucket.ui.noFacts" description="This observation carried no displayable facts." descriptionKey="plugins.bitbucket.ui.noFacts.description" />
          : <Metadata title="Facts" titleKey="plugins.bitbucket.ui.facts" entries={entries} />}
        {story || pendingFields.length === 0 ? null : (
          <Stack gap="small">
            <Text
              variant="caption"
              tone="neutral"
              valueKey="plugins.bitbucket.ui.pendingPanels.description"
              fallback="Answered in the panels beside this one, not on the list row:"
            />
            <Row gap="small">
              {pendingFields.map((field) => <Badge key={field.id} value={text(`plugins.bitbucket.ui.field.${field.id.replace('bitbucket/', '')}`, field.label)} />)}
            </Row>
          </Stack>
        )}
        {/*
          * The writes live on Overview because it is the tab a detail opens on and the one that
          * already states what this pull request currently is. A tab of their own would put a
          * destructive control behind a click that says nothing about what is behind it.
          */}
        {withWrites ? <BitbucketMutationControls input={effectiveInput} overview={overview} /> : null}
        {story ? null : <Divider />}
        {story ? null : (
          <Metadata
            title="Observation"
            titleKey="plugins.bitbucket.ui.observation"
            entries={[
              {
                label: text('plugins.bitbucket.ui.observed', 'Observed'),
                value: formatTimestamp(locale, overview.observedAtMs, 'relative', nowMs),
              },
              ...(overview.sourceUpdatedAtMs === null
                ? []
                : [{
                  label: text('plugins.bitbucket.ui.lastChanged', 'Bitbucket last changed'),
                  value: formatTimestamp(locale, overview.sourceUpdatedAtMs, 'relative', nowMs),
                }]),
            ]}
          />
        )}
        {story && controller.failure === null ? null : (
          <Action.Refresh
            onRefresh={controller.refresh}
            disabled={controller.pending}
            variant="plain"
            accessibilityLabel="Re-read this overview from Bitbucket"
            accessibilityLabelKey="plugins.bitbucket.ui.rereadOverview"
          />
        )}
      </TriageDetailStory>
  );
}

/* ------------------------------------------------------------------------ Diff */

function DiffPanel({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useBitbucketDiff(input);
  const { state } = controller;
  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading this diff from Bitbucket" titleKey="plugins.bitbucket.ui.readingDiff" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The diff is unavailable"
        titleKey="plugins.bitbucket.ui.diffUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.bitbucket.ui.readFailed', 'Bitbucket could not complete this read.'),
        )}
      />
    );
  }
  return (
    <ScrollArea>
      <Stack gap="large">
        <PageFailureBanner state={state} />
        {controller.raw?.kind !== 'tooLarge' ? null : (
          <Banner
            tone="warning"
            title="This diff is too large for Bitbucket to return"
            titleKey="plugins.bitbucket.ui.diffTooLarge"
            description="The pull request remains available; open it in Bitbucket for the full diff."
            descriptionKey="plugins.bitbucket.ui.diffTooLarge.description"
          />
        )}
        {controller.raw?.kind !== 'available' ? null : (
          <Stack gap="small">
            {controller.raw.truncated ? (
              <Banner
                tone="neutral"
                title="The raw diff was shortened"
                titleKey="plugins.bitbucket.ui.rawDiffShortened"
                description="The returned prefix fits Happier's Action-result boundary."
                descriptionKey="plugins.bitbucket.ui.rawDiffShortened.description"
              />
            ) : null}
            <DiffViewer
              unifiedDiff={controller.raw.text}
              label={text('plugins.bitbucket.ui.tabs.diff', 'Diff')}
              testID="bitbucket-pull-request-diff"
            />
          </Stack>
        )}
        <Metadata
          title="Changed files"
          titleKey="plugins.bitbucket.ui.changedFiles"
          entries={state.rows.map((row: BitbucketProjectedDiffstatRowV1) => ({
            label: row.path,
            value: `${row.status} · +${String(row.linesAdded)} −${String(row.linesRemoved)}`,
          }))}
        />
        <PagedFooter
          state={state}
          loadMoreTitle="Show more changed files"
          loadMoreTitleKey="plugins.bitbucket.ui.showMoreFiles"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read this diff from Bitbucket"
          refreshLabelKey="plugins.bitbucket.ui.rereadDiff"
          summary={`${String(state.rows.length)} changed file(s) read.`}
          summaryKey="plugins.bitbucket.ui.diffFilesRead"
          summaryValues={{ count: state.rows.length }}
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

const ACTIVITY_KINDS: Readonly<Record<string, TriageActivityKindV1 | undefined>> = Object.freeze({
  approval: 'review',
  changesRequested: 'review',
  update: 'change',
  comment: 'comment',
});

function activityHeadline(
  text: ReturnType<typeof usePluginTranslation>,
  kind: string,
): string {
  // Unknown provider kinds retain the row itself, but use neutral localized chrome rather than
  // exposing an untranslated provider token as authored UI.
  return text(`plugins.bitbucket.ui.activity.${kind}`, ACTIVITY_HEADLINES[kind] ?? 'Activity');
}

/* ---------------------------------------------------------------------- Builds */

function BuildsPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useBitbucketBuilds(input);
  const { rollup, state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the builds from Bitbucket" titleKey="plugins.bitbucket.ui.readingBuilds" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The builds are unavailable"
        titleKey="plugins.bitbucket.ui.buildsUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.bitbucket.ui.readFailed', 'Bitbucket could not complete this read.'),
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
      { label: text('plugins.bitbucket.ui.status.failing', 'Failing'), value: String(rollup.failingCount) },
      { label: text('plugins.bitbucket.ui.status.running', 'Running'), value: String(rollup.runningCount ?? 0) },
      { label: text('plugins.bitbucket.ui.status.passing', 'Passing'), value: String(rollup.passingCount ?? 0) },
    ];

  return (
    <List
      accessibilityLabel="Build statuses reported against this Bitbucket pull request"
      accessibilityLabelKey="plugins.bitbucket.ui.buildsLabel"
      items={state.rows}
      keyForItem={(row) => row.key}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          {rollupEntries.length > 0
            ? <Metadata title="All reported builds" titleKey="plugins.bitbucket.ui.allBuilds" entries={rollupEntries} />
            : state.rows.length === 0
              ? null
              : (
                <Text
                  variant="caption"
                  tone="neutral"
                  valueKey="plugins.bitbucket.ui.buildsTruncated.description"
                  fallback="Bitbucket has more build statuses than this page holds, so no totals are shown for them."
                />
              )}
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No builds"
          titleKey="plugins.bitbucket.ui.noBuilds"
          description="No build has reported a status against this pull request."
          descriptionKey="plugins.bitbucket.ui.noBuilds.description"
        />
      )}
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle="Show more builds"
          loadMoreTitleKey="plugins.bitbucket.ui.showMoreBuilds"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read the builds from Bitbucket"
          refreshLabelKey="plugins.bitbucket.ui.rereadBuilds"
          summary={`${String(state.rows.length)} build status(es) read.`}
          summaryKey="plugins.bitbucket.ui.buildStatusesRead"
          summaryValues={{ count: state.rows.length }}
        />
      )}
      renderItem={(row) => (
        <Item
          title={row.name}
          subtitle={row.description ?? row.state}
          tone={bitbucketBuildToneV1(row)}
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
                  accessibilityLabel={text(
                    'plugins.bitbucket.ui.openResults',
                    'Open results for {item}',
                    { item: row.name },
                  )}
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

function commentDetail(
  text: ReturnType<typeof usePluginTranslation>,
  row: BitbucketProjectedCommentRowV1,
): string {
  return [
    `#${row.id}`,
    ...(row.parentId === undefined ? [] : [text('plugins.bitbucket.ui.reply', 'reply')]),
    ...(row.editedAtMs === undefined ? [] : [text('plugins.bitbucket.ui.edited', 'edited')]),
    text(`plugins.bitbucket.ui.resolution.${row.resolution}`, RESOLUTION_LABELS[row.resolution] ?? 'Resolution not reported'),
  ].join(' · ');
}

/**
 * Activity: Bitbucket's activity collection and its comment collection as one chronological
 * stream.
 *
 * The activity collection repeats every comment as a `comment` arm keyed by the comment's own
 * id. The comment collection owns those remarks (their resolution and controls), so an arm whose
 * comment that read already returned is dropped rather than shown twice; an arm whose comment
 * has not been paged in yet still stands for it.
 */
function ActivityStreamPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const activity = useBitbucketActivity(input);
  const comments = useBitbucketComments(input);
  const [expandedParents, setExpandedParents] = React.useState<ReadonlySet<string>>(() => new Set());
  const commentRows = comments.state.rows;
  const replyGroups = React.useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const row of commentRows) {
      if (row.parentId === undefined) continue;
      const replies = groups.get(row.parentId);
      if (replies) replies.push(row.id);
      else groups.set(row.parentId, [row.id]);
    }
    return groups;
  }, [commentRows]);
  const visibleComments = React.useMemo(() => {
    const precedingVisibility = new Map<string, boolean>();
    // Keep provider order, including when a later page brings another reply. Missing
    // parents never hide returned evidence or manufacture a synthetic root comment.
    // A parent returned after its replies must not retroactively hide a visible
    // orphan when appending a page and move the reader's existing viewport.
    return commentRows.filter((row) => {
      const visible = row.parentId === undefined
        || !precedingVisibility.has(row.parentId)
        || (precedingVisibility.get(row.parentId) === true
          && (expandedParents.has(row.parentId)
            || replyGroups.get(row.parentId)?.[0] === row.id));
      precedingVisibility.set(row.id, visible);
      return visible;
    });
  }, [commentRows, expandedParents, replyGroups]);

  const events = React.useMemo((): readonly TriageActivityEventV1[] => {
    const readComments = new Set(commentRows.map((row) => `comment:${row.id}`));
    const activityEvents = activity.state.rows
      .filter((row) => row.kind !== 'comment' || !readComments.has(row.key))
      .map((row): TriageActivityEventV1 => ({
        id: `activity:${row.key}`,
        atMs: row.atMs ?? null,
        kind: ACTIVITY_KINDS[row.kind] ?? 'other',
        actor: row.actor ?? null,
        summary: activityHeadline(text, row.kind),
        ...(row.kind === 'comment' ? { quote: row.summary ?? null } : { detail: row.summary ?? null }),
      }));
    const commentEvents = visibleComments.map((row): TriageActivityEventV1 => ({
      id: `comment:${row.id}`,
      atMs: row.atMs ?? null,
      kind: 'comment',
      actor: row.author ?? text('plugins.bitbucket.ui.someone', 'Someone'),
      summary: activityHeadline(text, 'comment'),
      detail: commentDetail(text, row),
      quote: row.deleted ? text('plugins.bitbucket.ui.commentDeleted', 'This comment was deleted.') : row.body,
      ...(row.url === undefined ? {} : {
        href: row.url,
        hrefLabel: text('plugins.bitbucket.ui.openComment', 'Open this comment in Bitbucket'),
      }),
      inset: (
        <Stack gap="small">
          <BitbucketCommentResolutionControls input={input} comment={row} />
          {row.parentId === undefined ? null : (
            <Text
              variant="caption"
              valueKey="plugins.bitbucket.ui.replyToComment"
              fallback="Reply to comment {id}"
              values={{ id: row.parentId }}
            />
          )}
          {(replyGroups.get(row.id)?.length ?? 0) > 1 && !expandedParents.has(row.id) ? (
            <Button
              title="Show returned replies"
              titleKey="plugins.bitbucket.ui.showReturnedReplies"
              variant="plain"
              onPress={() => setExpandedParents((previous) => new Set([...previous, row.id]))}
            />
          ) : null}
        </Stack>
      ),
    }));
    return [...activityEvents, ...commentEvents];
  }, [activity.state.rows, commentRows, expandedParents, input, replyGroups, text, visibleComments]);

  const settling = (state: BitbucketPagedStateV1<unknown>) => state.kind === 'idle' || state.kind === 'loading';
  if (settling(activity.state) || settling(comments.state)) {
    return <LoadingState title="Reading this activity from Bitbucket" titleKey="plugins.bitbucket.ui.readingActivity" />;
  }
  const readFailed = text('plugins.bitbucket.ui.readFailed', 'Bitbucket could not complete this read.');
  if (activity.state.kind === 'unavailable' && comments.state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The activity is unavailable"
        titleKey="plugins.bitbucket.ui.activityUnavailable"
        description={failureDescription(activity.state.failure, readFailed)}
      />
    );
  }
  return (
    <TriageActivityTimeline
      events={events}
      locale={locale}
      nowMs={nowMs}
      accessibilityLabel="Activity Bitbucket recorded for this pull request"
      accessibilityLabelKey="plugins.bitbucket.ui.activityLabel"
      header={(
        <Stack gap="small">
          {activity.state.kind === 'unavailable' ? (
            <Banner
              tone="warning"
              title="The activity is unavailable"
              titleKey="plugins.bitbucket.ui.activityUnavailable"
              description={failureDescription(activity.state.failure, readFailed)}
            />
          ) : <PageFailureBanner state={activity.state} />}
          {comments.state.kind === 'unavailable' ? (
            <Banner
              tone="warning"
              title="The comments are unavailable"
              titleKey="plugins.bitbucket.ui.commentsUnavailable"
              description={failureDescription(comments.state.failure, readFailed)}
            />
          ) : <PageFailureBanner state={comments.state} />}
          <BitbucketReviewCommentReplyControls input={input} comments={commentRows} />
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No recorded activity"
          titleKey="plugins.bitbucket.ui.noActivity"
          description="Bitbucket has recorded nothing on this pull request yet."
          descriptionKey="plugins.bitbucket.ui.noActivity.description"
        />
      )}
      continuations={[
        ...(activity.state.kind === 'ready' && activity.state.canLoadMore ? [{
          key: 'activity',
          title: 'Show more activity',
          titleKey: 'plugins.bitbucket.ui.showMoreActivity',
          pending: activity.state.pending,
          onLoadMore: activity.loadMore,
        }] : []),
        // Deliberately not "earlier": Bitbucket publishes pagination but no
        // chronological ordering contract for this collection.
        ...(comments.state.kind === 'ready' && comments.state.canLoadMore ? [{
          key: 'comments',
          title: 'Show 30 more comments',
          titleKey: 'plugins.bitbucket.ui.showMoreComments',
          pending: comments.state.pending,
          onLoadMore: comments.loadMore,
        }] : []),
      ]}
      footer={(
        <Stack gap="small">
          {activity.state.kind === 'ready' ? (
            <PagedFooter
              state={activity.state}
              onRefresh={activity.refresh}
              refreshLabel="Re-read this activity from Bitbucket"
              refreshLabelKey="plugins.bitbucket.ui.rereadActivity"
              summary={`${String(activity.state.rows.length)} entry/entries read.`}
              summaryKey="plugins.bitbucket.ui.entriesRead"
              summaryValues={{ count: activity.state.rows.length }}
            />
          ) : null}
          {comments.state.kind === 'ready' ? (
            <PagedFooter
              state={comments.state}
              onRefresh={comments.refresh}
              refreshLabel="Re-read the comments from Bitbucket"
              refreshLabelKey="plugins.bitbucket.ui.rereadComments"
              summary={`${String(comments.state.rows.length)} comment(s) read.`}
              summaryKey="plugins.bitbucket.ui.commentsRead"
              summaryValues={{ count: comments.state.rows.length }}
            />
          ) : null}
        </Stack>
      )}
    />
  );
}

/* ------------------------------------------------------------------------ shell */

function BitbucketDetailBody({
  input,
}: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const { locale } = useSurfaceContext();
  const text = usePluginTranslation();
  const [selected, setSelected] = React.useState<BitbucketDetailTabIdV1>(
    BITBUCKET_DEFAULT_DETAIL_TAB_V1,
  );
  // One render-time read, passed down as data, so no child owns a hidden clock.
  const nowMs = Date.now();
  const panels: Readonly<Record<BitbucketDetailTabIdV1, React.ReactNode>> = {
    overview: <OverviewPanel input={input} locale={locale} nowMs={nowMs} />,
    activity: <ActivityStreamPanel input={input} locale={locale} nowMs={nowMs} />,
    diff: <DiffPanel input={input} />,
    builds: <BuildsPanel input={input} locale={locale} nowMs={nowMs} />,
  };

  // The Triage detail asked for one panel (r0.42): its frame draws the tabs.
  // The diff is Files and builds are Checks.
  if (input.panel !== undefined) {
    return (
      <Screen safeArea>
        <TriageDetailPanel
          panel={input.panel}
          ariaLabel={text('plugins.bitbucket.ui.detailLabel', 'Bitbucket pull request detail')}
          retention={Object.fromEntries(BITBUCKET_DETAIL_TABS_V1
            .map((declaration) => [declaration.id === 'diff' ? 'files' : declaration.id === 'builds' ? 'checks' : declaration.id, declaration.retention]))}
          panels={{
            overview: <OverviewPanel input={input} locale={locale} nowMs={nowMs} withWrites={false} />,
            activity: panels.activity,
            files: panels.diff,
            checks: panels.builds,
            actions: <BitbucketActionsPanel input={input} />,
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
          const declared = BITBUCKET_DETAIL_TABS_V1.find((candidate) => candidate.id === next);
          if (declared !== undefined) setSelected(declared.id);
        }}
        ariaLabel={text('plugins.bitbucket.ui.detailLabel', 'Bitbucket pull request detail')}
      >
        {BITBUCKET_DETAIL_TABS_V1.map((declaration) => (
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
          titleKey="plugins.bitbucket.ui.invalidInput"
          description="Triage supplied a detail input this Bitbucket build does not accept."
          descriptionKey="plugins.bitbucket.ui.invalidInput.description"
        />
      </Screen>
    );
  }

  return <BitbucketDetailBody input={admitted.input} />;
}

/**
 * The manifest names this exact universal CommonJS export.
 */
export const renderSurface = defineUiSurface(BitbucketDetailSurface);
