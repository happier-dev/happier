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
  EmptyState,
  ErrorState,
  FreshnessLine,
  Item,
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
import {
  TELEMETRY_EXCEPTION_ISSUE_TRANSITION_ACTION_ID_V1,
  databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';

import {
  exceptionDetailDataSchema,
  exceptionIssueTransitionResultSchema,
  type ExceptionDetailDataV1,
} from '../exceptions/contracts.js';
import {
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

function occurrenceLine(occurrence: ExceptionOccurrenceV1): string {
  return [occurrence.serviceVersion, occurrence.serviceName]
    .filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    )
    .join(' · ');
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

function OverviewPanel({
  data,
  shared,
  locale,
  nowMs,
}: Readonly<{
  data: ExceptionDetailDataV1;
  shared: boolean;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const sentence = lifecycleSentence(data, text, locale, nowMs);
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
    {
      label: text('plugins.telemetry.exceptions.countsAsOf', 'Counts as of'),
      value: formatTimestamp(locale, data.asOfMs, 'relative', nowMs),
    },
  ];
  const spread = (
    <TriageDetailSpread
      tiles={spreadTiles(data, text, locale, nowMs)}
      trend={null}
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
        return (
          <Item
            title={formatTimestamp(locale, occurrence.at, 'absolute', nowMs)}
            {...(line.length === 0 ? {} : { subtitle: line })}
            detail={formatTimestamp(locale, occurrence.at, 'relative', nowMs)}
            accessibilityRole="option"
          />
        );
      }}
    />
  );
}

function StackTracePanel({
  controller,
  data,
  locale,
  nowMs,
}: Readonly<{
  controller: ExceptionOccurrencesControllerV1;
  data: ExceptionDetailDataV1;
  locale: string;
  nowMs: number;
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
  const exception = [selected.type, selected.message]
    .filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    )
    .join(': ');
  return (
    <Stack gap="large">
      <Stack gap="small">
        <Text
          variant="meta"
          tone="neutral"
          value={(newest
            ? text(
                'plugins.telemetry.exceptions.newestOccurrence',
                'Newest occurrence, recorded {when}',
              )
            : text(
                'plugins.telemetry.exceptions.selectedOccurrence',
                'Selected occurrence, recorded {when}',
              )
          ).replace('{when}', line.length === 0 ? when : `${when} · ${line}`)}
        />
        {data.topFrame ? (
          <Text
            variant="meta"
            tone="neutral"
            value={text(
              'plugins.telemetry.exceptions.groupedBy',
              'Grouped by type, message and top frame {frame}',
            ).replace('{frame}', data.topFrame)}
          />
        ) : null}
      </Stack>
      {exception.length === 0 ? null : (
        <Text variant="label" value={exception} />
      )}
      {stack.stacktrace === null ? (
        <EmptyState
          title="No stack recorded"
          titleKey="plugins.telemetry.exceptions.noStackRecorded"
          description="This occurrence arrived without a stack trace."
          descriptionKey="plugins.telemetry.exceptions.noStackRecorded.description"
        />
      ) : (
        <CodeBlock code={stack.stacktrace} selectable />
      )}
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
          data={data}
          locale={locale}
          nowMs={nowMs}
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
