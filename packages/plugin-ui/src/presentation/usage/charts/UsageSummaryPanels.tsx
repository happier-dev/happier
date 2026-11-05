import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../../environment/types.js';
import { useOptionalHappierUiTypography } from '../../../environment/context.js';
import { HAPPIER_SPACE_STEPS } from '../../../environment/spacing.js';
import { HappierBadge } from '../../content/Foundation.js';
import { HappierDataRows } from '../../data/DataRows.js';
import { HappierDataMetric, type HappierDataMetricProps } from '../../data/Metric.js';
import { ChartDatum, type HappierChartDatum } from '../../data/ChartDatum.js';
import type { HappierStyleProp } from '../../portableTypes.js';
import { HappierText } from '../../text/Text.js';
import { HAPPIER_PUBLIC_PROFILE_OWNER_METRICS } from '../../layout/pageMetrics.js';
import { resolveHappierTypeRoleStyle } from '../../text/typeRole.js';

/** Already admitted and localized facts. No query, cost selection or disclosure policy lives here. */
export type UsageSummaryMetric = Omit<HappierDataMetricProps, 'theme' | 'size' | 'showLabel' | 'testID'> & Readonly<{
  id: string;
  /** An owner-only control at the figure's top end (a profile's per-figure eye); private Usage passes none. */
  accessory?: ReactNode;
  /** The owner sees a figure visitors don't, in place and quieted, so consent changes never move the layout. */
  quieted?: boolean;
  /** Exact domain units when the numeric model uses a different display unit (for example hours). */
  datum?: HappierChartDatum;
}>;
export type UsagePeriodSummaryBodyProps = Readonly<{
  theme: HappierUiTheme;
  hero?: UsageSummaryMetric;
  stats: readonly UsageSummaryMetric[];
  subline?: string;
  sublineStyle?: HappierStyleProp;
  /** Host density projection; unhosted presentations use the shared comfortable steps. */
  spacing?: Readonly<{ body: number; statColumns: number; statRows: number }>;
  /** Host-owned freshness/retry control; the body owns the surrounding presentation. */
  coverage?: ReactNode;
  testID?: string;
}>;

/** Every summary stat's column basis (equal, growing columns); a host's reading placeholder uses the same one. */
export const USAGE_SUMMARY_STAT_BASIS_PX = 120;

/** The original period summary, shared by private Usage and independently admitted public facts. */
export function UsagePeriodSummaryBody(props: UsagePeriodSummaryBodyProps) {
  const typography = useOptionalHappierUiTypography();
  return <View style={{ gap: props.spacing?.body ?? HAPPIER_SPACE_STEPS.s20 }} testID={props.testID ? `${props.testID}.summary` : undefined}>
    {props.hero ? <View style={{ gap: 2 }}>
      <SummaryFigure metric={props.hero} testID={props.testID ? `${props.testID}.hero.detail` : undefined}>
        <HappierDataMetric {...metricProps(props.hero)} testID={props.testID ? `${props.testID}.hero` : undefined} theme={props.theme} size="hero" />
      </SummaryFigure>
      {!props.hero.comparison && props.subline !== undefined
        ? <HappierText style={props.sublineStyle ?? { ...resolveHappierTypeRoleStyle('micro', props.theme, typography), color: props.theme.colors.mutedText }}>{props.subline}</HappierText> : null}
    </View> : null}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: props.spacing?.statColumns ?? HAPPIER_SPACE_STEPS.s24,
      rowGap: props.spacing?.statRows ?? HAPPIER_SPACE_STEPS.s16 }}>
      {/* Equal columns: six stats share one row on a wide page and pair evenly on a phone, rows aligned, no value cut. */}
      {props.stats.map((stat) => <View key={stat.id} style={{ flexGrow: 1, flexBasis: USAGE_SUMMARY_STAT_BASIS_PX, minWidth: 0 }}>
        <SummaryFigure metric={stat} testID={props.testID ? `${props.testID}.${stat.id}.detail` : undefined}><HappierDataMetric {...metricProps(stat)} theme={props.theme} size="stat" showLabel /></SummaryFigure>
      </View>)}
    </View>
    {props.coverage}
  </View>;
}

function metricProps({ id: _id, accessory: _accessory, quieted: _quieted, datum: _datum, ...metric }: UsageSummaryMetric) {
  return metric;
}

/** A figure and its owner-only control, which sits at the figure's top end without moving its value. */
function SummaryFigure(props: Readonly<{ metric: UsageSummaryMetric; children: ReactNode; testID?: string }>) {
  const quieted = props.metric.quieted ? { opacity: HAPPIER_PUBLIC_PROFILE_OWNER_METRICS.quietedOpacity } : null;
  const figure = props.metric.datum ? <ChartDatum datum={props.metric.datum} testID={props.testID}>{props.children}</ChartDatum> : props.children;
  if (!props.metric.accessory) return quieted ? <View style={quieted}>{figure}</View> : <>{figure}</>;
  return <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: HAPPIER_SPACE_STEPS.s4 }}>
    <View style={[{ flexGrow: 1, flexShrink: 1, minWidth: 0 }, quieted]}>{figure}</View>
    {props.metric.accessory}
  </View>;
}

export type UsageFootprintLabels = Readonly<{
  title: string; reason: string; noEstimate: string; accounted: string; tokensUnit: string;
  proxy: string; proxyDetail: string; methodTitle: string; methodBody: string;
}>;
export type UsageFootprintBodyProps = Readonly<{
  theme: HappierUiTheme;
  labels: UsageFootprintLabels;
  /** Absent when token disclosure is not admitted; footprint consent alone does not disclose it. */
  accountedTokens?: string;
  /** Admitted precision belongs to the figure, never its surrounding method or coverage controls. */
  accountedTokensDatum?: HappierChartDatum;
  badgeColor?: string;
  badgeBackgroundColor?: string;
  textStyles?: Readonly<{ title?: HappierStyleProp; reason?: HappierStyleProp; methodTitle?: HappierStyleProp }>;
  /** Host density projection for the heading row and tightly grouped copy. */
  spacing?: Readonly<{ head: number; detail: number }>;
  coverage?: ReactNode;
  testID?: string;
}>;

/** An estimate is unavailable until the canonical method owner has a sufficient basis. */
export function UsageFootprintBody(props: UsageFootprintBodyProps) {
  const labels = props.labels;
  const typography = useOptionalHappierUiTypography();
  const reasonStyle = props.textStyles?.reason ?? { ...resolveHappierTypeRoleStyle('body', props.theme, typography), color: props.theme.colors.secondaryText };
  const accounted = props.accountedTokens === undefined ? null : <HappierDataMetric theme={props.theme}
    testID={props.testID ? `${props.testID}.tokens` : undefined} label={labels.accounted} value={props.accountedTokens} unit={labels.tokensUnit}
    comparison={{ value: labels.proxy, label: labels.proxyDetail, meaning: 'neutral' }} />;
  return <View style={{ gap: 18, minWidth: 0 }} testID={props.testID ? `${props.testID}.footprint` : undefined}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: props.spacing?.head ?? HAPPIER_SPACE_STEPS.s12 }}>
      <View style={{ flex: 1, minWidth: 0, gap: props.spacing?.detail ?? HAPPIER_SPACE_STEPS.s4 }}>
        <HappierText style={props.textStyles?.title ?? { ...resolveHappierTypeRoleStyle('heading', props.theme, typography), color: props.theme.colors.text }} testID={props.testID ? `${props.testID}.status` : undefined}>
          {labels.title}
        </HappierText>
        <HappierText style={reasonStyle}>{labels.reason}</HappierText>
      </View>
      <HappierBadge color={props.badgeColor ?? props.theme.colors.secondaryText} backgroundColor={props.badgeBackgroundColor ?? props.theme.colors.control}>
        <HappierText style={{ ...resolveHappierTypeRoleStyle('micro', props.theme, typography), color: props.badgeColor ?? props.theme.colors.secondaryText }}>
          {labels.noEstimate}
        </HappierText>
      </HappierBadge>
    </View>
    {accounted && props.accountedTokensDatum ? <ChartDatum datum={props.accountedTokensDatum}
      testID={props.testID ? `${props.testID}.tokens.detail` : undefined}>{accounted}</ChartDatum> : accounted}
    <View style={{ gap: props.spacing?.detail ?? HAPPIER_SPACE_STEPS.s4 }}>
      <HappierText style={props.textStyles?.methodTitle ?? { ...resolveHappierTypeRoleStyle('body', props.theme, typography, 'semiBold'), color: props.theme.colors.text }}>{labels.methodTitle}</HappierText>
      <HappierText style={reasonStyle}>{labels.methodBody}</HappierText>
    </View>
    {props.coverage}
  </View>;
}

export type UsageSourceCoverageRow = Readonly<{ title: string; label: string; count?: number }>;
export type UsageSourceCoverageBodyProps = Readonly<{
  theme: HappierUiTheme; label: string; columns: readonly [string, string]; rows: readonly UsageSourceCoverageRow[];
  /** Empty state and private controls remain host-owned; populated source/status markup is shared. */
  empty?: ReactNode; showAll?: ReactNode; detail?: ReactNode; testID?: string;
}>;

export function UsageSourceCoverageBody(props: UsageSourceCoverageBodyProps) {
  return <View testID={props.testID ? `${props.testID}.facts` : undefined}>
    {props.rows.length ? <>
      <HappierDataRows theme={props.theme} testID={props.testID ? `${props.testID}.rows` : undefined} label={props.label}
        columns={props.columns.map(label => ({ label }))}
        rows={props.rows.map(row => [(row.count ?? 1) > 1 ? `${row.title} ×${row.count}` : row.title, row.label])} />
      {props.showAll}
    </> : props.empty}
    {props.detail}
  </View>;
}
