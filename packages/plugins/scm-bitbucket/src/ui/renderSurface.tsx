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

import type {
  BitbucketProjectedActivityRowV1,
  BitbucketProjectedCommentRowV1,
  BitbucketProjectedDiffstatRowV1,
  BitbucketProjectedStatusRowV1,
} from '../triage/detail/projection.js';
import {
  projectBitbucketDetailOverview,
  type BitbucketDetailFieldV1,
  type BitbucketDetailOverviewV1,
} from '../triage/source/detail.js';

import {
  BitbucketCommentResolutionControls,
  BitbucketMutationControls,
} from './detail/mutations.js';
import {
  useBitbucketActivity,
  useBitbucketBuilds,
  useBitbucketComments,
  useBitbucketDiff,
  useBitbucketOverview,
} from './detail/panelReaders.js';
import type { BitbucketPagedStateV1 } from './detail/panelState.js';
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
  onLoadMore,
  onRefresh,
  refreshLabel,
  summary,
  summaryKey,
  summaryValues,
}: Readonly<{
  state: BitbucketPagedStateV1<unknown>;
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
      {state.omittedRowCount === 0 ? null : (
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.bitbucket.ui.rowsUnreadable"
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
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const controller = useBitbucketOverview(input);
  const overviewResult = controller.result?.kind === 'overview' ? controller.result : null;
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
        {controller.result?.kind !== 'unavailable' ? null : (
          <Banner
            tone="warning"
            title="Showing the launch observation"
            description={failureDescription(
              controller.result.failure,
              'Bitbucket could not refresh this overview.',
            )}
          />
        )}
        {!overview.projectionTruncated ? null : (
          <Banner
            tone="neutral"
            title="Some details were shortened"
            titleKey="plugins.bitbucket.ui.shortened"
            description="Open the pull request in Bitbucket to read the complete text."
            descriptionKey="plugins.bitbucket.ui.shortened.description"
          />
        )}
        {overview.summary === null ? null : (
          <Stack gap="small">
            <Text variant="caption" tone="neutral" fallback="Description" />
            <Text value={overview.summary} />
          </Stack>
        )}
        {statusFields.length === 0 ? null : (
          <Row gap="small">
            {statusFields.map((field) => (
              <Status key={field.id} tone={field.tone} label={`${field.label}: ${field.value}`} />
            ))}
          </Row>
        )}
        {entries.length === 0
          ? <EmptyState title="No projected facts" titleKey="plugins.bitbucket.ui.noFacts" description="This observation carried no displayable facts." descriptionKey="plugins.bitbucket.ui.noFacts.description" />
          : <Metadata title="Facts" titleKey="plugins.bitbucket.ui.facts" entries={entries} />}
        {pendingFields.length === 0 ? null : (
          <Stack gap="small">
            <Text
              variant="caption"
              tone="neutral"
              valueKey="plugins.bitbucket.ui.pendingPanels.description"
              fallback="Answered in the panels beside this one, not on the list row:"
            />
            <Row gap="small">
              {pendingFields.map((field) => <Badge key={field.id} value={field.label} />)}
            </Row>
          </Stack>
        )}
        {/*
          * The writes live on Overview because it is the tab a detail opens on and the one that
          * already states what this pull request currently is. A tab of their own would put a
          * destructive control behind a click that says nothing about what is behind it.
          */}
        <BitbucketMutationControls input={effectiveInput} overview={overview} />
        <Divider />
        <Metadata
          title="Observation"
          titleKey="plugins.bitbucket.ui.observation"
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
        <Action.Refresh
          onRefresh={controller.refresh}
          disabled={controller.pending}
          variant="plain"
          accessibilityLabel="Re-read this overview from Bitbucket"
        />
      </Stack>
    </ScrollArea>
  );
}

/* ------------------------------------------------------------------------ Diff */

function DiffPanel({ input }: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useBitbucketDiff(input);
  const { state } = controller;
  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading this diff from Bitbucket" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The diff is unavailable"
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
            description="The pull request remains available; open it in Bitbucket for the full diff."
          />
        )}
        {controller.raw?.kind !== 'available' ? null : (
          <Stack gap="small">
            {controller.raw.truncated ? (
              <Banner
                tone="neutral"
                title="The raw diff was shortened"
                description="The returned prefix fits Happier's Action-result boundary."
              />
            ) : null}
            <Text variant="code" value={controller.raw.text} />
          </Stack>
        )}
        <Metadata
          title="Changed files"
          entries={state.rows.map((row: BitbucketProjectedDiffstatRowV1) => ({
            label: row.path,
            value: `${row.status} · +${String(row.linesAdded)} −${String(row.linesRemoved)}`,
          }))}
        />
        <PagedFooter
          state={state}
          loadMoreTitle="Show more changed files"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read this diff from Bitbucket"
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
  const text = usePluginTranslation();
  const controller = useBitbucketActivity(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading this activity from Bitbucket" titleKey="plugins.bitbucket.ui.readingActivity" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The activity is unavailable"
        titleKey="plugins.bitbucket.ui.activityUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.bitbucket.ui.readFailed', 'Bitbucket could not complete this read.'),
        )}
      />
    );
  }
  return (
    <List
      accessibilityLabel="Activity Bitbucket recorded for this pull request"
      accessibilityLabelKey="plugins.bitbucket.ui.activityLabel"
      items={state.rows}
      keyForItem={(row) => row.key}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.bitbucket.ui.activityCollection.description"
            fallback="Bitbucket serves approvals, updates and comments from one collection, so this is all of them."
          />
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
      footer={(
        <PagedFooter
          state={state}
          loadMoreTitle="Show more activity"
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read this activity from Bitbucket"
          summary={`${String(state.rows.length)} entry/entries read.`}
          summaryKey="plugins.bitbucket.ui.entriesRead"
          summaryValues={{ count: state.rows.length }}
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
      { label: 'Failing', value: String(rollup.failingCount) },
      { label: 'Running', value: String(rollup.runningCount ?? 0) },
      { label: 'Passing', value: String(rollup.passingCount ?? 0) },
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
          onLoadMore={controller.loadMore}
          onRefresh={controller.refresh}
          refreshLabel="Re-read the builds from Bitbucket"
          summary={`${String(state.rows.length)} build status(es) read.`}
          summaryKey="plugins.bitbucket.ui.buildStatusesRead"
          summaryValues={{ count: state.rows.length }}
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
  const text = usePluginTranslation();
  const controller = useBitbucketComments(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the comments from Bitbucket" titleKey="plugins.bitbucket.ui.readingComments" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The comments are unavailable"
        titleKey="plugins.bitbucket.ui.commentsUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.bitbucket.ui.readFailed', 'Bitbucket could not complete this read.'),
        )}
      />
    );
  }
  return (
    <List
      accessibilityLabel="Comments on this Bitbucket pull request"
      accessibilityLabelKey="plugins.bitbucket.ui.commentsLabel"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={<PageFailureBanner state={state} />}
      empty={(
        <EmptyState
          title="No comments"
          titleKey="plugins.bitbucket.ui.noComments"
          description="Nobody has commented on this pull request yet."
          descriptionKey="plugins.bitbucket.ui.noComments.description"
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
          summaryKey="plugins.bitbucket.ui.commentsRead"
          summaryValues={{ count: state.rows.length }}
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
                  accessibilityLabelKey="plugins.bitbucket.ui.openComment"
                />
              ),
            })}
        >
          {/*
            * The resolve and reopen controls live in the row body rather than the trailing
            * accessory, because they are two buttons plus whatever the write settled into and the
            * accessory is one trailing slot. The row carries no `onPress`, so it is not a
            * Pressable and these are not buttons inside a button.
            */}
          <BitbucketCommentResolutionControls input={input} comment={row} />
        </Item>
      )}
    />
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
  const panels: Readonly<Record<BitbucketDetailTabIdV1, React.ReactNode>> = {
    overview: <OverviewPanel input={input} locale={locale} nowMs={nowMs} />,
    activity: <ActivityPanel input={input} locale={locale} nowMs={nowMs} />,
    diff: <DiffPanel input={input} />,
    builds: <BuildsPanel input={input} locale={locale} nowMs={nowMs} />,
    comments: <CommentsPanel input={input} locale={locale} nowMs={nowMs} />,
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
 * The exact export name the build target's Module Federation identity names. Renaming it breaks
 * the native artifact contract, not just this file.
 */
export const renderSurface = defineUiSurface(BitbucketDetailSurface);
