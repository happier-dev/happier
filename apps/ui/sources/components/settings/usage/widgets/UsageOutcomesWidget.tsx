import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { OutcomeFunnel, RankedRows } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCountLong } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { usageSeriesColor } from '../usageAccent';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { useUsageWork } from './useUsageWork';
import { formatUsageDuration } from './usageHowYouWorkPresentation';
import type { UsageWorkOutcomeRow } from './usageWorkPresentation';
import {
  UsageWorkDisclosure,
  UsageWorkMarks,
  UsageWorkRowLead,
  UsageWorkSectionTitle,
  UsageWorkSessionRows,
  usageWorkProviderUnknownLine,
  usageWorkPullRequestState,
  usageWorkPullRequestTitle,
  useUsageWorkDisclosures,
} from './UsageWorkParts';

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

/** Sessions → merged PRs, and the exact amount each linked PR consumed. A PR opens into its Sessions. */
export function UsageOutcomesWidget(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  const { theme: appTheme } = useUnistyles();
  const { summary, format, sessionLabel, openSession } = useUsageWork(
    props.slice,
    props.query,
    props.serverId,
  );
  const disclosures = useUsageWorkDisclosures();
  useWidgetFrameBodyCaption(
    summary
      ? t('usage.board.work.outcomesCaption', {
          count: summary.outcomes.length,
        })
      : null,
  );
  if (!summary)
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
  if (summary.sessions.length === 0)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.work.emptyTitle')}
        reason={t('usage.board.work.emptyReason')}
      />
    );
  const accent = usageSeriesColor(appTheme, 0);
  const { funnel } = summary;
  const byKey = new Map(summary.outcomes.map((row) => [row.key, row]));
  return (
    <View style={styles.body} testID={`${props.testID}.outcomes`}>
      <OutcomeFunnel
        theme={theme}
        label={t('usage.board.work.funnelLabel')}
        size="tile"
        testID={`${props.testID}.funnel`}
        valueFormatter={formatTokenCountLong}
        total={funnel.sessions}
        steps={[
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
            value: funnel.merged,
            color: accent,
          },
        ]}
      />
      {summary.outcomes.length === 0 ? (
        <UsageBodyInsufficient
          testID={`${props.testID}.noPrs`}
          title={t('usage.board.work.noPrsTitle')}
          reason={t('usage.board.work.noPrsReason')}
        />
      ) : (
        <View style={styles.section}>
          <UsageWorkSectionTitle>{t('usage.board.work.prLabel')}</UsageWorkSectionTitle>
          <RankedRows
            theme={theme}
            label={t('usage.board.work.prLabel')}
            size="tile"
            valueFormatter={format}
            unknownLabel={format(null)}
            testID={`${props.testID}.prs`}
            leads={Object.fromEntries(
              summary.outcomes.map((row): [string, React.ReactNode] => [
                row.key,
                <UsageWorkRowLead
                  expanded={disclosures.isOpen(row.key)}
                  icon="git-pull-request"
                  color={row.outcome.pullRequest.state === 'merged' ? accent : undefined}
                />,
              ]),
            )}
            trails={Object.fromEntries(
              summary.outcomes.map((row): [string, React.ReactNode] => [
                row.key,
                <UsageWorkMarks
                  agentIds={row.agentIds}
                  providers={row.providers}
                  serverId={props.serverId}
                  testID={props.testID}
                />,
              ]),
            )}
            rows={summary.outcomes.map((row) => {
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
                  usageWorkProviderUnknownLine(row),
                ]
                  .filter(Boolean)
                  .join(' · '),
              };
            })}
            renderRow={(ranked, visual) => {
              const row = byKey.get(ranked.id)!;
              const testID = `${props.testID}.pr.${row.key}`;
              return (
                <UsageWorkDisclosure
                  expanded={disclosures.isOpen(row.key)}
                  onToggle={() => disclosures.toggle(row.key)}
                  label={ranked.label}
                  testID={testID}
                  detail={() => (
                    <UsageWorkSessionRows
                      parts={row.sessions}
                      summary={summary}
                      format={format}
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
            }}
          />
        </View>
      )}
      <UsageCoverageLine
        slice={props.slice}
        sources={['work']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 14, minWidth: 0 },
  section: {
    gap: 10,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
}));
