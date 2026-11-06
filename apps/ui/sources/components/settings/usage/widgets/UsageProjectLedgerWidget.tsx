import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { ChartDatum, HappierDataRows, HappierPressable } from '@happier-dev/plugin-ui/presentation';
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
  UsageShowAllRows,
  leadingUsageRows,
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
  usageWorkPullRequestState,
  usageWorkPullRequestTitle,
  usageWorkShortCommit,
  usageWorkRetainedChangeLine,
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
  const { summary, format, cell, datum, projectLabel, projectPlace, sessionLabel, openSession } = useUsageWork(
    props.slice,
    props.query,
    props.serverId,
  );
  const drill = useUsageDrill(props.query);
  const disclosures = useUsageWorkDisclosures();
  const [showAllProjects, setShowAllProjects] = React.useState(false);
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
  // A shared Project name keeps its place on the row's second line; the one-string form serves labels that have no second line.
  const projectWhere = (projectKey: string | null) => [projectLabel(projectKey), projectPlace(projectKey)].filter(Boolean).join(' · ');
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
  const noneLinked = summary.allocated === 0 && summary.total !== null && summary.total > 0;
  // The PR qualifier is said once for the band: rows carry PR facts only when some project has one.
  const anyLinked = summary.projects.some((row) => row.outcomes.length > 0);
  const lead = leadingUsageRows(summary.projects, showAllProjects);
  const projects = lead.rows;
  const combineDatums = (label: string, values: readonly ReturnType<typeof datum>[]) => {
    const details = values.filter(value => value !== null);
    return details.length === 0 ? null : { label, value: details.map(value => `${value.label}: ${value.value}`).join(' · '),
      subtitle: details.map(value => value.subtitle).filter(Boolean).join(' · ') };
  };
  const branchDatum = (row: UsageWorkBranchRow) => combineDatums(usageWorkBranchName(row.branch.branch.ref), [
    datum(metricLabel, row.amount, row.moneyBasis),
    row.sessions.length < 2 ? null : datum(t('usage.board.work.perSession', { amount: '' }), row.perSession, row.moneyBasis),
  ]);
  const conservationDatum = combineDatums(t('usage.board.work.allProjects'), [
    datum(t('usage.board.work.allProjects'), summary.total),
    ...(noneLinked ? [] : [datum(t('usage.board.work.linkedToPrs'), summary.allocated, summary.allocatedBasis),
      datum(t('usage.board.work.notLinked'), summary.unallocated, summary.unallocatedBasis),
      ...reasons.map(reason => datum(t(`usage.board.work.reason_${reason}`), summary.unallocatedByReason[reason], summary.unallocatedReasonBases[reason]))]),
  ]);
  const withConservationDetail = (visual: React.ReactNode) => conservationDatum
    ? <ChartDatum datum={conservationDatum} testID={`${props.testID}.conservation.detail`}>{visual}</ChartDatum> : visual;
  const sessionRows = (parts: UsageWorkProjectRow['sessions'], testID: string) => (
    <UsageWorkSessionRows
      parts={parts}
      summary={summary}
      format={format}
      cell={cell}
      datum={datum}
      sessionLabel={sessionLabel}
      openSession={openSession}
      serverId={props.serverId}
      testID={testID}
    />
  );
  const branchCells = (row: UsageWorkBranchRow, withProject: boolean) => [
    usageWorkBranchName(row.branch.branch.ref),
    cell(row.amount, row.moneyBasis),
    withProject ? row.projectKeys.map(projectWhere).join(', ') : '',
    sessionsLine(row.sessions.length),
    row.perSession === null || row.sessions.length < 2
      ? ''
      : t('usage.board.work.perSession', { amount: format(row.perSession, row.moneyBasis) }),
    `${t('usage.board.work.commit')} ${usageWorkShortCommit(row.branch.branch.headSha)}`,
    usageWorkRetainedChangeLine(row.retainedChanges),
    row.linkedPullRequests.map(usageWorkPullRequestTitle).join(' · ') || t('usage.board.work.noOutcome'),
  ];
  const branchColumns = [
    { label: t('usage.board.work.branches') },
    { label: metricLabel, proportion: true },
    { label: t('usage.board.work.allProjects') },
    { label: t('usage.board.work.funnelSessions') },
    { label: metricLabel },
    { label: t('usage.board.work.commit') },
    { label: t('usage.board.work.linesKept') },
    { label: t('usage.board.work.linkedPrs') },
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
              cell(outcome.amount, outcome.moneyBasis),
              t('usage.board.work.prLine', {
                sessions: outcome.sessions.length,
                state: usageWorkPullRequestState(outcome.outcome.pullRequest),
              }),
            ])}
            rowDatums={row.outcomes.map(outcome => datum(usageWorkPullRequestTitle(outcome.outcome.pullRequest), outcome.amount, outcome.moneyBasis))}
          />
        </View>
      ) : null}
      {row.branches.length > 0 ? (
        <View style={styles.group}>
          <UsageWorkSectionTitle quiet caption={row.branches.some(branch => branch.retainedChanges.length > 0)
            ? t('usage.board.work.linesKeptMethod') : undefined}>{t('usage.board.work.branches')}</UsageWorkSectionTitle>
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
            rowDatums={row.branches.map(branchDatum)}
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
        rowIds={projects.map((row) => row.projectKey ?? '\u0000none')}
        proportionColors={projects.map((_row, index) =>
          usageMeterFill(appTheme, index === 0),
        )}
        rowLeads={projects.map((row) => (
          <UsageWorkRowLead
            expanded={disclosures.isOpen(`project:${row.projectKey ?? ''}`)}
            icon="folder"
          />
        ))}
        rowTrails={projects.map((row) => (
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
          ...(anyLinked ? [{ label: t('usage.board.work.notLinked') }] : []),
        ]}
        rows={projects.map((row) => [
          projectLabel(row.projectKey),
          cell(row.amount, row.moneyBasis),
          [anyLinked
            ? t('usage.board.work.ledgerRowLine', { sessions: row.sessionIds.length, prs: row.outcomes.length })
            : sessionsLine(row.sessionIds.length), projectPlace(row.projectKey)].filter(Boolean).join(' · '),
          ...(anyLinked
            ? [row.unallocated === null || row.unallocated > 0
              ? t('usage.board.work.notLinkedPart', { amount: format(row.unallocated, row.unallocatedBasis) })
              : '']
            : []),
        ])}
        rowDatums={projects.map(row => combineDatums(projectWhere(row.projectKey), [
          datum(metricLabel, row.amount, row.moneyBasis),
          anyLinked ? datum(t('usage.board.work.notLinked'), row.unallocated, row.unallocatedBasis) : null,
        ]))}
        renderIdentity={(_cells, visual, index) => {
          const row = projects[index]!;
          const id = `project:${row.projectKey ?? ''}`;
          return <HappierPressable accessibilityLabel={projectWhere(row.projectKey)} expanded={disclosures.isOpen(id)}
            testID={`${props.testID}.project.${row.projectKey ?? 'none'}.toggle`} onPress={() => disclosures.toggle(id)}>{visual}</HappierPressable>;
        }}
        renderRow={(_cells, visual, index) => {
          const row = projects[index]!;
          const id = `project:${row.projectKey ?? ''}`;
          const testID = `${props.testID}.project.${row.projectKey ?? 'none'}`;
          return (
            <UsageWorkDisclosure
              expanded={disclosures.isOpen(id)}
              testID={testID}
              detail={() => projectDetail(row, testID)}
            >
              {visual}
            </UsageWorkDisclosure>
          );
        }}
      />
      <UsageShowAllRows
        label={t('usage.board.work.ledgerLabel')}
        total={summary.projects.length}
        hidden={lead.hidden}
        expanded={showAllProjects}
        onToggle={() => setShowAllProjects((value) => !value)}
        testID={`${props.testID}.projects.more`}
      />
      {summary.branches.length > 0 ? (
        <View style={styles.section}>
          <UsageWorkSectionTitle caption={summary.branches.some(branch => branch.retainedChanges.length > 0)
            ? t('usage.board.work.linesKeptMethod') : undefined}>{t('usage.board.work.branches')}</UsageWorkSectionTitle>
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
            rowDatums={summary.branches.map(branchDatum)}
            renderIdentity={(_cells, visual, index) => {
              const row = summary.branches[index]!;
              const id = `branch:${row.branch.key}`;
              return <HappierPressable accessibilityLabel={usageWorkBranchName(row.branch.branch.ref)} expanded={disclosures.isOpen(id)}
                testID={`${props.testID}.branch.${row.branch.key}.toggle`} onPress={() => disclosures.toggle(id)}>{visual}</HappierPressable>;
            }}
            renderRow={(_cells, visual, index) => {
              const row = summary.branches[index]!;
              const id = `branch:${row.branch.key}`;
              const testID = `${props.testID}.branch.${row.branch.key}`;
              return (
                <UsageWorkDisclosure
                  expanded={disclosures.isOpen(id)}
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
      {withConservationDetail(<View
        style={styles.conservation}
        testID={`${props.testID}.conservation`}
        accessible
        accessibilityLabel={[
          `${t('usage.board.work.allProjects')}: ${format(summary.total)}`,
          t('usage.board.work.conservation', {
            allocated: format(summary.allocated, summary.allocatedBasis),
            unallocated: format(summary.unallocated, summary.unallocatedBasis),
          }),
          ...reasons.map(
            (reason) =>
              `${format(summary.unallocatedByReason[reason], summary.unallocatedReasonBases[reason])} ${t(`usage.board.work.reason_${reason}`)}`,
          ),
        ].join(', ')}
      >
        {/* Nothing linked: every part would repeat the total, so the total is said once with one
            sentence (and its single reason, when there is one). A single project row already shows it. */}
        {noneLinked ? (
          <>
            {summary.projects.length > 1 ? (
              <View style={styles.line}>
                <Text style={[styles.totalLabel, title]}>{t('usage.board.work.allProjects')}</Text>
                <Text style={[styles.totalValue, title]}>{format(summary.total)}</Text>
              </View>
            ) : null}
            <Text style={[styles.reasonLabel, caption]}>
              {[t('usage.board.work.noneLinked'), ...(reasons.length === 1 ? [t(`usage.board.work.reason_${reasons[0]}`)] : [])].join(' · ')}
            </Text>
          </>
        ) : (
          <>
            <View style={styles.line}>
              <Text style={[styles.totalLabel, title]}>{t('usage.board.work.allProjects')}</Text>
              <Text style={[styles.totalValue, title]}>{format(summary.total)}</Text>
            </View>
            <View style={styles.line}>
              <Text style={[styles.partLabel, caption]}>{t('usage.board.work.linkedToPrs')}</Text>
              <Text style={[styles.partValue, caption]}>{format(summary.allocated, summary.allocatedBasis)}</Text>
            </View>
            <View style={styles.line}>
              <Text style={[styles.partLabel, caption]}>{t('usage.board.work.notLinked')}</Text>
              <Text style={[styles.partValue, caption]}>{format(summary.unallocated, summary.unallocatedBasis)}</Text>
            </View>
            {reasons.map((reason) => (
              <View key={reason} style={[styles.line, styles.reason]}>
                <Text style={[styles.reasonLabel, caption]}>
                  {t(`usage.board.work.reason_${reason}`)}
                </Text>
                <Text style={[styles.reasonValue, caption]}>
                  {format(summary.unallocatedByReason[reason], summary.unallocatedReasonBases[reason])}
                </Text>
              </View>
            ))}
          </>
        )}
      </View>)}
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
    gap: theme.space.s10,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  group: { gap: theme.space.s6, minWidth: 0 },
  filter: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: theme.space.s6, minHeight: 32 },
  filterLabel: { ...Typography.default('semiBold'), color: theme.colors.text.secondary },
  commits: {
    ...Typography.mono(),
    color: theme.colors.text.secondary,
  },
  conservation: {
    gap: theme.space.s4,
    paddingTop: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.s12,
  },
  reason: { paddingLeft: theme.space.s12 },
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
