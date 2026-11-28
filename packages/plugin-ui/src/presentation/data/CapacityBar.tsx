import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import type { HappierUiTheme } from '../../environment/types.js';
import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import { HappierProgress, resolveHappierProgressPercentage } from '../content/Foundation.js';
import { HappierDataHatch } from '../content/Hatch.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import { HappierText } from '../text/Text.js';
import { formatHappierDataValue } from './dataModel.js';
import { HAPPIER_DATA_MOTION, useHappierDataTextStyles } from './dataText.js';
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
  /**
   * A live meter: each new value eases from the drawn width (retargeting mid-way) and a colour change cross-fades,
   * instead of jumping. Reduced motion (the environment's, or this override) jumps.
   */
  animated?: boolean;
  reducedMotion?: boolean;
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
  // One picture its label describes, as a stack of shares is (`HappierProgress` image semantics): a name on a role-less
  // box is never read (axe aria-prohibited-attr).
  return <View testID={props.testID} role="img" aria-label={description} accessibilityLabel={description}
    style={[{ gap: props.theme.spacing.xsmall }, props.style]}>
    {props.showCaption === false ? null : <HappierText style={text.caption} tabularNumbers>{description}</HappierText>}
    {hasScale && known(props.value) ? <View>
      <HappierProgress theme={props.theme} semantics="none" label={description} value={props.value / capacity}
        fillColor={props.color} trackColor={props.trackColor} fillPattern={remainder ? 'hatched' : props.pattern} height={height} testID={props.testID ? `${props.testID}-meter` : undefined}
        fillTestID={props.testID ? `${props.testID}-meter-fill` : undefined}
        renderFill={props.animated ? (percentage) => <EasedMeterFill theme={props.theme} percentage={percentage} color={props.color ?? props.theme.colors.accent}
          hatched={(remainder ? 'hatched' : props.pattern) === 'hatched'} reducedMotion={props.reducedMotion} testID={props.testID ? `${props.testID}-meter-fill` : undefined} /> : undefined} />
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

/** The live fill: width eases to each new value from where it is drawn; colour cross-fades on a tone change. */
function EasedMeterFill(props: Readonly<{ theme: HappierUiTheme; percentage: number; color: string; hatched: boolean; reducedMotion?: boolean; testID?: string }>) {
  const accessibility = useOptionalHappierUiAccessibility();
  const reducedMotion = accessibility?.reducedMotion === true || (props.reducedMotion ?? accessibility?.reducedMotion ?? true);
  const width = useRef(new Animated.Value(props.percentage)).current;
  const tone = useRef(new Animated.Value(1)).current;
  // Keep the committed pair; a new colour fades from the last target.
  const pair = useRef({ from: props.color, to: props.color });
  const from = pair.current.to !== props.color ? pair.current.to : pair.current.from;
  const to = props.color;
  useEffect(() => {
    if (reducedMotion) { width.stopAnimation(); width.setValue(props.percentage); return; }
    // Animated continues from the current drawn value, so a new sample retargets mid-way.
    const [x1, y1, x2, y2] = HAPPIER_DATA_MOTION.valueBezier;
    const animation = Animated.timing(width, { toValue: props.percentage, duration: HAPPIER_DATA_MOTION.valueMs,
      easing: Easing.bezier(x1, y1, x2, y2), useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [props.percentage, reducedMotion, width]);
  useLayoutEffect(() => {
    if (pair.current.to !== to) {
      pair.current = { from, to };
      // Reset before paint, never while render can notify another component.
      tone.stopAnimation();
      tone.setValue(reducedMotion ? 1 : 0);
    }
    if (reducedMotion) { tone.stopAnimation(); tone.setValue(1); return; }
    const [x1, y1, x2, y2] = HAPPIER_MOTION_V1.standardBezier;
    const animation = Animated.timing(tone, { toValue: 1, duration: HAPPIER_MOTION_V1.slowMs, easing: Easing.bezier(x1, y1, x2, y2), useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [from, to, reducedMotion, tone]);
  const style = useMemo(() => ({
    height: '100%' as const,
    borderRadius: props.theme.radii.pill,
    overflow: 'hidden' as const,
    width: width.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'], extrapolate: 'clamp' }),
    backgroundColor: from === to ? to : tone.interpolate({ inputRange: [0, 1], outputRange: [from, to] }),
  }), [from, props.theme.radii.pill, to, tone, width]);
  return (
    <Animated.View testID={props.testID} style={style}>
      {props.hatched ? <HappierDataHatch theme={props.theme} /> : null}
    </Animated.View>
  );
}

