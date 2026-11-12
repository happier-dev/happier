import { useCallback, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { G, Text as SvgText } from 'react-native-svg';

import type { HappierUiTheme } from '../../../environment/types.js';
import { HappierPressable } from '../../interaction/Pressable.js';
import { useWidgetPresentation } from '../../../components/WidgetPresentation.js';
import type { HappierLayoutChangeEvent } from '../../portableTypes.js';
import { HappierText } from '../../text/Text.js';
import { HappierDataTable } from '../../data/DataRows.js';
import { mixHappierColorOverPaper, type HappierDataColumn, type HappierDataValue } from '../../data/dataModel.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from '../../data/dataText.js';

/**
 * Shared drawing helpers of the Usage chart bodies. Bodies are pure: the host supplies every label, the Agent
 * identities (name, colour, mark), the chart accent and the paper the chart sits on. Nothing here queries,
 * decrypts or decides what may be shown; a body draws exactly the model it is given.
 */

export { HappierDecorativeSvg as UsageDecorativeSvg } from '../../content/DecorativeSvg.js';

/** One Agent as the host knows it: catalogue name, identity colour and mark. */
export type UsageChartAgent = Readonly<{ id: string; name: string; shortName?: string; color: string; mark?: ReactNode }>;

/** The host's chart paint: the one Usage accent and the paper the body sits on (a card or a profile block). */
export type UsageChartPaint = Readonly<{ accent: string; paper: string; dark: boolean }>;

export type UsageChartBaseProps = Readonly<{
  theme: HappierUiTheme;
  paint: UsageChartPaint;
  /** The body's accessible name; the frame's title names it on screen. */
  label: string;
  /** A fixed drawing width (cold server render, share cards); absent, the body measures the width it is given. */
  width?: number;
  testID?: string;
}>;

/** A step from `color` toward the paper (the dataviz meter rule): 1 = the colour, 0 = the paper. */
export function usageChartMix(color: string, paper: string, amount: number): string {
  return mixHappierColorOverPaper(color, paper, amount) ?? color;
}

export type UsageChartInk = Readonly<{
  text: string; muted: string; secondary: string;
  /** A quiet track behind data (an empty lane, a dot not lit). */
  track: string;
  /** Gridlines and guides. */
  grid: string;
  /** A baseline under bars. */
  base: string;
  /** Neutral marks: unknown, not attributed, undated. */
  neutral: string;
}>;

export function resolveUsageChartInk(theme: HappierUiTheme, paint: UsageChartPaint): UsageChartInk {
  const text = theme.colors.text;
  return {
    text, muted: theme.colors.mutedText, secondary: theme.colors.secondaryText,
    track: usageChartMix(text, paint.paper, 0.08), grid: usageChartMix(text, paint.paper, 0.1),
    base: usageChartMix(text, paint.paper, 0.24), neutral: usageChartMix(text, paint.paper, 0.38),
  };
}

/**
 * The width the body was given; charts draw once it is known and hold their height until then. Inside a widget frame
 * the frame's measured body room is known from the first paint, so the chart draws there instead of painting nothing
 * and growing by its whole height one layout later (Agents at 390: Score −261 then +270); its own layout refines it.
 */
export function useUsageChartWidth(fixed?: number): readonly [number | null, (event: HappierLayoutChangeEvent) => void] {
  const [measured, setWidth] = useState<number | null>(null);
  const frameWidth = useWidgetPresentation()?.geometry?.width;
  const width = fixed ?? measured ?? (frameWidth !== undefined && frameWidth > 0 ? Math.floor(frameWidth) : null);
  const onLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const next = Math.floor(event.nativeEvent.layout.width);
    setWidth((previous) => (previous === next ? previous : next));
  }, []);
  return [width, onLayout];
}

/**
 * The drawing's own size, or — for a host-given width that cannot be measured (the cold server page) — a viewBox at
 * that width which fills the column and scales down with a narrower one, keeping its proportions.
 */
export function usageChartSvgSize(width: number, height: number, scaled: boolean) {
  return scaled
    ? { width: '100%', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet', style: { maxWidth: width, height: 'auto' as const } }
    : { width, height };
}

export const usageChartRound = (value: number) => Math.round(value * 10) / 10;

/** A smooth horizontal-tangent curve through points (the lab's ridgeline/river curve). */
export function usageSmoothPath(points: readonly (readonly [number, number])[]): string {
  const r = usageChartRound;
  return points.map((point, index) => {
    if (index === 0) return `M${r(point[0])},${r(point[1])}`;
    const previous = points[index - 1]!;
    const mid = (previous[0] + point[0]) / 2;
    return `C${r(mid)},${r(previous[1])} ${r(mid)},${r(point[1])} ${r(point[0])},${r(point[1])}`;
  }).join('');
}

export type UsageChartSvgLabel = Readonly<{
  x: number; y: number; text: string; anchor?: 'start' | 'middle' | 'end';
  tone?: 'muted' | 'secondary' | 'text' | 'strong' | 'onMark'; size?: 'caption' | 'body';
  /** Paper behind a label that sits over drawn marks. */
  halo?: string;
}>;

/** Axis and in-chart labels in the data caption role, so charts use the host's real face and size. */
export function useUsageChartSvgText(theme: HappierUiTheme) {
  const text = useHappierDataTextStyles(theme);
  const draw = (label: UsageChartSvgLabel, key?: string | number) => {
    const role = label.size === 'body' ? text.body : text.caption;
    const strong = label.tone === 'strong' || label.tone === 'onMark';
    const face = strong ? (label.size === 'body' ? text.strong : text.captionStrong) : role;
    const common = { x: label.x, y: label.y, textAnchor: label.anchor ?? 'start', fontSize: role.fontSize,
      fontFamily: face.fontFamily as string | undefined, fontWeight: (face.fontWeight as string | undefined) ?? (strong ? '600' : '400') } as const;
    // A label over drawn data sits on a paper halo (a stroked copy behind it), never on the marks.
    return <G key={key}>
      {label.halo ? <SvgText {...common} fill={label.halo} stroke={label.halo} strokeWidth={3} strokeLinejoin="round">{label.text}</SvgText> : null}
      <SvgText {...common} fill={label.tone === 'muted' || label.tone === undefined ? theme.colors.mutedText : label.tone === 'secondary' ? theme.colors.secondaryText : label.tone === 'onMark' ? theme.colors.onAccent : theme.colors.text}>{label.text}</SvgText>
    </G>;
  };
  return { styles: text, draw, fontSize: text.caption.fontSize ?? theme.typography.body.fontSize };
}

export type UsageChartSwatch =
  | Readonly<{ kind: 'dot' | 'ring' | 'speck' | 'hatch'; color: string }>
  | Readonly<{ kind: 'split'; colors: readonly [string, string] }>
  | Readonly<{ kind: 'line'; color: string; dashed?: boolean; dotted?: boolean }>
  | Readonly<{ kind: 'mark'; node: ReactNode }>;

export type UsageChartKeyItem = Readonly<{
  id: string; label: string;
  /** A count or figure said beside the label (tabular). */
  value?: string;
  swatch: UsageChartSwatch;
}>;

/** The legend says the rule: one row of swatch + label + count, wrapping on a phone. */
export function UsageChartKey(props: Readonly<{ theme: HappierUiTheme; items: readonly UsageChartKeyItem[]; note?: string; testID?: string }>) {
  const text = useHappierDataTextStyles(props.theme);
  return <View testID={props.testID} style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6, alignItems: 'center' }}>
    {props.items.map((item) => <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <UsageChartSwatchMark swatch={item.swatch} />
      <HappierText style={text.body}>{item.label}</HappierText>
      {item.value !== undefined ? <HappierText tabularNumbers style={text.strong}>{item.value}</HappierText> : null}
    </View>)}
    {props.note ? <HappierText style={text.caption}>{props.note}</HappierText> : null}
  </View>;
}

function UsageChartSwatchMark(props: Readonly<{ swatch: UsageChartSwatch }>) {
  const s = props.swatch;
  if (s.kind === 'mark') return <View>{s.node}</View>;
  if (s.kind === 'line') return <View style={{ width: 22, height: 0, borderTopWidth: 1.6, borderColor: s.color,
    borderStyle: s.dotted ? 'dotted' : s.dashed ? 'dashed' : 'solid' }} />;
  if (s.kind === 'split') return <View style={{ width: 8, height: 8, borderRadius: 4, overflow: 'hidden', flexDirection: 'row' }}>
    <View style={{ flex: 1, backgroundColor: s.colors[0] }} /><View style={{ flex: 1, backgroundColor: s.colors[1] }} />
  </View>;
  if (s.kind === 'ring') return <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.2, borderColor: s.color }} />;
  if (s.kind === 'speck') return <View style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: s.color, marginHorizontal: 2.5 }} />;
  if (s.kind === 'hatch') return <View style={{ width: 10, height: 8, borderRadius: 2, borderWidth: 1, borderColor: s.color, borderStyle: 'dashed' }} />;
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: s.color }} />;
}

/** The sentence under a chart that says how to read it. */
export function UsageChartCaption(props: Readonly<{ theme: HappierUiTheme; children: string; testID?: string }>) {
  const text = useHappierDataTextStyles(props.theme);
  return <HappierText testID={props.testID} style={text.caption}>{props.children}</HappierText>;
}

/** Localized wording of the exact-values disclosure, supplied by the host. */
export type UsageChartValuesLabels = Readonly<{ show: string; hide: string; unknownLabel?: string }>;
export type UsageChartValuesTable = Readonly<{
  columns: readonly HappierDataColumn[]; rows: readonly (readonly HappierDataValue[])[];
  rowLeads?: readonly (ReactNode | undefined)[];
}>;

/**
 * Every drawn chart keeps its exact figures one press away: keyboard and screen readers read the table, never
 * the shapes. The table holds every row the model has; nothing is sampled to fit.
 */
export function UsageChartValues(props: Readonly<{
  theme: HappierUiTheme; label: string; table: UsageChartValuesTable; labels: UsageChartValuesLabels; testID?: string;
}>) {
  const [open, setOpen] = useState(false);
  const text = useHappierDataTextStyles(props.theme);
  if (props.table.rows.length === 0) return null;
  return <View style={{ gap: HAPPIER_DATA_METRICS.blockGapPx }}>
    <HappierPressable testID={props.testID ? `${props.testID}-values-toggle` : undefined} expanded={open}
      accessibilityLabel={`${props.label} · ${open ? props.labels.hide : props.labels.show}`} onPress={() => setOpen((value) => !value)}
      style={{ alignSelf: 'flex-end' }}>
      <HappierText style={text.captionStrong}>{open ? props.labels.hide : props.labels.show}</HappierText>
    </HappierPressable>
    {open ? <HappierDataTable testID={props.testID ? `${props.testID}-values` : undefined} theme={props.theme}
      label={props.label} columns={props.table.columns} rows={props.table.rows} rowLeads={props.table.rowLeads} /> : null}
  </View>;
}

/** The body's column: chart, key, caption and values share one rhythm. */
export function UsageChartColumn(props: Readonly<{ children: ReactNode; testID?: string; onLayout?: (event: HappierLayoutChangeEvent) => void; minHeight?: number }>) {
  return <View testID={props.testID} onLayout={props.onLayout} style={{ gap: HAPPIER_DATA_METRICS.blockGapPx, minWidth: 0, minHeight: props.minHeight }}>
    {props.children}
  </View>;
}
