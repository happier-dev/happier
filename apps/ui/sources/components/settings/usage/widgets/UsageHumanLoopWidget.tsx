import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  CompositionStrip,
  ChartDatum,
  type HappierChartDatum,
  formatHappierDataValue,
  HappierDataMetric,
  RankedRows,
} from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { getPreferredLanguage, t } from '@/text';
import { usageSeriesColor } from '../usageAccent';
import {
  UsageBodyInsufficient,
  UsageBodyReadFailed,
  isUsageReadFailed,
  UsageBodyReading,
  isUsageReadOutstanding,
  leadingUsageRows,
  UsageCoverageLine,
  usagePeriodPhrase,
  UsageShowAllRows,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import {
  formatUsageDuration,
  isUsageDurationFullyVisible,
  readUsageAnsweringShares,
  type UsageAnsweringClient,
} from './usageHowYouWorkPresentation';
import { UsageSteeringStyleBody } from './UsageChartStyleBodies';

/** Two columns only when each keeps a readable ranked row. */
const TWO_COLUMN_MIN_WIDTH_PX = 640;
const CLIENT_LABEL_KEYS: Readonly<
  Record<
    Exclude<UsageAnsweringClient, 'unknown'>,
    | 'usage.board.howYouWork.clientDesktop'
    | 'usage.board.howYouWork.clientWeb'
    | 'usage.board.howYouWork.clientIos'
    | 'usage.board.howYouWork.clientAndroid'
  >
> = {
  desktop: 'usage.board.howYouWork.clientDesktop',
  web: 'usage.board.howYouWork.clientWeb',
  ios: 'usage.board.howYouWork.clientIos',
  android: 'usage.board.howYouWork.clientAndroid',
};

/** Only precision the canonical duration formatter rounds away needs a second reading. */
function durationDatum(value: number | null, label: string): HappierChartDatum | null {
  if (value === null || isUsageDurationFullyVisible(value)) return null;
  return { label, value: t('usage.board.howYouWork.durationSeconds', {
    seconds: formatHappierDataValue(value / 1000, getPreferredLanguage()),
  }) };
}

function DurationFigure(props: Readonly<{ value: number | null; label: string; testID: string; children: React.ReactNode }>) {
  const datum = durationDatum(props.value, props.label);
  return datum ? <ChartDatum testID={props.testID} datum={datum}>{props.children}</ChartDatum> : <>{props.children}</>;
}

/** One body per widget: its Style own-input picks the encoding of the same question. */
export function UsageHumanLoopWidget(props: UsageBodyProps) {
  const style = props.presentation?.style;
  if (style === 'tide') return <UsageSteeringStyleBody {...props} />;
  return <UsageHumanLoopWidgetOriginal {...props} />;
}

/**
 * "Waiting on you": how long agents waited for an answer, for what, where the answers came from and
 * how often you steered. Only paired request→decision times count as waits; requests without a
 * recorded time stay a separate count, and answering devices show only where the client was witnessed.
 */
function UsageHumanLoopWidgetOriginal(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const width = useWidgetPresentation()?.geometry?.width;
  const howYouWork = props.slice.howYouWork;
  const permissions = howYouWork?.permissions ?? null;
  const inputs = howYouWork?.inputs ?? null;
  const [toolsExpanded, setToolsExpanded] = React.useState(false);
  // The period names the cell even before anything is readable; the frame's follow label ("This page") says nothing here.
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  const tools = React.useMemo(
    () =>
      permissions
        ? [...permissions.byTool]
            .filter((tool) => tool.decisionLatencyMs !== null)
            .sort(
              (a, b) => (b.decisionLatencyMs ?? 0) - (a.decisionLatencyMs ?? 0),
            )
            .map((tool, index) => ({
              id: tool.toolId ?? 'unknown',
              label: tool.toolId ?? t('usage.board.howYouWork.unknownTool'),
              value: tool.decisionLatencyMs,
              color:
                index === 0
                  ? usageSeriesColor(theme, 0)
                  : theme.colors.text.secondary,
              annotation: t('usage.board.howYouWork.approvalCount', {
                count: tool.pairedDecisionCount,
              }),
            }))
        : [],
    [permissions, theme],
  );
  if (!permissions && !inputs) {
    if (isUsageReadOutstanding(props.slice, ['how_you_work']))
      return <UsageBodyReading testID={`${props.testID}.loading`} waitingOn={{ slice: props.slice, sources: ['how_you_work'] }} />;
    if (isUsageReadFailed(props.slice, ['how_you_work']))
      return <UsageBodyReadFailed slice={props.slice} sources={['how_you_work']} testID={props.testID} onRetry={props.model.refresh} />;
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.howYouWork.loopUnknownTitle')}
        reason={t('usage.board.howYouWork.loopUnknownReason')}
      />
    );
  }
  const paired = permissions?.pairedDecisionCount ?? 0;
  const unpaired = permissions
    ? permissions.unknownRequestTimeCount + permissions.unknownDecisionTimeCount
    : 0;
  const toolLead = leadingUsageRows(tools, toolsExpanded);
  const answering = permissions ? readUsageAnsweringShares(permissions) : null;
  const wide = width !== undefined && width >= TWO_COLUMN_MIN_WIDTH_PX;
  return (
    <View style={styles.body} testID={`${props.testID}.loop`}>
      <View style={styles.metrics}>
        {permissions ? (
          <DurationFigure value={permissions.decisionLatencyMs} label={t('usage.board.howYouWork.agentsWaited')} testID={`${props.testID}.waited.detail`}>
          <HappierDataMetric
            theme={chartTheme}
            label={t('usage.board.howYouWork.agentsWaited')}
            testID={`${props.testID}.waited`}
            size="stat"
            showLabel
            value={
              permissions.decisionLatencyMs === null
                ? t('usage.board.howYouWork.notRecorded')
                : formatUsageDuration(permissions.decisionLatencyMs)
            }
            comparison={{
              value: String(paired),
              label: t('usage.board.howYouWork.answeredApprovals'),
              meaning: 'neutral',
            }}
          /></DurationFigure>
        ) : null}
        {permissions && permissions.decisionLatencyMs !== null && paired > 0 ? (
          <DurationFigure value={permissions.decisionLatencyMs / paired} label={t('usage.board.howYouWork.averageWait')} testID={`${props.testID}.average.detail`}>
          <HappierDataMetric
            theme={chartTheme}
            label={t('usage.board.howYouWork.averageWait')}
            testID={`${props.testID}.average`}
            size="stat"
            showLabel
            value={formatUsageDuration(permissions.decisionLatencyMs / paired)}
          /></DurationFigure>
        ) : null}
        {inputs ? (
          <HappierDataMetric
            theme={chartTheme}
            label={t('usage.board.howYouWork.steering')}
            testID={`${props.testID}.steering`}
            size="stat"
            showLabel
            value={inputs.steeringCount}
            comparison={{
              value: String(inputs.acceptedCount),
              label: t('usage.board.howYouWork.messagesAccepted'),
              meaning: 'neutral',
            }}
          />
        ) : null}
      </View>
      <View style={[styles.columns, wide ? styles.row : null]}>
        {tools.length > 0 ? (
          <View style={[styles.block, wide ? styles.half : null]}>
            <Text style={styles.label}>
              {t('usage.board.howYouWork.waitedFor')}
            </Text>
            <RankedRows
              theme={chartTheme}
              testID={`${props.testID}.tools`}
              label={t('usage.board.howYouWork.waitedFor')}
              basis={t('usage.board.howYouWork.waitTime')}
              rows={toolLead.rows}
              total={permissions?.decisionLatencyMs ?? null}
              valueFormatter={formatUsageDuration}
              rowDatums={toolLead.rows.map(row => durationDatum(row.value, row.label))}
              unknownLabel={t('usage.board.howYouWork.notRecorded')}
              size={wide ? 'full' : 'tile'}
            />
            <UsageShowAllRows
              label={`${t(`usage.widgets.${props.id}`)}: ${t('usage.board.howYouWork.waitedFor')}`}
              testID={`${props.testID}.tools.more`}
              total={tools.length}
              hidden={toolLead.hidden}
              expanded={toolsExpanded}
              onToggle={() => setToolsExpanded((value) => !value)}
            />
          </View>
        ) : null}
        {answering && answering.witnessed > 0 ? (
          <View style={[styles.block, wide ? styles.half : null]}>
            <Text style={styles.label}>
              {t('usage.board.howYouWork.whereYouAnswer')}
            </Text>
            <CompositionStrip
              theme={chartTheme}
              testID={`${props.testID}.answering`}
              label={t('usage.board.howYouWork.whereYouAnswer')}
              total={answering.witnessed}
              basis={t('usage.board.howYouWork.answers')}
              // The count says what it counts ("73 answered"), never a bare figure mid-row.
              valueFormatter={(count) =>
                t('usage.board.howYouWork.approvalCount', { count })
              }
              size={wide ? 'full' : 'tile'}
              segments={answering.shares.map((row, index) => ({
                id: row.client,
                label: t(CLIENT_LABEL_KEYS[row.client]),
                value: row.count,
                color: usageSeriesColor(theme, index * 2),
              }))}
            />
            {answering.unknown > 0 ? (
              <Text style={styles.note}>
                {t('usage.board.howYouWork.answersUnknownDevice', {
                  count: answering.unknown,
                })}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      {unpaired > 0 ? (
        <Text style={styles.note} testID={`${props.testID}.unpaired`}>
          {t('usage.board.howYouWork.unpairedRequests', { count: unpaired })}
        </Text>
      ) : null}
      <UsageCoverageLine
        testID={`${props.testID}.coverage`}
        slice={props.slice}
        sources={['how_you_work']}
        onRetry={props.model.refresh}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s20, minWidth: 0 },
  metrics: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: theme.space.s32,
    rowGap: theme.space.s12,
  },
  columns: { gap: theme.space.s24 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  block: { gap: theme.space.s8, minWidth: 0 },
  half: { flex: 1 },
  label: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.secondary,
  },
  note: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
}));
