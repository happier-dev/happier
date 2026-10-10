import { View } from 'react-native';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierProgress, resolveHappierProgressPercentage } from '../content/Foundation.js';
import { HappierText } from '../text/Text.js';
import { formatHappierDataValue } from './dataModel.js';
import { useHappierDataTextStyles } from './dataText.js';
import type { HappierStyleProp } from '../portableTypes.js';

export type CapacityBarProps = Readonly<{
  theme: HappierUiTheme; label: string; value: number | null; capacity: number | null;
  basis?: string; evenPace?: number | null; projected?: number | null; color?: string;
  unknownLabel?: string; size?: 'inline' | 'tile' | 'full'; testID?: string;
  pattern?: 'solid' | 'hatched';
  /** Remaining capacity: solid projected remainder over the hatched current remainder. */
  projection?: 'marker' | 'remaining';
  /** A containing domain row can own the visible caption and accessibility wording. */
  showCaption?: boolean;
  height?: number; trackColor?: string; markerColor?: string; style?: HappierStyleProp;
}>;
export function CapacityBar(props: CapacityBarProps) {
  const text = useHappierDataTextStyles(props.theme);
  const known = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);
  const exact = (value: number | null | undefined) => known(value) ? [formatHappierDataValue(value, text.locale), props.basis].filter(Boolean).join(' ') : props.unknownLabel ?? 'Unknown';
  const description = [props.label, `${exact(props.value)} / ${exact(props.capacity)}`,
    ...(props.evenPace === undefined ? [] : [`Even pace: ${exact(props.evenPace)}`]),
    ...(props.projected === undefined ? [] : [`Projected: ${exact(props.projected)}`])].join(', ');
  const capacity = props.capacity;
  const hasScale = known(capacity) && capacity > 0;
  const height = props.height ?? (props.size === 'inline' ? 4 : 8);
  const remainder = props.projection === 'remaining' && known(props.projected) && known(props.value);
  return <View testID={props.testID} accessibilityLabel={description} style={[{ gap: props.theme.spacing.xsmall }, props.style]}>
    {props.showCaption === false ? null : <HappierText style={text.caption} tabularNumbers>{description}</HappierText>}
    {hasScale && known(props.value) ? <View>
      <HappierProgress theme={props.theme} semantics="none" label={description} value={props.value / capacity}
        fillColor={props.color} trackColor={props.trackColor} fillPattern={remainder ? 'hatched' : props.pattern} height={height} testID={props.testID ? `${props.testID}-meter` : undefined} />
      {remainder ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ position: 'absolute', left: 0, right: 0, top: 0 }}>
        <HappierProgress theme={props.theme} semantics="none" label={description} height={height} trackColor="transparent"
          fillColor={props.color} value={Math.min(props.projected!, props.value!) / capacity}
          fillTestID={props.testID ? `${props.testID}-projected-fill` : undefined} />
      </View> : null}
      {known(props.evenPace) ? <View testID={props.testID ? `${props.testID}-even-pace` : undefined} accessibilityElementsHidden importantForAccessibility="no" style={{ position: 'absolute',
        left: `${resolveHappierProgressPercentage(props.evenPace / capacity)}%`, top: -3, bottom: -3, width: 1, backgroundColor: props.markerColor ?? props.theme.colors.secondaryText }} /> : null}
      {!remainder && known(props.projected) ? <View accessibilityElementsHidden importantForAccessibility="no" style={{ position: 'absolute',
        left: `${resolveHappierProgressPercentage(props.projected / capacity)}%`, top: -3, bottom: -3, borderLeftWidth: 1,
        borderStyle: 'dotted', borderColor: props.color ?? props.theme.colors.accent }} /> : null}
    </View> : null}
  </View>;
}
