import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { Animated, Easing, Platform, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg';

import { HAPPIER_COLLECTION_ROW_METRICS } from './CollectionRowContent.js';
import type { HappierCollectionRowNeedsYouHighlight } from './needsYouHighlight.js';

const GLINT_MS = 900;
const SHIMMER_MS = 3200;
/** The sweep crosses during the first 60% of a Shimmer cycle and rests for the rest (`happierNeedsYouShimmer`). */
const SHIMMER_TRAVEL_SHARE = 0.6;
const BAND_SHARE = 0.4;
const BAND_OPACITY = 0.2;
const ACCENT_WIDTH = 2;
/** A still frame has no motion to carry it, so the tile draws the band a little stronger to tell Glint/Shimmer from Dot. */
const STILL_BAND_OPACITY = 0.4;
/** Where a still sweep rests: across the middle of the title. */
const STILL_OFFSET_SHARE = 0.75;

const clipStyle: ViewStyle = {
  position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, overflow: 'hidden', borderRadius: HAPPIER_COLLECTION_ROW_METRICS.radius,
};
const bandStyle: ViewStyle = { position: 'absolute', top: 0, bottom: 0, left: 0, width: `${BAND_SHARE * 100}%`, opacity: BAND_OPACITY };

/** `#rrggbb` → the same hue at zero alpha, so the band's edges fade through its own colour, not through black. */
function clearOf(color: string): string {
  return /^#[0-9a-f]{6}$/iu.test(color) ? `${color}00` : 'transparent';
}

/** React Native Web passes these CSS properties through to the element. */
type WebSweepStyle = ViewStyle & Readonly<{
  backgroundImage?: string;
  animationName?: string;
  animationDuration?: string;
  animationIterationCount?: number | 'infinite';
  animationTimingFunction?: string;
  animationFillMode?: string;
}>;

function webBand(color: string): WebSweepStyle {
  return { backgroundImage: `linear-gradient(90deg, ${clearOf(color)}, ${color}, ${clearOf(color)})` };
}

function NativeBandPaint(props: Readonly<{ color: string }>): ReactElement {
  const id = useId();
  return (
    <Svg width="100%" height="100%" pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1={0} y1={0} x2={1} y2={0}>
          <Stop offset={0} stopColor={props.color} stopOpacity={0} />
          <Stop offset={0.5} stopColor={props.color} stopOpacity={1} />
          <Stop offset={1} stopColor={props.color} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

function NativeSweep(props: Readonly<{ kind: 'glint' | 'shimmer'; color: string; testID?: string }>): ReactElement {
  const [width, setWidth] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (width <= 0) return;
    progress.setValue(0);
    const travel = Animated.timing(progress, {
      toValue: 1,
      duration: props.kind === 'glint' ? GLINT_MS : SHIMMER_MS * SHIMMER_TRAVEL_SHARE,
      easing: props.kind === 'glint' ? Easing.bezier(0.2, 0, 0, 1) : Easing.linear,
      useNativeDriver: true,
    });
    const animation = props.kind === 'glint' ? travel
      : Animated.loop(Animated.sequence([travel, Animated.delay(SHIMMER_MS * (1 - SHIMMER_TRAVEL_SHARE))]));
    animation.start();
    return () => animation.stop();
  }, [progress, props.kind, width]);
  const band = width * BAND_SHARE;
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-band, width + band * 1.6] });
  return (
    <View pointerEvents="none" style={clipStyle} onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}>
      {width > 0 ? (
        <Animated.View testID={props.testID} style={[bandStyle, { transform: [{ translateX }] }]}>
          <NativeBandPaint color={props.color} />
        </Animated.View>
      ) : null}
    </View>
  );
}

function Sweep(props: Readonly<{ kind: 'glint' | 'shimmer'; color: string; still: boolean; testID?: string }>): ReactElement {
  const testID = props.testID ? `${props.testID}:${props.kind}` : undefined;
  if (props.still) {
    const place: ViewStyle = { left: `${STILL_OFFSET_SHARE * BAND_SHARE * 100}%`, opacity: STILL_BAND_OPACITY };
    return (
      <View pointerEvents="none" style={clipStyle}>
        {Platform.OS === 'web'
          ? <View testID={testID} style={[bandStyle, webBand(props.color), place]} />
          : <View testID={testID} style={[bandStyle, place]}><NativeBandPaint color={props.color} /></View>}
      </View>
    );
  }
  if (Platform.OS !== 'web') return <NativeSweep kind={props.kind} color={props.color} testID={testID} />;
  const animation: WebSweepStyle = {
    animationName: props.kind === 'glint' ? 'happierNeedsYouGlint' : 'happierNeedsYouShimmer',
    animationDuration: `${props.kind === 'glint' ? GLINT_MS : SHIMMER_MS}ms`,
    animationIterationCount: props.kind === 'glint' ? 1 : 'infinite',
    animationTimingFunction: props.kind === 'glint' ? 'cubic-bezier(0.2, 0, 0, 1)' : 'linear',
    animationFillMode: 'both',
  };
  return (
    <View pointerEvents="none" style={clipStyle}>
      <View testID={testID} style={[bandStyle, webBand(props.color), animation]} />
    </View>
  );
}

/**
 * A row's leading highlight layer, drawn under its content: Accent's 2 px bar, or the Glint / Shimmer sweep, a soft
 * band crossing the row behind the title. Transform-only motion: a CSS animation on the web, the native driver
 * elsewhere; no React render per frame. `still` holds the sweep mid-row, for a picker that shows the real treatment
 * without motion. The host's attention colour is the caller's.
 */
export function HappierCollectionRowNeedsYouLayer(props: Readonly<{
  leading: HappierCollectionRowNeedsYouHighlight['leading'];
  color: string;
  still?: boolean;
  testID?: string;
}>): ReactElement | null {
  if (props.leading === 'accent') {
    return <View testID={props.testID ? `${props.testID}:accent` : undefined} pointerEvents="none" style={{
      position: 'absolute', left: 1, top: '25%', bottom: '25%', width: ACCENT_WIDTH, borderRadius: ACCENT_WIDTH / 2, backgroundColor: props.color,
    }} />;
  }
  if (props.leading === 'glint' || props.leading === 'shimmer') {
    return <Sweep kind={props.leading} color={props.color} still={props.still === true} testID={props.testID} />;
  }
  return null;
}
