/**
 * The Happier exceptions Triage detail surface (P7 J2, D30/D34).
 *
 * Triage mounts this renderer in its detail frame and hands it one `TriageDetailSurfaceInputV1`,
 * admitted here through the published schema. The frame owns the header, the state, Investigate
 * and the tab strip; this surface renders the panels the source declares (Overview, Stack trace,
 * Occurrences) and its own lifecycle writes as the frame's `actions` panel.
 *
 * Issue facts (title, status, counts, versions) are Account data and arrive with the exact read.
 * Occurrences and stacks stay on the collector and are read only while their panel is open. A
 * Team-shared issue carries no collector address: its occurrences live on the owner's collector,
 * and the surface says so instead of reading.
 */

import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Button,
  CodeBlock,
  CountedDisclosureItem,
  EmptyState,
  ErrorState,
  FreshnessLine,
  Item,
  ItemGroup,
  List,
  LoadingState,
  Metadata,
  Screen,
  Stack,
  Text,
  defineUiSurface,
  usePluginTranslation,
  useSurfaceContext,
  useTabPanelActivity,
  type MetadataEntry,
} from '@happier-dev/plugin-ui';
import {
  TriageDetailInstance,
  TriageDetailPanel,
  TriageDetailSpread,
  TriageDetailStory,
  TriageSourceWrites,
  type TriageDetailTrendV1,
  useTriageDetailPanelOpener,
  type TriageDetailSpreadTileV1,
  type TriageSourceWriteSettlementV1,
  type TriageSourceWriteV1,
} from '@happier-dev/triage-sources/ui';
import {
  TriageDetailSurfaceInputV1Schema,
  formatTriageCountV1 as formatCount,
  formatTriageTimestampV1 as formatTimestamp,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import { TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';

import {
  exceptionDetailDataSchema,
  exceptionIssueTransitionResultSchema,
  type ExceptionDetailDataV1,
} from '../exceptions/contracts.js';
import { HAPPIER_PAGE_METRICS, formatHappierDuration } from '@happier-dev/plugin-ui/components';
import { OccurrenceRequest } from './occurrenceRequest.js';
import {
  EXCEPTION_TREND_BUCKET_MS,
  TELEMETRY_PLUGIN_ID,
  useExceptionOccurrences,
  type ExceptionOccurrenceAddressV1,
  type ExceptionOccurrencesControllerV1,
  type ExceptionOccurrenceV1,
  type ExceptionReadFailureV1,
} from './exceptionReads.js';

const TRANSITION_ACTION = Object.freeze({
  pluginId: TELEMETRY_PLUGIN_ID,
  localId: databaseActionLocalIdV1(
    TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1,
  ),
});

const PANEL_RETENTION = Object.freeze({
  overview: 'discard',
  'stack-trace': 'discard',
  occurrences: 'retain',
} as const);

type Translate = ReturnType<typeof usePluginTranslation>;

/* ------------------------------------------------------------------ facts */

/** The request the occurrence happened in, as the lab's rail reads it: "500 · 412 ms". */
function occurrenceRequestFacts(occurrence: ExceptionOccurrenceV1, locale: string): string | null {
  const facts = [
    typeof occurrence.httpStatusCode === 'number' ? String(occurrence.httpStatusCode) : null,
    typeof occurrence.durationMs === 'number' ? formatHappierDuration(occurrence.durationMs, locale) : null,
  ].filter((part): part is string => part !== null);
  return facts.length === 0 ? null : facts.join(' · ');
}

function occurrenceLine(occurrence: ExceptionOccurrenceV1): string {
  return [occurrence.serviceVersion, occurrence.serviceName]
    .filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    )
    .join(' · ');
}

/**
 * An occurrence's time: the clock alone, with its day only where the day changes (the first row when it is not
 * today, then the first row of each earlier day), so a column of one day never repeats its date.
 */
function occurrenceWhen(locale: string, atMs: number, previousMs: number): string {
  const sameDay = new Date(atMs).toDateString() === new Date(previousMs).toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(atMs);
}

/** The lifecycle sentence under the exception: what changed, never a second copy of the frame's state word. */
function lifecycleSentence(
  data: ExceptionDetailDataV1,
  text: Translate,
  locale: string,
  nowMs: number,
): string | null {
  const resolution = data.resolution;
  if (
    data.status === 'open' &&
    data.regressed === true &&
    resolution !== undefined
  ) {
    const when = formatTimestamp(locale, resolution.atMs, 'relative', nowMs);
    return resolution.version === undefined
      ? text(
          'plugins.telemetry.exceptions.regressedAfter',
          'Came back after it was resolved {when}',
        ).replace('{when}', when)
      : text(
          'plugins.telemetry.exceptions.regressedAfterVersion',
          'Came back after it was resolved in {version}, {when}',
        )
          .replace('{version}', resolution.version)
          .replace('{when}', when);
  }
  if (data.status === 'resolved' && resolution !== undefined) {
    const when = formatTimestamp(locale, resolution.atMs, 'relative', nowMs);
    return resolution.version === undefined
      ? text(
          'plugins.telemetry.exceptions.resolvedAt',
          'Resolved {when}',
        ).replace('{when}', when)
      : text(
          'plugins.telemetry.exceptions.resolvedIn',
          'Resolved in {version}, {when}',
        )
          .replace('{version}', resolution.version)
          .replace('{when}', when);
  }
  return null;
}

function spreadTiles(
  data: ExceptionDetailDataV1,
  requestsAffected: number | null,
  text: Translate,
  locale: string,
  nowMs: number,
): readonly TriageDetailSpreadTileV1[] {
  return [
    // Counts cover the collector's retained window, so the total is approximate.
    {
      id: 'events',
      label: text('plugins.telemetry.exceptions.events', 'Events'),
      value: `~${formatCount(locale, data.count, 'compact')}`,
    },
    // Distinct traces the group reached in the trend's window; occurrences without trace context aren't counted.
    ...(requestsAffected === null
      ? []
      : [
          {
            id: 'requests-affected',
            label: text(
              'plugins.telemetry.exceptions.requestsAffected',
              'Requests affected',
            ),
            value: formatCount(locale, requestsAffected, 'compact'),
          },
        ]),
    {
      id: 'first-seen',
      label: text('plugins.telemetry.exceptions.firstSeen', 'First seen'),
      value: formatTimestamp(locale, data.firstSeenAtMs, 'relative', nowMs),
    },
    {
      id: 'last-seen',
      label: text('plugins.telemetry.exceptions.lastSeen', 'Last seen'),
      value: formatTimestamp(locale, data.lastSeenAtMs, 'relative', nowMs),
    },
    ...(data.resolution?.version === undefined
      ? []
      : [
          {
            id: 'resolved-in',
            label: text(
              'plugins.telemetry.exceptions.resolvedInTile',
              'Resolved in',
            ),
            value: data.resolution.version,
          },
        ]),
  ];
}

/** The collector's per-bucket counts as the shared Spread trend; absent until the window was read. */
function trendOf(
  controller: ExceptionOccurrencesControllerV1 | null,
  text: Translate,
): Readonly<{ trend: TriageDetailTrendV1 | null; requestsAffected: number | null }> {
  const state = controller?.state;
  if (state === undefined || state.kind !== 'ready')
    return { trend: null, requestsAffected: null };
  return {
    requestsAffected: state.requestsAffected,
    trend:
      state.trend === null
        ? null
        : {
            label: text(
              'plugins.telemetry.exceptions.trendLabel',
              'Events every {hours} hours',
            ).replace('{hours}', String(EXCEPTION_TREND_BUCKET_MS / 3_600_000)),
            windowLabel: text(
              'plugins.telemetry.exceptions.trendWindow',
              'Last 7 days',
            ),
            points: state.trend.map((bucket) => ({
              atMs: bucket.since,
              count: bucket.count,
            })),
          },
  };
}

function OverviewPanel({
  data,
  shared,
  controller,
  locale,
  nowMs,
}: Readonly<{
  data: ExceptionDetailDataV1;
  shared: boolean;
  /** Null for a Team-shared issue: its trend lives on the owner's collector. */
  controller: ExceptionOccurrencesControllerV1 | null;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { active } = useTabPanelActivity();
  const demand = controller?.demand;
  React.useEffect(() => {
    if (active) demand?.();
  }, [active, demand]);
  const { trend, requestsAffected } = trendOf(controller, text);
  // The Resolved-in tile states a named fix; the sentence speaks only when there is no version to name.
  const sentence =
    data.resolution?.version === undefined
      ? lifecycleSentence(data, text, locale, nowMs)
      : null;
  const entries: MetadataEntry[] = [
    ...(data.serviceName
      ? [
          {
            label: text('plugins.telemetry.exceptions.service', 'Service'),
            value: data.serviceName,
          },
        ]
      : []),
    ...(data.lastServiceVersion
      ? [
          {
            label: text(
              'plugins.telemetry.exceptions.latestVersion',
              'Latest version',
            ),
            value: data.lastServiceVersion,
          },
        ]
      : []),
    ...(data.topFrame
      ? [
          {
            label: text('plugins.telemetry.exceptions.topFrame', 'Top frame'),
            value: data.topFrame,
          },
        ]
      : []),
  ];
  const spread = (
    <TriageDetailSpread
      tiles={spreadTiles(data, requestsAffected, text, locale, nowMs)}
      trend={trend}
      locale={locale}
      nowMs={nowMs}
    />
  );
  return (
    <TriageDetailStory kind="error" changes={spread}>
      {sentence === null ? null : <Text variant="body" value={sentence} />}
      <Metadata entries={entries} />
      {shared ? <SharedNote /> : null}
    </TriageDetailStory>
  );
}

function SharedNote(): React.ReactElement {
  return (
    <Text
      variant="meta"
      tone="neutral"
      valueKey="plugins.telemetry.exceptions.sharedNote"
      fallback="A Team shared this issue with you. Its occurrences and stacks stay on the owner’s collector."
    />
  );
}

/* ---------------------------------------------------------- collector reads */

function SharedOccurrences(): React.ReactElement {
  return (
    <EmptyState
      title="Occurrences stay with the owner"
      titleKey="plugins.telemetry.exceptions.sharedOccurrences"
      description="A Team shared this issue with you. Its title, counts and status are here; its occurrences and stacks live on the owner’s collector."
      descriptionKey="plugins.telemetry.exceptions.sharedOccurrences.description"
    />
  );
}

function ExceptionsOff(): React.ReactElement {
  return (
    <EmptyState
      title="Exceptions are off for this Environment"
      titleKey="plugins.telemetry.exceptions.disabled"
      description="Turn Exceptions on in the Environment’s Telemetry to read occurrences again. The issue, its counts and its status stay here."
      descriptionKey="plugins.telemetry.exceptions.disabled.description"
    />
  );
}

function CollectorUnavailable({ failure, onRetry }: Readonly<{ failure: ExceptionReadFailureV1; onRetry: () => void }>): React.ReactElement {
  return (
    <ErrorState
      kind="unavailable"
      title="The collector isn’t answering"
      titleKey="plugins.telemetry.exceptions.collectorUnavailable"
      description="Occurrences and stacks come back when it does. The issue, its counts and its status are here."
      descriptionKey="plugins.telemetry.exceptions.collectorUnavailable.description"
      details={failure.code}
      onRetry={onRetry}
    />
  );
}

function OccurrencesPanel({
  controller,
  locale,
  nowMs,
}: Readonly<{
  controller: ExceptionOccurrencesControllerV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { active } = useTabPanelActivity();
  const openStack = useTriageDetailPanelOpener('stack-trace');
  const { demand, select, state } = controller;
  React.useEffect(() => {
    if (active) demand();
  }, [active, demand]);
  // Each row's predecessor in the newest-first list, so a row names its day only where the day changes.
  const items = 'items' in state ? state.items : null;
  const previousAt = React.useMemo(() => {
    const previous = new Map<string, number>();
    items?.forEach((occurrence, index) => {
      if (index > 0) previous.set(occurrence.id, items[index - 1]!.at);
    });
    return previous;
  }, [items]);

  if (state.kind === 'idle' || state.kind === 'loading')
    return (
      <LoadingState
        title="Reading occurrences from the collector"
        titleKey="plugins.telemetry.exceptions.readingOccurrences"
      />
    );
  if (state.kind === 'disabled') return <ExceptionsOff />;
  if (state.kind === 'unavailable')
    return (
      <CollectorUnavailable
        failure={state.failure}
        onRetry={controller.retry}
      />
    );

  return (
    <List
      accessibilityLabel={text(
        'plugins.telemetry.exceptions.occurrencesLabel',
        'Occurrences of this exception, newest first',
      )}
      items={state.items}
      keyForItem={(occurrence) => occurrence.id}
      selection={{
        selectedKey: controller.selected?.id ?? null,
        onSelectedKeyChange: (occurrenceId) => {
          select(occurrenceId);
          openStack?.();
        },
      }}
      header={
        state.failure === null ? undefined : (
          <FreshnessLine
            tone="warning"
            asOf={state.readAtMs}
            now={nowMs}
            reason={text(
              'plugins.telemetry.exceptions.collectorBehind',
              'The collector isn’t answering; these occurrences were read earlier',
            )}
            action={{
              label: text('plugins.telemetry.exceptions.retry', 'Retry'),
              onPress: controller.retry,
            }}
          />
        )
      }
      empty={
        <EmptyState
          title="No occurrences kept"
          titleKey="plugins.telemetry.exceptions.noOccurrences"
          description="The collector no longer keeps this issue’s occurrences. Its counts and status stay here."
          descriptionKey="plugins.telemetry.exceptions.noOccurrences.description"
        />
      }
      footer={
        !state.hasMore ? undefined : (
          <Button
            title={text(
              'plugins.telemetry.exceptions.olderOccurrences',
              'Older occurrences',
            )}
            variant="plain"
            busy={state.loadingMore}
            onPress={controller.loadMore}
          />
        )
      }
      renderItem={(occurrence) => {
        const line = occurrenceLine(occurrence);
        const request = occurrenceRequestFacts(occurrence, locale);
        return (
          <Item
            title={occurrenceWhen(locale, occurrence.at, previousAt.get(occurrence.id) ?? nowMs)}
            {...(line.length === 0 ? {} : { subtitle: line })}
            {...(request === null ? {} : { detail: request })}
            accessibilityRole="option"
          />
        );
      }}
    />
  );
}

type StackFrameV1 = Readonly<{ name: string; location: string | null; library: boolean }>;

/** The excerpt keeps the sheet's row insets, so its lines start on the frames' text edge. */
const SOURCE_CONTEXT_INSET = Object.freeze({
  paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
  paddingBottom: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx,
});

/** `at name (file:line:col)` / `at file:line:col` lines of a redacted JS stack; anything else stays text. */
function parseStackFrames(stacktrace: string): readonly StackFrameV1[] | null {
  const lines = stacktrace.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const frames: StackFrameV1[] = [];
  for (const line of lines) {
    if (!line.startsWith('at ')) continue;
    const body = line.slice(3);
    const named = /^(.*?) \((.*)\)$/u.exec(body);
    const name = named ? named[1]! : body;
    const location = named ? named[2]! : null;
    const where = location ?? body;
    frames.push({
      name,
      location,
      library: where.includes('node_modules') || where.startsWith('node:'),
    });
  }
  return frames.length === 0 ? null : frames;
}

/** The line a `file:line:col` location points at, when it names one. */
function locationLine(location: string | null): number | null {
  const match = location === null ? null : /:(\d+)(?::\d+)?$/u.exec(location);
  return match ? Number(match[1]) : null;
}

/**
 * The exporter's source excerpt under the frame that threw (lab p7Issues occurrence), in the shared code well with
 * the throwing line on its failure band when the excerpt numbers its lines. Shown exactly as supplied.
 */
function SourceContext({ excerpt, line }: Readonly<{ excerpt: string; line: number | null }>): React.ReactElement {
  const marked = line === null ? -1 : excerpt.split('\n').findIndex((sourceLine) => {
    const numbered = /^\s*(\d+)\b/u.exec(sourceLine);
    return numbered !== null && Number(numbered[1]) === line;
  });
  return (
    <Stack gap="none" testID="telemetry.exception.source-context" style={SOURCE_CONTEXT_INSET}>
      <CodeBlock code={excerpt} selectable {...(marked < 0 ? {} : { markedLines: [marked + 1] })} />
    </Stack>
  );
}

function StackFrames({ stacktrace, sourceContext }: Readonly<{ stacktrace: string; sourceContext: string | null }>): React.ReactElement {
  const text = usePluginTranslation();
  const frames = React.useMemo(() => parseStackFrames(stacktrace), [stacktrace]);
  if (frames === null) return <CodeBlock code={stacktrace} selectable />;
  const own = frames.filter((frame) => !frame.library);
  const library = frames.filter((frame) => frame.library);
  const row = (frame: StackFrameV1, index: number) => (
    <Item
      key={`${index}:${frame.name}:${frame.location ?? ''}`}
      identifier
      title={frame.name}
      titleNumberOfLines={1}
      {...(frame.location === null ? {} : { detail: frame.location })}
    />
  );
  const shown = own.length > 0 ? own : library;
  return (
    <>
      {shown.slice(0, 1).map(row)}
      {/* The source sits under the top in-app frame only; without an excerpt the frame stands alone. */}
      {sourceContext !== null && own.length > 0 ? (
        <SourceContext key="source-context" excerpt={sourceContext} line={locationLine(own[0]!.location)} />
      ) : null}
      {shown.slice(1).map((frame, index) => row(frame, index + 1))}
      {own.length > 0 && library.length > 0 ? (
        <CountedDisclosureItem
          title={text(
            'plugins.telemetry.exceptions.libraryFrames',
            'Frames from libraries and Node',
          )}
          count={library.length}
        >
          {library.map(row)}
        </CountedDisclosureItem>
      ) : null}
    </>
  );
}

function StackTracePanel({
  controller,
  address,
  data,
  locale,
  nowMs,
  signal,
}: Readonly<{
  controller: ExceptionOccurrencesControllerV1;
  address: ExceptionOccurrenceAddressV1;
  data: ExceptionDetailDataV1;
  locale: string;
  nowMs: number;
  signal: AbortSignal;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { active } = useTabPanelActivity();
  const { demand, demandStack, selected, state, stack } = controller;
  React.useEffect(() => {
    if (!active) return;
    demand();
    if (selected !== null) demandStack();
  }, [active, demand, demandStack, selected]);

  if (state.kind === 'disabled') return <ExceptionsOff />;
  if (state.kind === 'unavailable')
    return (
      <CollectorUnavailable
        failure={state.failure}
        onRetry={controller.retry}
      />
    );
  if (state.kind === 'ready' && selected === null) {
    return (
      <EmptyState
        title="No occurrence kept"
        titleKey="plugins.telemetry.exceptions.noStack"
        description="The collector no longer keeps an occurrence of this issue to read a stack from."
        descriptionKey="plugins.telemetry.exceptions.noStack.description"
      />
    );
  }
  if (selected === null || stack === null || stack.kind === 'loading')
    return (
      <LoadingState
        title="Reading the stack"
        titleKey="plugins.telemetry.exceptions.readingStack"
      />
    );
  if (stack.kind === 'unavailable')
    return (
      <CollectorUnavailable failure={stack.failure} onRetry={demandStack} />
    );

  const newest = state.kind === 'ready' && state.items[0]?.id === selected.id;
  const when = formatTimestamp(locale, selected.at, 'absolute', nowMs);
  const line = occurrenceLine(selected);
  const recorded = (newest
    ? text(
        'plugins.telemetry.exceptions.newestOccurrence',
        'Newest occurrence, recorded {when}',
      )
    : text(
        'plugins.telemetry.exceptions.selectedOccurrence',
        'Selected occurrence, recorded {when}',
      )
  ).replace('{when}', line.length === 0 ? when : `${when} · ${line}`);
  const grouped = data.topFrame
    ? text(
        'plugins.telemetry.exceptions.groupedBy',
        'Grouped by type, message and top frame {frame}',
      ).replace('{frame}', data.topFrame)
    : null;
  // The frame header already names the exception; the panel opens on its frames.
  return (
    <Stack gap="large">
      <ItemGroup
        description={grouped === null ? recorded : `${recorded}\n${grouped}`}
        surface="sheet"
        accessibilityLabel={text('plugins.telemetry.exceptions.stackTitle', 'Stack trace')}
      >
        {stack.stacktrace === null ? (
          <EmptyState
            title="No stack recorded"
            titleKey="plugins.telemetry.exceptions.noStackRecorded"
            description="This occurrence arrived without a stack trace."
            descriptionKey="plugins.telemetry.exceptions.noStackRecorded.description"
          />
        ) : (
          <StackFrames stacktrace={stack.stacktrace} sourceContext={stack.sourceContext} />
        )}
      </ItemGroup>
      <OccurrenceRequest
        source={{
          kind: 'environment',
          serverId: address.serverId,
          environmentId: address.environmentId,
        }}
        occurrence={selected}
        locale={locale}
        signal={signal}
      />
    </Stack>
  );
}

/* ------------------------------------------------------------------ writes */

function readTransition(result: unknown): TriageSourceWriteSettlementV1 {
  const parsed = exceptionIssueTransitionResultSchema.safeParse(result);
  if (!parsed.success) return { kind: 'uncertain' };
  return parsed.data.status === 'absent'
    ? { kind: 'refused' }
    : { kind: 'applied' };
}

function ExceptionWrites({
  data,
  issueId,
  serverId,
}: Readonly<{
  data: ExceptionDetailDataV1;
  issueId: string;
  serverId: string;
}>): React.ReactElement {
  const writes = React.useMemo((): readonly TriageSourceWriteV1[] => {
    const write = (
      id: 'resolve' | 'reopen' | 'ignore' | 'unignore',
      title: string,
      applied: string,
    ): TriageSourceWriteV1 => ({
      id,
      action: TRANSITION_ACTION,
      input: {
        serverId,
        environmentId: data.environmentId,
        issueId,
        action: id,
      },
      title,
      titleKey: `plugins.telemetry.exceptions.write.${id}`,
      variant: 'secondary',
      appliedTitle: applied,
      appliedTitleKey: `plugins.telemetry.exceptions.write.${id}.applied`,
      readResult: readTransition,
    });
    if (data.status === 'open')
      return [
        write('resolve', 'Resolve', 'Resolved'),
        write('ignore', 'Ignore', 'Ignored'),
      ];
    if (data.status === 'resolved')
      return [write('reopen', 'Reopen', 'Reopened')];
    return [write('unignore', 'Stop ignoring', 'No longer ignored')];
  }, [data.environmentId, data.status, issueId, serverId]);
  return <TriageSourceWrites writes={writes} sourceName="Happier" />;
}

/* -------------------------------------------------------------- detail body */

function ExceptionDetailBody({
  input,
  data,
  signal,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  data: ExceptionDetailDataV1;
  signal: AbortSignal;
}>): React.ReactElement {
  const { locale, accountScope } = useSurfaceContext();
  const text = usePluginTranslation();
  const nowMs = Date.now();
  const serverId = accountScope?.serverId;
  const fingerprint = data.fingerprint;
  const address = React.useMemo(
    (): ExceptionOccurrenceAddressV1 | null =>
      serverId === undefined || fingerprint === undefined
        ? null
        : { serverId, environmentId: data.environmentId, fingerprint },
    [data.environmentId, fingerprint, serverId],
  );
  const controller = useExceptionOccurrences(address, signal);
  const shared = fingerprint === undefined;

  const panels: Readonly<Record<string, React.ReactNode>> = {
    overview: (
      <OverviewPanel
        data={data}
        shared={shared}
        controller={address === null ? null : controller}
        locale={locale}
        nowMs={nowMs}
      />
    ),
    'stack-trace':
      address === null ? (
        <SharedOccurrences />
      ) : (
        <StackTracePanel
          controller={controller}
          address={address}
          data={data}
          locale={locale}
          nowMs={nowMs}
          signal={signal}
        />
      ),
    occurrences:
      address === null ? (
        <SharedOccurrences />
      ) : (
        <OccurrencesPanel
          controller={controller}
          locale={locale}
          nowMs={nowMs}
        />
      ),
    // Lifecycle writes go through the collector's single writer, which holds the owner's record.
    actions:
      address === null ? null : (
        <ExceptionWrites
          data={data}
          issueId={input.observation.entryRef.entryId}
          serverId={address.serverId}
        />
      ),
  };

  return (
    <Screen safeArea>
      <TriageDetailPanel
        scrollOwner={input.panelScrollOwner}
        panel={input.panel ?? 'overview'}
        retention={PANEL_RETENTION}
        ariaLabel={text(
          'plugins.telemetry.exceptions.tabsLabel',
          'Exception detail sections',
        )}
        panels={panels}
      />
    </Screen>
  );
}

function ExceptionDetailSurface(context: RenderContext): React.ReactElement {
  const admitted = React.useMemo(() => {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(
      context.launchInput,
    );
    if (!parsed.success) return null;
    const data = exceptionDetailDataSchema.safeParse(parsed.data.detailData);
    return data.success ? { input: parsed.data, data: data.data } : null;
  }, [context.launchInput]);

  if (admitted === null) {
    return (
      <Screen safeArea>
        <ErrorState
          title="This exception can’t be shown"
          titleKey="plugins.telemetry.exceptions.invalidInput"
          description="PRs & Issues handed over details this Telemetry build doesn’t accept."
          descriptionKey="plugins.telemetry.exceptions.invalidInput.description"
        />
      </Screen>
    );
  }
  return (
    <TriageDetailInstance scrollOwner={admitted.input.panelScrollOwner}>
      <ExceptionDetailBody
        input={admitted.input}
        data={admitted.data}
        signal={context.signal}
      />
    </TriageDetailInstance>
  );
}

/** The manifest names this exact universal CommonJS export. */
export const renderSurface = defineUiSurface(ExceptionDetailSurface);
