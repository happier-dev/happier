import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  HappierPressable,
  OutcomeScatter,
  RankedRows,
} from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { getAgentIdentityColor } from '@/agents/catalog/catalog';
import { usageOtherColor, usageSeriesColor } from '../usageAccent';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  usageAgentTitle,
  useUsagePluginTheme,
  type UsageBodyProps,
  leadingUsageRows,
  UsageShowAllRows,
} from './usageBodyKit';
import { useUsageWork } from './useUsageWork';
import { partitionUsageWorkMoneyRows, projectUsageSessionValuePlots, type UsageWorkSessionRow } from './usageWorkPresentation';
import { UsageOutsideSessions } from './UsageExternalSessionCandidates';
import { UsageWorkAutopsy } from './UsageWorkAutopsy';
import {
  UsageWorkMarks,
  UsageWorkSectionTitle,
  usageWorkSessionOutcomeLine,
} from './UsageWorkParts';

const SCATTER_MIN_WIDTH_PX = 360;
/** The scatter's identity slots (lab `kitcharts`): three Agents, everything else is Other. */
const SCATTER_AGENT_SLOTS = 3;

/**
 * "Which sessions were worth it": each session's amount beside the merged work it is exactly linked
 * to. It names evidence; it never scores quality, and an unlinked session is "no linked outcome yet",
 * never zero output or abandoned work.
 */
export function UsageSessionValueWidget(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  const [expandedGroups, setExpandedGroups] = React.useState<readonly string[]>([]);
  const { theme: appTheme } = useUnistyles();
  const presentation = useWidgetPresentation();
  const rowMetrics = usePageRowMetrics('list');
  const outside = <UsageOutsideSessions serverId={props.serverId} query={props.query} testID={`${props.testID}.outside`} />;
  const { summary, format, datum, basisLabel, sessionLabel, openSession } = useUsageWork(
    props.slice,
    props.query,
    props.serverId,
  );
  useWidgetFrameBodyCaption(
    summary
      ? t('usage.board.work.valueCaption', { count: summary.sessions.length })
      : null,
  );
  if (!summary)
    return (
      <View style={styles.body}>
        <UsageBodyInsufficient
          testID={`${props.testID}.workUnavailable`}
          replacesContent={false}
          title={t('usage.board.work.workUnavailableTitle')}
          reason={t('usage.board.work.workUnavailableReason')}
        />
        <UsageCoverageLine
          slice={props.slice}
          sources={['work']}
          onRetry={props.model.refresh}
          testID={`${props.testID}.coverage`}
        />
        {outside}
        {/* The body has already said Work is unavailable; the autopsy keeps only its phases. */}
        <UsageWorkAutopsy {...props} unavailableSaid testID={`${props.testID}.autopsy`} />
      </View>
    );
  if (summary.sessions.length === 0)
    return (
      <View><UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        replacesContent={false}
        title={t('usage.board.work.emptyTitle')}
        reason={t('usage.board.work.emptyReason')}
      />{outside}<UsageWorkAutopsy {...props} testID={`${props.testID}.autopsy`} /></View>
    );
  const merged = (row: UsageWorkSessionRow) =>
    row.outcomes.filter((outcome) => outcome.pullRequest.state === 'merged')
      .length;
  const groups = [
    {
      id: 'merged',
      title: t('usage.board.work.linkedMergedTitle'),
      rows: summary.sessions.filter((row) => merged(row) > 0),
    },
    {
      id: 'linked',
      title: t('usage.board.work.linkedOpenTitle'),
      rows: summary.sessions.filter(
        (row) => row.outcomes.length > 0 && merged(row) === 0,
      ),
    },
    {
      id: 'unlinked',
      title: t('usage.board.work.unlinkedTitle'),
      rows: summary.sessions.filter((row) => row.outcomes.length === 0),
    },
  ].flatMap(group => partitionUsageWorkMoneyRows(group.rows, props.query.metric)
    .map(part => ({ ...group, ...part, key: `${group.id}:${part.key}` })));
  const width = presentation?.geometry?.width ?? 0;
  const showScatter =
    width >= SCATTER_MIN_WIDTH_PX &&
    presentation?.footprint.height !== 'compact';
  const accent = usageSeriesColor(appTheme, 0);
  const quiet = usageSeriesColor(appTheme, 5);
  const sectionStyle = {
    fontSize: rowMetrics.subtitle.fontSize,
    lineHeight: rowMetrics.subtitle.lineHeight,
  };
  const slots = summary.agents.slice(0, SCATTER_AGENT_SLOTS).map((row) => row.agentId);
  const other = usageOtherColor(appTheme);
  // A Session several Agents worked on belongs to none of them alone.
  const slotOf = (row: UsageWorkSessionRow) =>
    row.agentIds.length === 1 && slots.includes(row.agentIds[0]!) ? row.agentIds[0]! : null;
  const plots = projectUsageSessionValuePlots(summary.sessions, props.query.metric);
  return (
    <View style={styles.body} testID={`${props.testID}.value`}>
      {outside}
      <UsageWorkAutopsy {...props} testID={`${props.testID}.autopsy`} />
      {showScatter ? plots.map(plot => {
        const usedSlots = slots.filter(agentId => plot.rows.some(row => slotOf(row) === agentId));
        const costliest = plot.rows[0];
        const mostMerged = plot.rows.reduce<(typeof plot.rows)[number] | undefined>(
          (best, row) => merged(row) > (best ? merged(best) : 0) ? row : best, undefined);
        const ordered = plot.rows.map(row => row.amount).sort((left, right) => left - right);
        const median = ordered.length > 1 ? ordered[Math.floor((ordered.length - 1) / 2)]! : null;
        return (
        <OutcomeScatter
          key={plot.key}
          theme={theme}
          testID={`${props.testID}.scatter`}
          label={t('usage.board.work.valueLabel')}
          xLabel={
            props.query.metric === 'cost'
              ? t('usage.board.work.xCost')
              : t('usage.board.work.xTokens')
          }
          yLabel={t('usage.board.work.yMerged')}
          unknownLabel={t('usage.board.work.noOutcome')}
          size="full"
          formatX={value => format(value, plot.moneyBasis)}
          basis={basisLabel(plot.moneyBasis)}
          legend={[
            ...usedSlots.map((agentId) => ({
              id: agentId,
              label: usageAgentTitle(agentId),
              color: getAgentIdentityColor(appTheme, agentId),
            })),
            ...(plot.rows.some((row) => slotOf(row) === null)
              ? [{ id: 'other', label: t('usage.board.work.otherAgents'), color: other }]
              : []),
          ]}
          xGuides={
            median === null
              ? undefined
              : [{ id: 'median', value: median, label: t('usage.board.work.medianSession') }]
          }
          points={plot.rows.map((row) => {
            const slot = slotOf(row);
            return {
              id: row.sessionId,
              label: sessionLabel(row.sessionId),
              x: row.amount,
              // Unlinked Sessions stay in the ledger; an open witnessed outcome is zero merged.
              y: merged(row),
              color: slot === null ? other : getAgentIdentityColor(appTheme, slot),
              annotation: usageWorkSessionOutcomeLine(row),
              labelled: row === costliest || row === mostMerged,
            };
          })}
        />
      ); }) : null}
      {groups.map((group) => {
        // A caveat every row shares is said once under the group title, never repeated per row.
        const notes = group.rows.map(row => [usageWorkSessionOutcomeLine(row)].filter(Boolean) as string[]);
        const shared = (notes[0] ?? []).filter(note => notes.every(rowNotes => rowNotes.includes(note)));
        // The group title may already be that caveat ("No linked outcome yet"); it is not said twice.
        const said = shared.filter(note => note.toLocaleLowerCase() !== group.title.toLocaleLowerCase());
        const lead = leadingUsageRows(group.rows, expandedGroups.includes(group.id));
        return (
        <View key={group.key} style={styles.group}>
          <UsageWorkSectionTitle quiet>{group.title}</UsageWorkSectionTitle>
          {said.length ? <Text style={[styles.note, sectionStyle]}>{said.join(' · ')}</Text> : null}
          <RankedRows
            theme={theme}
            label={group.title}
            size="tile"
            valueFormatter={value => format(value, group.moneyBasis)}
            basis={basisLabel(group.moneyBasis)}
            unknownLabel={format(null)}
            testID={`${props.testID}.${group.id}`}
            leads={Object.fromEntries(
              group.rows.map((row): [string, React.ReactNode] => [
                row.sessionId,
                <UsageWorkMarks
                  agentIds={row.agentIds}
                  providers={row.providers}
                  serverId={props.serverId}
                  testID={props.testID}
                />,
              ]),
            )}
            barAppearance={{
              fillOpacity: group.id === 'unlinked' ? 0.35 : undefined,
            }}
            rows={lead.rows
              .map((row) => ({
                id: row.sessionId,
                label: sessionLabel(row.sessionId),
                value: row.amount,
                color: group.id === 'unlinked' ? quiet : accent,
                annotation: [usageWorkSessionOutcomeLine(row)]
                  .filter((note): note is string => Boolean(note) && !shared.includes(note!))
                  .join(' · ') || undefined,
              }))}
            rowDatums={lead.rows.map(row => datum(sessionLabel(row.sessionId), row.amount, group.moneyBasis))}
            renderIdentity={(row, visual) => (
              <HappierPressable
                accessibilityRole="button"
                testID={`${props.testID}.open.${row.id}`}
                accessibilityLabel={t('usage.board.work.openSession', {
                  title: row.label,
                })}
                onPress={() => openSession(row.id)}
              >
                {visual}
              </HappierPressable>
            )}
          />
          <UsageShowAllRows
            label={`${t(`usage.widgets.${props.id}`)}: ${group.title}`} total={group.rows.length} hidden={lead.hidden}
            expanded={expandedGroups.includes(group.id)} testID={`${props.testID}.${group.id}.more`}
            onToggle={() => setExpandedGroups(current => current.includes(group.id)
              ? current.filter(id => id !== group.id) : [...current, group.id])} />
        </View>
        );
      })}
      <Text style={[styles.note, sectionStyle]}>
        {t('usage.board.work.judgement')}
      </Text>
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
  group: { gap: theme.space.s6 },
  note: { ...Typography.default(), color: theme.colors.text.tertiary },
}));
