import { createContext, useContext, useId, type ReactNode } from 'react';
import { Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { ClipPath, Defs, Path, Svg } from 'react-native-svg';

/** Caller-owned wording and exact values; the chart owns only the mark's geometry. */
export type HappierChartDatum = Readonly<{
  label: string;
  value: string;
  subtitle?: string;
  color?: string;
  /** Repeated marks of one datum keep one keyboard/screen-reader target. */
  keyboard?: boolean;
}>;

export type HappierChartDatumInteraction = Readonly<{
  onHoverChange: (hovered: boolean) => void;
  onFocusChange: (focused: boolean) => void;
  onPress: () => void;
}>;
export type HappierChartDatumTrigger = (interaction: HappierChartDatumInteraction) => ReactNode;
export type HappierChartDatumRenderer = (datum: HappierChartDatum, visual: ReactNode, testID?: string, renderTrigger?: HappierChartDatumTrigger) => ReactNode;

const ChartDatumRenderer = createContext<HappierChartDatumRenderer | null>(null);
const IDLE_INTERACTION: HappierChartDatumInteraction = { onHoverChange: () => {}, onFocusChange: () => {}, onPress: () => {} };

/** Consumers with an existing accessibility owner keep their static semantics until interactions are bound. */
export function useChartInteractionAvailable() {
  return useContext(ChartDatumRenderer) !== null;
}

/** Static images retain their name; interactive drawings expose each datum rather than hiding it in an image group. */
export function ChartDrawing(props: Readonly<{ children: ReactNode; accessibilityLabel: string; style?: StyleProp<ViewStyle>; testID?: string }>) {
  const render = useContext(ChartDatumRenderer);
  return <View testID={props.testID} style={props.style} accessible={!render} accessibilityRole={render ? undefined : 'image'} accessibilityLabel={props.accessibilityLabel}>
    {props.children}
  </View>;
}

/** Binds the host's existing popover owner once for all chart and inline data targets below it. */
export function ChartInteractionProvider(props: Readonly<{ renderDatum: HappierChartDatumRenderer; children: ReactNode }>) {
  return <ChartDatumRenderer.Provider value={props.renderDatum}>{props.children}</ChartDatumRenderer.Provider>;
}

/** An inline datum keeps its visual composition; the host supplies interaction and the popover. */
export function ChartDatum(props: Readonly<{ datum: HappierChartDatum; children: ReactNode; testID?: string; renderTrigger?: HappierChartDatumTrigger }>) {
  const render = useContext(ChartDatumRenderer);
  const renderTrigger = props.renderTrigger;
  return <>{render ? render(props.datum, <ChartDatumRenderer.Provider value={null}>{props.children}</ChartDatumRenderer.Provider>, props.testID,
    renderTrigger ? interaction => <ChartDatumRenderer.Provider value={null}>{renderTrigger(interaction)}</ChartDatumRenderer.Provider> : undefined)
    : props.renderTrigger ? props.renderTrigger(IDLE_INTERACTION) : props.children}</>;
}

type ChartMarkBounds = Readonly<{ x: number; y: number; width: number; height: number }>;
type ChartCoordinateSpace = Readonly<{ width: number; height: number }>;

function chartMarkPosition(bounds: ChartMarkBounds, space?: ChartCoordinateSpace) {
  return space ? {
    left: `${bounds.x / space.width * 100}%` as const,
    top: `${bounds.y / space.height * 100}%` as const,
    width: `${bounds.width / space.width * 100}%` as const,
    height: `${bounds.height / space.height * 100}%` as const,
  } : { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height };
}

/** A transparent target in the drawing's coordinates, beside (never inside) its SVG. */
export function ChartMark(props: Readonly<{
  datum: HappierChartDatum;
  bounds: ChartMarkBounds;
  /** SVG viewBox coordinates when the drawing scales to its container. */
  coordinateSpace?: ChartCoordinateSpace;
  testID?: string;
}>) {
  const render = useContext(ChartDatumRenderer);
  if (!render) return null;
  return <View style={{ position: 'absolute', ...chartMarkPosition(props.bounds, props.coordinateSpace) }}>
    <ChartDatum datum={props.datum} testID={props.testID}><View style={{ width: '100%', aspectRatio: props.bounds.width / props.bounds.height }} /></ChartDatum>
  </View>;
}

/** One interaction for a complete curve, using its existing SVG geometry rather than a rectangular hit area. */
export function ChartPathMark(props: Readonly<{
  datum: HappierChartDatum;
  d: string;
  transform?: string;
  clipPathD?: string;
  bounds: ChartMarkBounds;
  strokeWidth: number;
  hitMode?: 'stroke' | 'fill';
  /** Native keyboard/screen-reader focus stays at a representative point on the curve. */
  focusBounds?: ChartMarkBounds;
  coordinateSpace?: ChartCoordinateSpace;
  testID?: string;
}>) {
  const render = useContext(ChartDatumRenderer);
  const clipId = `chart-datum-${useId().replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  if (!render) return null;
  const { bounds } = props;
  const focus = props.focusBounds ?? bounds;
  return <View pointerEvents="box-none" style={{ position: 'absolute', ...chartMarkPosition(bounds, props.coordinateSpace) }}>
    <ChartDatum datum={props.datum} testID={props.testID} renderTrigger={interaction => <View pointerEvents="box-none" style={{ width: '100%', aspectRatio: bounds.width / bounds.height }}>
      <Svg width="100%" height="100%" viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} pointerEvents="box-none"
        style={Platform.OS === 'web' ? { pointerEvents: 'none', overflow: 'hidden' } : { overflow: 'hidden' }}>
        {props.clipPathD ? <Defs><ClipPath id={clipId}><Path d={props.clipPathD} /></ClipPath></Defs> : null}
        {/* RNW's createElement turns role=button into HTML button even for RN-SVG Path; a DOM path retains SVG geometry. */}
        {Platform.OS === 'web' ? <path d={props.d} transform={props.transform} clipPath={props.clipPathD ? `url(#${clipId})` : undefined} fill={props.hitMode === 'fill' ? 'transparent' : 'none'} stroke={props.hitMode === 'fill' ? 'none' : 'transparent'} strokeWidth={props.strokeWidth} style={{ pointerEvents: props.hitMode ?? 'stroke' }}
          data-testid={props.testID} role="button" tabIndex={props.datum.keyboard === false ? -1 : 0} aria-label={`${props.datum.label}: ${props.datum.value}`} aria-hidden={props.datum.keyboard === false ? true : undefined}
          onMouseEnter={() => interaction.onHoverChange(true)} onMouseLeave={() => interaction.onHoverChange(false)}
          onFocus={() => interaction.onFocusChange(true)} onBlur={() => interaction.onFocusChange(false)} onClick={interaction.onPress}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); interaction.onPress(); } }} />
          : <Path d={props.d} transform={props.transform} clipPath={props.clipPathD ? `url(#${clipId})` : undefined} fill={props.hitMode === 'fill' ? 'transparent' : 'none'} stroke={props.hitMode === 'fill' ? 'none' : 'transparent'} strokeWidth={props.strokeWidth} accessible={false} onPress={interaction.onPress} testID={props.testID ? `${props.testID}.path` : undefined} />}
      </Svg>
      {Platform.OS !== 'web' && props.datum.keyboard !== false ? <Pressable pointerEvents="none" testID={props.testID} accessibilityRole="button" accessibilityLabel={`${props.datum.label}: ${props.datum.value}`}
        accessible focusable onFocus={() => interaction.onFocusChange(true)} onBlur={() => interaction.onFocusChange(false)} onPress={interaction.onPress}
        onHoverIn={() => interaction.onHoverChange(true)} onHoverOut={() => interaction.onHoverChange(false)}
        style={{ position: 'absolute', left: focus.x - bounds.x, top: focus.y - bounds.y, width: focus.width, height: focus.height }} /> : null}
    </View>}>{null}</ChartDatum>
  </View>;
}
