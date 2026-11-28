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
import { usageCostKindPhrase } from '../usageCostPresentation';
import { formatUsageCost } from '@/utils/format/usageNumbers';
import { usageAgentTitle } from '@/sync/domains/usage/usageLabels';
import {
  UsageBodyInsufficient,
  UsageBodyPageLine,
  UsageCoverageLine,
  UsageShowAllRows,
  leadingUsageRows,
  usagePeriodPhrase,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { useUsageWork } from './useUsageWork';
import { useUsageWidgetPageHasCoverageDetail } from './usageWidgetBatch';
import { usageWorkProviderIdentities, usageWorkProviderNames } from './UsageWorkProviderMark';
import type {
  UsageWorkBranchRow,
  UsageWorkIdentities,
  UsageWorkProjectRow,
} from './usageWorkPresentation';
import {
  USAGE_WORK_UNALLOCATED_REASONS,
  UsageWorkDisclosure,
  UsageWorkMarks,
  UsageWorkReading,
  UsageWorkRowLead,
  UsageWorkSectionTitle,
  UsageWorkSessionRows,
  usageWorkAllocationReasonLabel,
  usageWorkBranchName,
  usageWorkPullRequestState,
  usageWorkPullRequestTitle,
  usageWorkShortCommit,
  usageWorkLinksNotice,
  usageWorkLinksReadAt,
  usageWorkPageReadLabel,
  usageWorkRetainedChangeLine,
  useUsageWorkDisclosures,
} from './UsageWorkParts';

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
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  const [showAllProjects, setShowAllProjects] = React.useState(false);
  // A Project or branch can hold hundreds of PRs and branches: each detail list leads with its largest and folds the
  // rest behind the same "Show all · n" as the ledger (acceptance r224 #48). Keyed by the list's testID.
  const [openLists, setOpenLists] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggleList = (key: string) => setOpenLists(current => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const listMore = (key: string, label: string, total: number, hidden: number) => (
    <UsageShowAllRows label={label} total={total} hidden={hidden} expanded={openLists.has(key)}
      onToggle={() => toggleList(key)} testID={`${key}.more`} />
  );
  const disclosures = useUsageWorkDisclosures([
    ...leadingUsageRows(summary?.projects ?? [], showAllProjects).rows.map(row => ({
      id: `project:${row.projectKey ?? ''}`,
      title: [projectLabel(row.projectKey), projectPlace(row.projectKey)].filter(Boolean).join(' · '),
    })),
    ...(summary?.branches ?? []).map(row => ({ id: `branch:${row.branch.key}`, title: usageWorkBranchName(row.branch.branch.ref) })),
  ]);
  useWidgetFrameBodyCaption(
    t('usage.board.work.ledgerCaption', {
      period: usagePeriodPhrase(props.query),
    }),
  );
  const compact =
    presentation?.footprint.width === 'half' ||
    presentation?.footprint.width === 'compact' ||
    (presentation?.geometry?.width ?? Number.POSITIVE_INFINITY) < 420;
  // Work links not read whole: still reading, settled with some Sessions unread, or failed (one decision, one wording).
  const linksNotice = usageWorkLinksNotice(props.slice);
  const linksReadAt = usageWorkLinksReadAt(props.slice);
  const pageState = pageHasDetail && (linksNotice.state === 'partial' || linksNotice.state === 'unavailable')
    ? usageWorkPageReadLabel(linksNotice.state) : null;
  if (!summary) {
    if (linksNotice.state === 'reading') return <UsageWorkReading slice={props.slice} testID={props.testID} />;
    return pageState ? <UsageBodyPageLine testID={`${props.testID}.workUnavailable`} title={pageState} /> : (
      <View style={styles.body}>
        <UsageBodyInsufficient
          testID={`${props.testID}.workUnavailable`}
          title={linksNotice.title}
          reason={linksNotice.cause ?? t('usage.board.work.workUnavailableReason')}
        />
        <UsageCoverageLine
          slice={props.slice}
          sources={['work', 'accounting']}
          onRetry={props.model.refresh}
          testID={`${props.testID}.coverage`}
        />
      </View>
    );
  }
  if (summary.projects.length === 0)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.work.emptyTitle')}
        reason={t('usage.board.work.emptyReason')}
      />
    );
  const density = compact ? 'compact' : 'comfortable';
  const projectMarks = (row: UsageWorkProjectRow) => (
    <UsageWorkMarks fitWidth agentIds={row.agentIds} providers={row.providers} serverId={props.serverId} testID={props.testID} />
  );
  // The amount alone in the figure column; a basis that differs from the whole's is said on the row's quiet line.
  const sameCurrency = (moneyBasis: UsageWorkProjectRow['moneyBasis']) => props.query.metric === 'cost' && moneyBasis !== null
    && summary.moneyBasis !== null && summary.moneyBasis !== undefined && moneyBasis.currency === summary.moneyBasis.currency;
  const compactCell = (value: number | null, moneyBasis: UsageWorkProjectRow['moneyBasis']) =>
    value !== null && sameCurrency(moneyBasis) ? value : cell(value, moneyBasis);
  const compactBasis = (value: number | null, moneyBasis: UsageWorkProjectRow['moneyBasis']) =>
    value !== null && sameCurrency(moneyBasis) && moneyBasis!.kind !== summary.moneyBasis!.kind ? usageCostKindPhrase(moneyBasis!.kind) : null;
  const compactFormat = (value: number) => props.query.metric === 'cost' && summary.moneyBasis
    ? formatUsageCost(value, summary.moneyBasis.currency) : format(value);
  const metricLabel = props.query.metric === 'cost' ? t('usage.cost') : t('usage.tokens');
  // Usage with no Session behind it is said for what it is; "0 sessions" reads as a contradiction beside its amount.
  const sessionsLine = (count: number) => count === 0 ? t('usage.board.work.noSessionLine') : t('usage.board.work.valueCaption', { count });
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
  const reasons = USAGE_WORK_UNALLOCATED_REASONS.filter(
    (reason) =>
      summary.unallocatedByReason[reason] === null || (summary.unallocatedByReason[reason] ?? 0) > 0,
  );
  // The PR qualifier is said once for the band: rows carry PR facts only when some project has one.
  const anyLinked = summary.projects.some((row) => row.outcomes.length > 0);
  const allocationRead = props.slice.workSummary?.pullRequestsRead === true;
  const noneLinked = !anyLinked && summary.allocated === 0 && summary.total !== null && summary.total > 0;
  const showAllocationParts = allocationRead && !noneLinked;
  // An unread or partly read set of links is said once, here at the total, with the owner's cause; never on a row.
  const allocationStatus = !allocationRead ? pageState ?? [linksNotice.title, linksNotice.cause, linksReadAt].filter(Boolean).join(' · ')
    : noneLinked ? [t('usage.board.work.noneLinked'), linksNotice.cause, linksReadAt].filter(Boolean).join(' · ') : null;
  // A read set of links still says when it was read, in the total's one quiet line (J-A35).
  const totalNote = [linksReadAt, summary.tokensFromParts ? t('usage.board.page.tokensFromParts') : null].filter(Boolean).join(' · ');
  const totalNoteText = totalNote ? `${totalNote.charAt(0).toLocaleUpperCase()}${totalNote.slice(1)}` : null;
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
    ...(!showAllocationParts ? [] : [datum(t('usage.board.work.linkedToPrs'), summary.allocated, summary.allocatedBasis),
      datum(t('usage.board.work.notLinked'), summary.unallocated, summary.unallocatedBasis),
      ...reasons.map(reason => datum(usageWorkAllocationReasonLabel(reason), summary.unallocatedByReason[reason], summary.unallocatedReasonBases[reason]))]),
  ]);
  const withConservationDetail = (visual: React.ReactNode) => conservationDatum
    ? <ChartDatum datum={conservationDatum} testID={`${props.testID}.conservation.detail`}>{visual}</ChartDatum> : visual;
  const sessionRows = (parts: UsageWorkProjectRow['sessions'], testID: string) => (
    <UsageWorkSessionRows
      title={t('usage.board.work.funnelSessions')}
      outcomesRead={allocationRead}
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
  const branchProjects = (row: UsageWorkBranchRow) => row.projectKeys.map(projectWhere).join(', ');
  const branchPerSession = (row: UsageWorkBranchRow) => row.perSession === null || row.sessions.length < 2
    ? '' : t('usage.board.work.perSession', { amount: format(row.perSession, row.moneyBasis) });
  const branchHead = (row: UsageWorkBranchRow) =>
    `${t('usage.board.work.commit')} ${usageWorkShortCommit(row.branch.branch.headSha)}`;
  const branchPullRequests = (row: UsageWorkBranchRow) => row.linkedPullRequests.map(usageWorkPullRequestTitle).join(' · ')
    || t('usage.board.work.noOutcome');
  // A narrow card keeps a branch row's session count and diff; where it ran, its cost per session, commit and PRs open with
  // the row (its detail lists the commits), so the meta never wraps onto two cut lines (USAGE-DESIGN-PASS-57 #9).
  const branchCells = (row: UsageWorkBranchRow, withProject: boolean) => {
    const opensDetail = compact && withProject;
    return [
      usageWorkBranchName(row.branch.branch.ref),
      cell(row.amount, row.moneyBasis),
      withProject && !opensDetail ? branchProjects(row) : '',
      sessionsLine(row.sessions.length),
      opensDetail ? '' : branchPerSession(row),
      opensDetail ? '' : branchHead(row),
      usageWorkRetainedChangeLine(row.retainedChanges, row.branch.branch.headSha),
      opensDetail ? '' : branchPullRequests(row),
    ];
  };
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
  // Details name the full set witnessed for their own row, independently of the fitted strip: one name per identity
  // (identity decides, never the label), the same in the visible line and the spoken label (review J-B31).
  const identityNames = (row: UsageWorkIdentities) => {
    const agents = row.agentIds.map(id => usageAgentTitle(id));
    return [...agents, ...usageWorkProviderNames(usageWorkProviderIdentities(row.providers), props.serverId, agents)].join(' · ');
  };
  const identityLine = (row: UsageWorkIdentities, testID: string) => {
    const names = identityNames(row);
    return names ? <Text style={[styles.reasonLabel, caption]} testID={`${testID}.identities`}>{names}</Text> : null;
  };
  const withIdentityDatum = (
    row: UsageWorkIdentities & Pick<UsageWorkProjectRow, 'amount' | 'moneyBasis'>,
    label: string,
    exact: ReturnType<typeof datum>,
  ) => {
    const names = identityNames(row);
    if (!names) return exact;
    const value = exact?.value ?? format(row.amount, row.moneyBasis);
    return {
      label,
      value,
      subtitle: [exact?.subtitle, names].filter(Boolean).join(' · '),
      accessibilityLabel: `${label}: ${value} · ${names}`,
    };
  };
  const projectDetail = (row: UsageWorkProjectRow, testID: string) => {
    const prs = leadingUsageRows(row.outcomes, openLists.has(`${testID}.prs`));
    const branches = leadingUsageRows(row.branches, openLists.has(`${testID}.branches`));
    return <>
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
      {identityLine(row, testID)}
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
            rowIds={prs.rows.map((outcome) => outcome.key)}
            rowLeads={prs.rows.map((outcome) => (
              <UsageWorkRowLead
                icon="git-pull-request"
                color={
                  outcome.outcome.pullRequest.state === 'merged'
                    ? usageSignatureAccent(appTheme)
                    : undefined
                }
              />
            ))}
            rowTrails={prs.rows.map((outcome) => (
              <UsageWorkMarks fitWidth
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
            rows={prs.rows.map((outcome) => [
              usageWorkPullRequestTitle(outcome.outcome.pullRequest),
              cell(outcome.amount, outcome.moneyBasis),
              t('usage.board.work.prLine', {
                sessions: outcome.sessions.length,
                state: usageWorkPullRequestState(outcome.outcome.pullRequest),
              }),
            ])}
            rowDatums={prs.rows.map(outcome => {
              const label = usageWorkPullRequestTitle(outcome.outcome.pullRequest);
              return withIdentityDatum(outcome, label, datum(label, outcome.amount, outcome.moneyBasis));
            })}
          />
          {listMore(`${testID}.prs`, t('usage.board.work.linkedPrs'), row.outcomes.length, prs.hidden)}
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
            rowIds={branches.rows.map((branch) => branch.branch.key)}
            rowLeads={branches.rows.map(() => (
              <UsageWorkRowLead icon="git-branch" />
            ))}
            rowTrails={branches.rows.map((branch) => (
              <UsageWorkMarks fitWidth
                agentIds={branch.agentIds}
                providers={branch.providers}
                serverId={props.serverId}
              />
            ))}
            columns={branchColumns}
            rows={branches.rows.map((branch) => branchCells(branch, false))}
            rowDatums={branches.rows.map(branch =>
              withIdentityDatum(branch, usageWorkBranchName(branch.branch.branch.ref), branchDatum(branch)))}
          />
          {listMore(`${testID}.branches`, t('usage.board.work.branches'), row.branches.length, branches.hidden)}
        </View>
      ) : null}
      {sessionRows(row.sessions, `${testID}.session`)}
    </>;
  };
  return (
    <View style={styles.body} testID={`${props.testID}.ledger`}>
      <HappierDataRows
        theme={theme}
        label={t('usage.board.work.ledgerLabel')}
        testID={`${props.testID}.projects`}
        density={density}
        valueFormatter={compact ? compactFormat : format}
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
        // A narrow card keeps the project's name whole: its marks sit under the name and the amount drops its basis
        // phrase to the row's quiet line (the Agents list rows), so nothing is cut at the card's edge.
        rowTrails={compact ? undefined : projects.map((row) => projectMarks(row))}
        columns={[
          { label: t('usage.board.work.allProjects') },
          { label: metricLabel, proportion: true },
          { label: t('usage.board.work.funnelSessions') },
          ...(anyLinked && allocationRead ? [{ label: t('usage.board.work.notLinked') }] : []),
        ]}
        rows={projects.map((row) => [
          projectLabel(row.projectKey),
          compact ? compactCell(row.amount, row.moneyBasis) : cell(row.amount, row.moneyBasis),
          [(allocationRead && anyLinked) || row.outcomes.length > 0
            ? t('usage.board.work.ledgerRowLine', { sessions: row.sessionIds.length, prs: row.outcomes.length })
            : sessionsLine(row.sessionIds.length), compact ? compactBasis(row.amount, row.moneyBasis) : null,
            // Token totals added up from their parts are said once, by the total below, never on a row (USAGE-ACCEPT 1121 #13).
            projectPlace(row.projectKey)].filter(Boolean).join(' · '),
          // Unread links leave each row's unlinked part unknown: the total says so once (acceptance 1122 #57).
          ...(anyLinked && allocationRead
            ? [row.unallocated === null || row.unallocated > 0
              ? t('usage.board.work.notLinkedPart', { amount: format(row.unallocated, row.unallocatedBasis) })
              : '']
            : []),
        ])}
        rowDatums={projects.map(row => combineDatums(projectWhere(row.projectKey), [
          datum(metricLabel, row.amount, row.moneyBasis),
          allocationRead && anyLinked ? datum(t('usage.board.work.notLinked'), row.unallocated, row.unallocatedBasis) : null,
        ]))}
        renderIdentity={(_cells, visual, index) => {
          const row = projects[index]!;
          const id = `project:${row.projectKey ?? ''}`;
          return <HappierPressable accessibilityLabel={projectWhere(row.projectKey)} expanded={disclosures.isOpen(id)}
            testID={`${props.testID}.project.${row.projectKey ?? 'none'}.toggle`} onPress={() => disclosures.toggle(id)}>
            {compact ? <View style={styles.identity}>{visual}{projectMarks(row)}</View> : visual}
          </HappierPressable>;
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
              <UsageWorkMarks fitWidth
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
                      {compact ? <Text style={[styles.reasonLabel, caption]} testID={`${testID}.meta`}>
                        {[branchProjects(row), branchPerSession(row), branchHead(row), branchPullRequests(row)].filter(Boolean).join(' · ')}
                      </Text> : null}
                      {identityLine(row, testID)}
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
                      {sessionRows(row.sessions, `${testID}.session`)}
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
          ...(allocationStatus ? [allocationStatus] : [
            ...(linksReadAt ? [linksReadAt] : []),
            t('usage.board.work.conservation', {
              allocated: format(summary.allocated, summary.allocatedBasis),
              unallocated: format(summary.unallocated, summary.unallocatedBasis),
            }),
            ...reasons.map(reason =>
              `${format(summary.unallocatedByReason[reason], summary.unallocatedReasonBases[reason])} ${usageWorkAllocationReasonLabel(reason)}`),
          ]),
        ].join(', ')}
      >
        {/* Nothing linked: every part would repeat the total, so the total is said once with one
            sentence (and its single reason, when there is one). A single project row already shows it. */}
        {allocationStatus ? (
          <>
            {summary.projects.length > 1 ? (
              <View style={styles.line}>
                <Text style={[styles.totalLabel, title]}>{t('usage.board.work.allProjects')}</Text>
                <Text style={[styles.totalValue, title]}>{format(summary.total)}</Text>
              </View>
            ) : null}
            <Text style={[styles.reasonLabel, caption]}>
              {[allocationStatus,
                ...(summary.tokensFromParts ? [t('usage.board.page.tokensFromParts')] : [])].join(' · ')}
            </Text>
          </>
        ) : (
          <>
            <View style={styles.line}>
              <Text style={[styles.totalLabel, title]}>{t('usage.board.work.allProjects')}</Text>
              <Text style={[styles.totalValue, title]}>{format(summary.total)}</Text>
            </View>
            {totalNoteText ? <Text style={[styles.reasonLabel, caption]}>{totalNoteText}</Text> : null}
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
                  {usageWorkAllocationReasonLabel(reason)}
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
          {t('usage.board.page.factUnpriced')} · {t('usage.board.page.unpricedRecords', { count: summary.missingMoneyCount.toLocaleString() })} ·{' '}
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
  identity: { gap: theme.space.s4, minWidth: 0 },
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
