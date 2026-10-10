import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { HappierDataRows, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { t } from '@/text';
import { usageMeterFill, usageSignatureAccent } from '../usageAccent';
import { useUsageDrill } from '../usageDrill';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { useUsageWork } from './useUsageWork';
import type {
  UsageWorkBranchRow,
  UsageWorkProjectRow,
  UsageWorkUnallocatedReason,
} from './usageWorkPresentation';
import {
  UsageWorkDisclosure,
  UsageWorkMarks,
  UsageWorkRowLead,
  UsageWorkSectionTitle,
  UsageWorkSessionRows,
  usageWorkBranchName,
  usageWorkProviderUnknownLine,
  usageWorkPullRequestState,
  usageWorkPullRequestTitle,
  usageWorkShortCommit,
  useUsageWorkDisclosures,
} from './UsageWorkParts';

const REASONS: readonly UsageWorkUnallocatedReason[] = [
  'missing_evidence',
  'missing_turn',
  'ambiguous_outcome',
  'uncertain_writers',
];

/**
 * Projects by what their spend bought. A project opens in place into its linked PRs, its witnessed
 * branches and every Session; the closing lines state that linked plus not linked is the total.
 */
export function UsageProjectLedgerWidget(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  const { theme: appTheme } = useUnistyles();
  const presentation = useWidgetPresentation();
  const rowMetrics = usePageRowMetrics('list');
  const { summary, format, projectLabel, sessionLabel, openSession } = useUsageWork(
    props.slice,
    props.query,
    props.serverId,
  );
  const drill = useUsageDrill(props.query);
  const disclosures = useUsageWorkDisclosures();
  useWidgetFrameBodyCaption(
    t('usage.board.work.ledgerCaption', {
      period: usagePeriodPhrase(props.query),
    }),
  );
  const compact =
    presentation?.footprint.width === 'half' ||
    presentation?.footprint.width === 'compact' ||
    (presentation?.geometry?.width ?? Number.POSITIVE_INFINITY) < 420;
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
          sources={['work', 'accounting']}
          onRetry={props.model.refresh}
          testID={`${props.testID}.coverage`}
        />
      </View>
    );
  if (summary.projects.length === 0)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.work.emptyTitle')}
        reason={t('usage.board.work.emptyReason')}
      />
    );
  const density = compact ? 'compact' : 'comfortable';
  const metricLabel = props.query.metric === 'cost' ? t('usage.cost') : t('usage.tokens');
  const sessionsLine = (count: number) => t('usage.board.work.valueCaption', { count });
  const caption = {
    fontSize: rowMetrics.subtitle.fontSize,
    lineHeight: rowMetrics.subtitle.lineHeight,
  };
  const title = {
    fontSize: rowMetrics.title.fontSize,
    lineHeight: rowMetrics.title.lineHeight,
  };
  const reasons = REASONS.filter(
    (reason) =>
      summary.unallocatedByReason[reason] === null || (summary.unallocatedByReason[reason] ?? 0) > 0,
  );
  const sessionRows = (parts: UsageWorkProjectRow['sessions'], testID: string) => (
    <UsageWorkSessionRows
      parts={parts}
      summary={summary}
      format={format}
      sessionLabel={sessionLabel}
      openSession={openSession}
      serverId={props.serverId}
      testID={testID}
    />
  );
  const branchCells = (row: UsageWorkBranchRow, withProject: boolean) => [
    usageWorkBranchName(row.branch.branch.ref),
    row.amount ?? format(null),
    withProject ? row.projectKeys.map(projectLabel).join(', ') : '',
    sessionsLine(row.sessions.length),
    row.perSession === null || row.sessions.length < 2
      ? ''
      : t('usage.board.work.perSession', { amount: format(row.perSession) }),
    `${t('usage.board.work.commit')} ${usageWorkShortCommit(row.branch.branch.headSha)}`,
    usageWorkProviderUnknownLine(row),
  ];
  const branchColumns = [
    { label: t('usage.board.work.branches') },
    { label: metricLabel, proportion: true },
    { label: t('usage.board.work.allProjects') },
    { label: t('usage.board.work.funnelSessions') },
    { label: metricLabel },
    { label: t('usage.board.work.commit') },
    { label: t('usage.board.work.provider') },
  ];
  const projectDetail = (row: UsageWorkProjectRow, testID: string) => (
    <>
      {row.projectKey !== null && drill.available('projects') ? (
        <HappierPressable
          accessibilityRole="button"
          testID={`${testID}.filter`}
          selected={drill.selected('projects', row.projectKey)}
          onPress={() => {
            drill.toggle('projects', row.projectKey!);
          }}
          style={styles.filter}
        >
          <Icon name="funnel-simple" size={ICON_SIZE.xs} color={appTheme.colors.text.secondary} />
          <Text style={[styles.filterLabel, caption]}>
            {drill.selected('projects', row.projectKey)
              ? t('usage.board.work.filterProjectOn')
              : t('usage.board.work.filterProject')}
          </Text>
        </HappierPressable>
      ) : null}
      {row.outcomes.length > 0 ? (
        <View style={styles.group}>
          <UsageWorkSectionTitle quiet>{t('usage.board.work.linkedPrs')}</UsageWorkSectionTitle>
          <HappierDataRows
            theme={theme}
            label={t('usage.board.work.linkedPrs')}
            testID={`${testID}.prs`}
            density="compact"
            showProportionShares={false}
            valueFormatter={format}
            rowIds={row.outcomes.map((outcome) => outcome.key)}
            rowLeads={row.outcomes.map((outcome) => (
              <UsageWorkRowLead
                icon="git-pull-request"
                color={
                  outcome.outcome.pullRequest.state === 'merged'
                    ? usageSignatureAccent(appTheme)
                    : undefined
                }
              />
            ))}
            rowTrails={row.outcomes.map((outcome) => (
              <UsageWorkMarks
                agentIds={outcome.agentIds}
                providers={outcome.providers}
                serverId={props.serverId}
              />
            ))}
            columns={[
              { label: t('usage.board.work.prLabel') },
              { label: metricLabel, proportion: true },
              { label: t('usage.board.work.funnelSessions') },
            ]}
            rows={row.outcomes.map((outcome) => [
              usageWorkPullRequestTitle(outcome.outcome.pullRequest),
              outcome.amount ?? format(null),
              t('usage.board.work.prLine', {
                sessions: outcome.sessions.length,
                state: usageWorkPullRequestState(outcome.outcome.pullRequest),
              }),
            ])}
          />
        </View>
      ) : null}
      {row.branches.length > 0 ? (
        <View style={styles.group}>
          <UsageWorkSectionTitle quiet>{t('usage.board.work.branches')}</UsageWorkSectionTitle>
          <HappierDataRows
            theme={theme}
            label={t('usage.board.work.branches')}
            testID={`${testID}.branches`}
            density="compact"
            showProportionShares={false}
            valueFormatter={format}
            rowIds={row.branches.map((branch) => branch.branch.key)}
            rowLeads={row.branches.map(() => (
              <UsageWorkRowLead icon="git-branch" />
            ))}
            rowTrails={row.branches.map((branch) => (
              <UsageWorkMarks
                agentIds={branch.agentIds}
                providers={branch.providers}
                serverId={props.serverId}
              />
            ))}
            columns={branchColumns}
            rows={row.branches.map((branch) => branchCells(branch, false))}
          />
        </View>
      ) : null}
      <View style={styles.group}>
        <UsageWorkSectionTitle quiet>{t('usage.board.work.funnelSessions')}</UsageWorkSectionTitle>
        {sessionRows(row.sessions, `${testID}.session`)}
      </View>
    </>
  );
  return (
    <View style={styles.body} testID={`${props.testID}.ledger`}>
      <HappierDataRows
        theme={theme}
        label={t('usage.board.work.ledgerLabel')}
        testID={`${props.testID}.projects`}
        density={density}
        valueFormatter={format}
        showProportionShares={false}
        rowIds={summary.projects.map((row) => row.projectKey ?? '\u0000none')}
        proportionColors={summary.projects.map((_row, index) =>
          usageMeterFill(appTheme, index === 0),
        )}
        rowLeads={summary.projects.map((row) => (
          <UsageWorkRowLead
            expanded={disclosures.isOpen(`project:${row.projectKey ?? ''}`)}
            icon="folder"
          />
        ))}
        rowTrails={summary.projects.map((row) => (
          <UsageWorkMarks
            agentIds={row.agentIds}
            providers={row.providers}
            serverId={props.serverId}
            testID={props.testID}
          />
        ))}
        columns={[
          { label: t('usage.board.work.allProjects') },
          { label: metricLabel, proportion: true },
          { label: t('usage.board.work.funnelSessions') },
          { label: t('usage.board.work.notLinked') },
          { label: t('usage.board.work.provider') },
        ]}
        rows={summary.projects.map((row) => [
          projectLabel(row.projectKey),
          row.amount ?? format(null),
          t('usage.board.work.ledgerRowLine', {
            sessions: row.sessionIds.length,
            prs: row.outcomes.length,
          }),
          row.unallocated === null || row.unallocated > 0
            ? t('usage.board.work.notLinkedPart', {
                amount: format(row.unallocated),
              })
            : '',
          usageWorkProviderUnknownLine(row),
        ])}
        renderRow={(_cells, visual, index) => {
          const row = summary.projects[index]!;
          const id = `project:${row.projectKey ?? ''}`;
          const testID = `${props.testID}.project.${row.projectKey ?? 'none'}`;
          return (
            <UsageWorkDisclosure
              expanded={disclosures.isOpen(id)}
              onToggle={() => disclosures.toggle(id)}
              label={projectLabel(row.projectKey)}
              testID={testID}
              detail={() => projectDetail(row, testID)}
            >
              {visual}
            </UsageWorkDisclosure>
          );
        }}
      />
      {summary.branches.length > 0 ? (
        <View style={styles.section}>
          <UsageWorkSectionTitle>{t('usage.board.work.branches')}</UsageWorkSectionTitle>
          <HappierDataRows
            theme={theme}
            label={t('usage.board.work.branches')}
            testID={`${props.testID}.branches`}
            density={density}
            showProportionShares={false}
            valueFormatter={format}
            rowIds={summary.branches.map((row) => row.branch.key)}
            rowLeads={summary.branches.map((row) => (
              <UsageWorkRowLead
                expanded={disclosures.isOpen(`branch:${row.branch.key}`)}
                icon="git-branch"
              />
            ))}
            rowTrails={summary.branches.map((row) => (
              <UsageWorkMarks
                agentIds={row.agentIds}
                providers={row.providers}
                serverId={props.serverId}
              />
            ))}
            columns={branchColumns}
            rows={summary.branches.map((row) => branchCells(row, true))}
            renderRow={(_cells, visual, index) => {
              const row = summary.branches[index]!;
              const id = `branch:${row.branch.key}`;
              const testID = `${props.testID}.branch.${row.branch.key}`;
              return (
                <UsageWorkDisclosure
                  expanded={disclosures.isOpen(id)}
                  onToggle={() => disclosures.toggle(id)}
                  label={usageWorkBranchName(row.branch.branch.ref)}
                  testID={testID}
                  detail={() => (
                    <>
                      {row.commits.length > 0 ? (
                        <View style={styles.group}>
                          <UsageWorkSectionTitle quiet>
                            {t('usage.board.work.commits')}
                          </UsageWorkSectionTitle>
                          <Text
                            style={[styles.commits, caption]}
                            testID={`${testID}.commits`}
                            accessibilityLabel={`${t('usage.board.work.commits')}: ${row.commits.join(', ')}`}
                          >
                            {row.commits.map(usageWorkShortCommit).join('  ')}
                          </Text>
                        </View>
                      ) : null}
                      <View style={styles.group}>
                        <UsageWorkSectionTitle quiet>
                          {t('usage.board.work.funnelSessions')}
                        </UsageWorkSectionTitle>
                        {sessionRows(row.sessions, `${testID}.session`)}
                      </View>
                    </>
                  )}
                >
                  {visual}
                </UsageWorkDisclosure>
              );
            }}
          />
        </View>
      ) : null}
      {/* Conservation: the total, then its two exact parts, then every reason the second is not linked. */}
      <View
        style={styles.conservation}
        testID={`${props.testID}.conservation`}
        accessible
        accessibilityLabel={[
          `${t('usage.board.work.allProjects')}: ${format(summary.total)}`,
          t('usage.board.work.conservation', {
            allocated: format(summary.allocated),
            unallocated: format(summary.unallocated),
          }),
          ...reasons.map(
            (reason) =>
              `${format(summary.unallocatedByReason[reason])} ${t(`usage.board.work.reason_${reason}`)}`,
          ),
        ].join(', ')}
      >
        <View style={styles.line}>
          <Text style={[styles.totalLabel, title]}>{t('usage.board.work.allProjects')}</Text>
          <Text style={[styles.totalValue, title]}>{format(summary.total)}</Text>
        </View>
        <View style={styles.line}>
          <Text style={[styles.partLabel, caption]}>{t('usage.board.work.linkedToPrs')}</Text>
          <Text style={[styles.partValue, caption]}>{format(summary.allocated)}</Text>
        </View>
        <View style={styles.line}>
          <Text style={[styles.partLabel, caption]}>{t('usage.board.work.notLinked')}</Text>
          <Text style={[styles.partValue, caption]}>{format(summary.unallocated)}</Text>
        </View>
        {reasons.map((reason) => (
          <View key={reason} style={[styles.line, styles.reason]}>
            <Text style={[styles.reasonLabel, caption]}>
              {t(`usage.board.work.reason_${reason}`)}
            </Text>
            <Text style={[styles.reasonValue, caption]}>
              {format(summary.unallocatedByReason[reason])}
            </Text>
          </View>
        ))}
      </View>
      {summary.missingMoneyCount > 0 ? (
        <Text style={[styles.reasonLabel, caption]} testID={`${props.testID}.unpriced`}>
          {t('usage.board.page.factUnpriced')} · {summary.missingMoneyCount} ·{' '}
          {t('usage.board.page.unpricedCaption')}
        </Text>
      ) : null}
      <UsageCoverageLine
        slice={props.slice}
        sources={['work', 'accounting']}
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
  group: { gap: 6, minWidth: 0 },
  filter: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, minHeight: 32 },
  filterLabel: { ...Typography.default('semiBold'), color: theme.colors.text.secondary },
  commits: {
    ...Typography.mono(),
    color: theme.colors.text.secondary,
  },
  conservation: {
    gap: 4,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  reason: { paddingLeft: 12 },
  totalLabel: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
  totalValue: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  partLabel: { ...Typography.default(), color: theme.colors.text.secondary, flexShrink: 1 },
  partValue: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  reasonLabel: { ...Typography.default(), color: theme.colors.text.tertiary, flexShrink: 1 },
  reasonValue: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
}));
