import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { HappierUiTheme } from '../../../environment/types.js';
import { HAPPIER_SPACE_STEPS as space } from '../../../environment/spacing.js';
import { HappierText } from '../../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../../text/typeRole.js';
import { useOptionalHappierUiTypography } from '../../../environment/context.js';
import { ChartDatum, useChartInteractionAvailable, type HappierChartDatum } from '../../data/ChartDatum.js';

export type UsageRecapHighlight = Readonly<{ id: string; label: string; value: string; detail: string; testID?: string;
  /** Optional admitted precision absent from the visible highlight. */
  datum?: HappierChartDatum }>;
export type UsageRecapModel = Readonly<{ highlights: readonly UsageRecapHighlight[] }>;
export function UsageRecapBody(props: Readonly<{ theme: HappierUiTheme; model: UsageRecapModel; testID?: string;
  highlightBorderColor?: string; highlightSpacing?: Readonly<{ s2: number; s4: number; s10: number; s12: number; s24: number }>;
  state?: ReactNode; autopsy?: ReactNode; actions?: ReactNode; notice?: ReactNode }>) {
  const typography = useOptionalHappierUiTypography();
  const interactive = useChartInteractionAvailable();
  const body = resolveHappierTypeRoleStyle('body', props.theme, typography);
  const heading = resolveHappierTypeRoleStyle('heading', props.theme, typography);
  const spacing = props.highlightSpacing ?? space;
  return <View style={{ gap: space.s16 }}>
    {props.state}
    {props.model.highlights.length > 0 ? <View testID={props.testID ? `${props.testID}.highlights` : undefined}
      style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.s24, rowGap: spacing.s4 }} accessibilityRole="list">
      {props.model.highlights.map(highlight => {
        const value = <HappierText style={{ ...heading, color: props.theme.colors.text }} tabularNumbers numberOfLines={1}>{highlight.value}</HappierText>;
        return <View key={highlight.id} testID={highlight.testID}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s10, flexGrow: 1, flexBasis: 200, minWidth: 0,
          paddingTop: spacing.s12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: props.highlightBorderColor ?? props.theme.colors.divider }}
        accessible={!(interactive && highlight.datum)} accessibilityRole="text" accessibilityLabel={`${highlight.label}: ${highlight.value}, ${highlight.detail}`}>
        <View style={{ flex: 1, minWidth: 0, gap: spacing.s2 }}>
          <HappierText style={{ ...body, color: props.theme.colors.secondaryText }} numberOfLines={1}>{highlight.label}</HappierText>
          {highlight.datum ? <ChartDatum datum={highlight.datum} testID={highlight.testID ? `${highlight.testID}.detail` : undefined}>{value}</ChartDatum> : value}
          <HappierText style={{ ...body, color: props.theme.colors.mutedText }} numberOfLines={2}>{highlight.detail}</HappierText>
        </View>
      </View>;
      })}
    </View> : null}
    {props.autopsy}
    {props.actions ? <View testID={props.testID ? `${props.testID}.actions` : undefined}
      style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.s8 }}>{props.actions}</View> : null}
    {props.notice}
  </View>;
}
