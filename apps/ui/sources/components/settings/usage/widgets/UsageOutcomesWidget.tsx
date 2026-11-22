import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, UsageOutcomesBody, type UsageOutcomesModel } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCountLong } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { usageSeriesColor } from '../usageAccent';
import { usageTokensFromPartsNote } from '../usageCostPresentation';
import {
  UsageBodyInsufficient,
  UsageBodyNote,
  UsageBodyReading,
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { useUsageWork, useUsageWorkSessionNavigation } from './useUsageWork';
import { formatUsageDuration } from './usageHowYouWorkPresentation';
import { partitionUsageWorkMoneyRows, readUsageWorkOutcomesPresentation, type UsageWorkOutcomeRow } from './usageWorkPresentation';
import {
  UsageWorkDisclosure,
  UsageWorkMarks,
  UsageWorkRowLead,
  UsageWorkSectionTitle,
  UsageWorkSessionRows,
  usageWorkPullRequestState,
  usageWorkPullRequestTitle,
  useUsageWorkDisclosures,
} from './UsageWorkParts';
import { UsageShippedStyleBody } from './UsageChartStyleBodies';

/** Open to merged, from the host's own two timestamps; absent when either was not reported. */
function mergedIn(row: UsageWorkOutcomeRow): string | null {
  const { state, createdAtMs, mergedAtMs } = row.outcome.pullRequest;
  return state === 'merged' &&
    createdAtMs !== undefined &&
    mergedAtMs !== undefined &&
    mergedAtMs >= createdAtMs
    ? t('usage.board.work.mergedIn', { duration: formatUsageDuration(mergedAtMs - createdAtMs) })
    : null;
}

/** One body per widget: its Style own-input picks the encoding of the same question. */
export function UsageOutcomesWidget(props: UsageBodyProps) {
  const style = props.presentation?.style;
  if (style === 'shipped') return <UsageShippedStyleBody {...props} />;
  return <UsageOutcomesWidgetOriginal {...props} />;
}

/** Sessions → merged PRs, and the exact amount each linked PR consumed. A PR opens into its Sessions. */
function UsageOutcomesWidgetOriginal(props: UsageBodyProps) {
  const presentation = readUsageWorkOutcomesPresentation(props.slice);
  return presentation.kind === 'ready'
    ? <UsageOutcomesFacts {...props} />
    : <UsageOutcomesEmpty {...props} presentation={presentation} />;
}

function UsageOutcomesEmpty(props: UsageBodyProps & Readonly<{
  presentation: Exclude<ReturnType<typeof readUsageWorkOutcomesPresentation>, Readonly<{ kind: 'ready' }>>;
}>) {
  const { presentation } = props;
  useUsageWorkSessionNavigation(presentation.sessions, props.query, props.serverId, presentation.machineIds);
  useWidgetFrameBodyCaption(presentation.kind === 'unavailable' || presentation.kind === 'reading' ? usagePeriodPhrase(props.query)
    : t('usage.board.page.noneLinkedByEvidence'));
  if (presentation.kind === 'reading')
    return <UsageBodyReading testID={`${props.testID}.loading`} waitingOn={{ slice: props.slice, sources: ['work'] }} />;
  if (presentation.kind === 'unavailable')
    return (
      <View style={styles.body}>
        <UsageBodyInsufficient
          testID={`${props.testID}.workUnavailable`}
          title={t('usage.board.work.workUnavailableTitle')}
          reason={t('usage.board.work.workUnavailableReason')}
        />
        <UsageCoverageLine
          slice={props.slice}
          sources={['work']}
          onRetry={props.model.refresh}
          testID={`${props.testID}.coverage`}
        />
      </View>
    );
  if (presentation.kind === 'empty')
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.work.emptyTitle')}
        reason={t('usage.board.work.emptyReason')}
      />
    );
  return (
    <View style={styles.body} testID={`${props.testID}.outcomes`}>
      {/* The measured-empty caption and the existing quiet line stay in the same slots. */}
      <UsageBodyInsufficient
        testID={`${props.testID}.noPrs`}
        replacesContent={false}
        title={t('usage.board.work.noPrsTitle')}
        reason={t('usage.board.work.noPrsReason')}
      />
      <UsageCoverageLine
        slice={props.slice}
        sources={['work']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

function UsageOutcomesFacts(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  const { theme: appTheme } = useUnistyles();
  const { summary: projected, format, cell, datum, basisLabel, sessionLabel, openSession } = useUsageWork(
    props.slice, props.query, props.serverId,
  );
  // The presentation owner mounted facts only after admitting this Work population.
  const summary = projected!;
  const disclosures = useUsageWorkDisclosures(summary.outcomes.map(row => ({
    id: row.key, title: usageWorkPullRequestTitle(row.outcome.pullRequest),
  })));
  const linkedCount = summary.outcomes.length;
  useWidgetFrameBodyCaption(props.slice.workSummary?.pullRequestsRead !== true ? usagePeriodPhrase(props.query)
    : linkedCount === 0 ? t('usage.board.page.noneLinkedByEvidence') : t('usage.board.work.outcomesCaption', { count: linkedCount }));
  const { funnel } = summary;
  const accent = usageSeriesColor(appTheme, 0);
  const byKey = new Map(summary.outcomes.map((row) => [row.key, row]));
  const moneyGroups = partitionUsageWorkMoneyRows(summary.outcomes, props.query.metric);
  const fromPartsNote = usageTokensFromPartsNote(summary.outcomes.map(row => row.tokensFromParts));
  const model: UsageOutcomesModel = { kind: 'work',
      funnel: {
        label: t('usage.board.work.funnelLabel'),
        testID: `${props.testID}.funnel`,
        valueFormatter: formatTokenCountLong,
        total: funnel.sessions,
        steps: [
          {
            id: 'sessions',
            label: t('usage.board.work.funnelSessions'),
            value: funnel.sessions,
            color: usageSeriesColor(appTheme, 4),
          },
          {
            id: 'witnessed',
            label: t('usage.board.work.funnelWitnessed'),
            value: funnel.witnessed,
            color: usageSeriesColor(appTheme, 3),
          },
          {
            id: 'allocated',
            label: t('usage.board.work.funnelAllocated'),
            value: funnel.allocated,
            color: usageSeriesColor(appTheme, 1),
          },
          {
            id: 'merged',
            label: t('usage.board.work.funnelMerged'),
            value: props.slice.workSummary?.mergedSessionCount ?? null,
            color: accent,
          },
        ],
      },
      groups: moneyGroups.map((group): Extract<UsageOutcomesModel, { kind: 'work' }>['groups'][number] => ({
            id: group.key,
            label: t('usage.board.work.prLabel'),
            valueFormatter: value => format(value, group.moneyBasis),
            basis: basisLabel(group.moneyBasis),
            unknownLabel: format(null),
            testID: `${props.testID}.prs`,
            leads: Object.fromEntries(
              group.rows.map((row): [string, React.ReactNode] => [
                row.key,
                <UsageWorkRowLead
                  expanded={disclosures.isOpen(row.key)}
                  icon="git-pull-request"
                  color={row.outcome.pullRequest.state === 'merged' ? accent : undefined}
                />,
              ]),
            ),
            trails: Object.fromEntries(
              group.rows.map((row): [string, React.ReactNode] => [
                row.key,
                <UsageWorkMarks
                  agentIds={row.agentIds}
                  providers={row.providers}
                  serverId={props.serverId}
                  testID={props.testID}
                />,
              ]),
            ),
            rows: group.rows.map((row) => {
              const pullRequest = row.outcome.pullRequest;
              return {
                id: row.key,
                value: row.amount,
                color: pullRequest.state === 'merged' ? accent : usageSeriesColor(appTheme, 4),
                label: usageWorkPullRequestTitle(pullRequest),
                annotation: [
                  t('usage.board.work.prLine', {
                    sessions: row.sessions.length,
                    state: usageWorkPullRequestState(pullRequest),
                  }),
                  mergedIn(row),
                ]
                  .filter(Boolean)
                  .join(' · '),
              };
            }),
            rowDatums: group.rows.map(row => datum(usageWorkPullRequestTitle(row.outcome.pullRequest), row.amount, row.moneyBasis)),
            renderIdentity: (ranked, visual) => {
              const row = byKey.get(ranked.id)!;
              return <HappierPressable accessibilityLabel={ranked.label} expanded={disclosures.isOpen(row.key)}
                testID={`${props.testID}.pr.${row.key}.toggle`} onPress={() => disclosures.toggle(row.key)}>{visual}</HappierPressable>;
            },
            renderRow: (ranked, visual) => {
              const row = byKey.get(ranked.id)!;
              const testID = `${props.testID}.pr.${row.key}`;
              return (
                <UsageWorkDisclosure
                  expanded={disclosures.isOpen(row.key)}
                  testID={testID}
                  detail={() => (
                    <UsageWorkSessionRows
                      parts={row.sessions}
                      summary={summary}
                      format={format}
                      cell={cell}
                      datum={datum}
                      sessionLabel={sessionLabel}
                      openSession={openSession}
                      serverId={props.serverId}
                      testID={`${testID}.session`}
                    />
                  )}
                >
                  {visual}
                </UsageWorkDisclosure>
              );
            },
          })),
  };
  return <UsageOutcomesBody theme={theme} model={model} sectionGap={appTheme.space.s10} testID={`${props.testID}.outcomes`}
      sectionTitle={<>
        <UsageWorkSectionTitle>{t('usage.board.work.prLabel')}</UsageWorkSectionTitle>
        {fromPartsNote ? <UsageBodyNote testID={`${props.testID}.fromParts`}>{fromPartsNote}</UsageBodyNote> : null}
      </>}
      empty={<UsageBodyInsufficient testID={`${props.testID}.noPrs`} replacesContent={false}
        title={t('usage.board.work.noPrsTitle')} reason={t('usage.board.work.noPrsReason')} />}
      coverage={<UsageCoverageLine
        slice={props.slice}
        sources={['work']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />} />;
}

const styles = StyleSheet.create(() => ({
  body: { gap: 14, minWidth: 0 },
}));
