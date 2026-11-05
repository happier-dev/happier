import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierProgress } from '../content/Foundation.js';
import { HappierText } from '../text/Text.js';
import { formatHappierDataShare, formatHappierDataValue } from './dataModel.js';
import { useHappierDataTextStyles } from './dataText.js';
import { Heatmap } from './Heatmap.js';
import { HappierDataHatch } from '../content/Hatch.js';
import type { HappierPortableStyle } from '../portableTypes.js';

/** `pattern: 'hatched'` marks a part that is set aside (e.g. collected to clear) in its own colour's hatch. */
export type CompositionSegment = Readonly<{ id: string; label: string; value: number | null; color?: string; pattern?: 'solid' | 'hatched';
  /** The part's identity mark (an agent's glyph), drawn before its name in the legend. */
  mark?: ReactNode }>;
export type CompositionStripProps = Readonly<{
  theme: HappierUiTheme; label: string; total: number | null; segments: readonly CompositionSegment[];
  basis?: string; unknownLabel?: string; size?: 'inline' | 'tile' | 'full'; testID?: string;
  /** Reuse the exact legend when another public chart owns the picture; `bar` when the host owns the legend. */
  variant?: 'strip' | 'waffle' | 'legend' | 'bar';
  minimumVisibleFraction?: number; minimumFillWidth?: number; segmentGap?: number;
  /** Visible ink only; accessibility retains the unabridged source amount. */
  valueFormatter?: (value: number) => string;
  shareFormatter?: (share: number) => string;
  /** `share`: each value is already its share of `total`, so the legend reads it once as a share, never a raw fraction. */
  valueKind?: 'amount' | 'share';
  renderSegment?: (segment: CompositionSegment, visual: ReactNode, share: number | null) => ReactNode;
  renderBarSegment?: (segment: CompositionSegment, visual: ReactNode, share: number | null) => ReactNode;
  /** Compact static/export legend; amounts remain exact in accessibility even when hidden in ink. */
  appearance?: Readonly<{ legend: 'compact'; height?: number; textStyle?: HappierPortableStyle; allowFontScaling?: boolean;
    /** What each compact legend entry shows beside its name: its share (default) or its amount (`valueFormatter`). */
    figure?: 'share' | 'value';
    /**
     * `flow` (default): entries run on and wrap. `key`: one entry per line, its figure right-aligned in one tabular
     * column, the key a ring or bar stands beside (a Storage widget, lab `rw` ST).
     */
    layout?: 'flow' | 'key' }>;
}>;
/** A supplied whole, never an inferred sum: overlapping categories remain exact rows. */
export function CompositionStrip(props: CompositionStripProps) {
  const text = useHappierDataTextStyles(props.theme);
  const total = props.total;
  const shares = props.segments.map(segment => total !== null && Number.isFinite(total) && total > 0 && segment.value !== null && Number.isFinite(segment.value) && segment.value >= 0 ? segment.value / total : null);
  const disjoint = shares.every(share => share !== null) && shares.reduce<number>((sum, share) => sum + (share ?? 0), 0) <= 1 + Number.EPSILON;
  const totalLabel = total === null || !Number.isFinite(total) ? props.unknownLabel ?? 'Unknown' : [formatHappierDataValue(total, text.locale), props.basis].filter(Boolean).join(' ');
  // Tessellation resolution, not a data limit: every category remains in the exact legend.
  const rowCount = props.size === 'inline' ? 3 : props.size === 'tile' ? 5 : 10;
  const columnCount = 10;
  const rows = Array.from({ length: rowCount }, (_, index) => ({ id: String(index), label: '' }));
  const columns = Array.from({ length: columnCount }, (_, index) => ({ id: String(index), label: '' }));
  const cellSegments = new Map<string, number>();
  const cells = props.variant === 'waffle' && disjoint ? rows.flatMap((row, rowIndex) => columns.map((column, columnIndex) => {
    const fraction = (rowIndex * columnCount + columnIndex + 0.5) / (rowCount * columnCount);
    let cumulative = 0;
    const segmentIndex = shares.findIndex(share => { cumulative += share ?? 0; return fraction < cumulative; });
    const segment = props.segments[segmentIndex];
    if (segment) cellSegments.set(`${row.id}:${column.id}`, segmentIndex);
    return { id: `${row.id}:${column.id}`, row: row.id, column: column.id, label: '', value: 1,
      color: segment ? segment.color ?? props.theme.colors.accent : props.theme.colors.surface };
  })) : [];
  return <View testID={props.testID} accessibilityLabel={`${props.label}: ${totalLabel}`} style={{ gap: props.theme.spacing.small }}>
    {props.variant === 'legend' ? null : props.variant === 'waffle' && disjoint ? <Heatmap theme={props.theme} label={props.label} rows={rows} columns={columns}
      cells={cells} decorative={!props.renderBarSegment} showReadout={false} size={props.size} testID={props.testID ? `${props.testID}-grid` : undefined}
      renderCell={props.renderBarSegment ? (cell, visual) => {
        const index = cellSegments.get(cell.id);
        return index === undefined ? visual : props.renderBarSegment!(props.segments[index]!, visual, shares[index] ?? null);
      } : undefined} />
    : disjoint ? <HappierProgress theme={props.theme} label={props.label} semantics="none" height={props.appearance?.height ?? 12}
      minimumVisibleFraction={props.minimumVisibleFraction} minimumFillWidth={props.minimumFillWidth} segmentGap={props.segmentGap}
      renderSegment={(_segment, solid, index) => {
        const segment = props.segments[index]!;
        // A hatched part is the hatch inside a hairline of its colour (the same mark as a hatched meter fill
        // and the legend swatch), so the part keeps its edge against the track and reads as "set aside".
        const visual = segment.pattern === 'hatched' ? <View style={{ height: '100%', overflow: 'hidden', borderWidth: 1,
          borderColor: segment.color ?? props.theme.colors.accent, borderRadius: props.theme.radii.small }}>
          <HappierDataHatch theme={props.theme} color={segment.color ?? props.theme.colors.accent} />
        </View> : solid;
        return props.renderBarSegment ? props.renderBarSegment(segment, visual, shares[index] ?? null) : visual;
      }}
      segments={props.segments.map((segment, index) => ({ value: shares[index] ?? 0,
        color: segment.pattern === 'hatched' ? 'transparent' : segment.color ?? props.theme.colors.accent }))} /> : null}
    {props.variant === 'bar' ? null : <View role="list" style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: props.theme.spacing.small,
      columnGap: props.appearance ? props.theme.spacing.small : undefined }}>
      {props.segments.map((segment, index) => {
        const share = shares[index] ?? null;
        const exact = segment.value === null || !Number.isFinite(segment.value) ? props.unknownLabel ?? 'Unknown' : formatHappierDataValue(segment.value, text.locale);
        const spokenShare = share === null ? undefined : formatHappierDataShare(share, text.locale);
        const spoken = props.valueKind === 'share' ? [segment.label, spokenShare ?? exact] : [segment.label, exact, props.basis, spokenShare];
        const swatchColor = segment.color ?? props.theme.colors.accent;
        const swatch = segment.pattern === 'hatched' ? <View style={{ width: 8, height: 8, borderRadius: props.theme.radii.small, overflow: 'hidden', borderWidth: 1,
          borderColor: swatchColor }}><HappierDataHatch theme={props.theme} color={swatchColor} /></View>
          : <View style={{ width: 8, height: 8, borderRadius: props.theme.radii.small, backgroundColor: swatchColor }} />;
        const mark = segment.mark ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{segment.mark}</View> : null;
        const label = segment.label ? <HappierText allowFontScaling={props.appearance?.allowFontScaling} style={{ ...text.caption, ...props.appearance?.textStyle, flexShrink: 1 }}>{segment.label}</HappierText> : null;
        const figure = props.appearance?.figure === 'value' ? segment.value === null || !Number.isFinite(segment.value) ? null
            : <HappierText allowFontScaling={props.appearance.allowFontScaling} style={{ ...text.captionStrong, ...props.appearance.textStyle }} tabularNumbers>
              {props.valueFormatter?.(segment.value) ?? exact}
            </HappierText>
          : share === null ? null : props.appearance ? <HappierText allowFontScaling={props.appearance.allowFontScaling}
            style={{ ...text.captionStrong, ...props.appearance.textStyle }} tabularNumbers>
            {props.shareFormatter?.(share) ?? formatHappierDataShare(share, text.locale)}
          </HappierText> : <View style={{ borderRadius: props.theme.radii.small, paddingHorizontal: props.theme.spacing.xsmall,
            backgroundColor: props.theme.colors.control }}><HappierText style={{ ...text.captionStrong, color: segment.color ?? props.theme.colors.accent }} tabularNumbers>
            {props.shareFormatter?.(share) ?? formatHappierDataShare(share, text.locale)}
          </HappierText></View>;
        // A compact legend sits in narrow hosts (a rail, a small widget): name and figure are one text group beside the swatch, so when they do not fit one line the figure
        // drops under the name (flush with its left edge) and the swatch stays on the first line instead of the entry clipping.
        const lineHeight = Math.max(props.appearance?.textStyle?.lineHeight ?? text.caption.lineHeight ?? props.theme.typography.caption.lineHeight, text.captionStrong.lineHeight ?? 0);
        const keyed = props.appearance?.layout === 'key';
        const visual = keyed ? <View role="listitem" accessible accessibilityLabel={spoken.filter(Boolean).join(', ')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: props.theme.spacing.xsmall }}>
          <View style={{ height: lineHeight, justifyContent: 'center' }}>{swatch}</View>
          {mark}
          <View style={{ flex: 1, minWidth: 0 }}>{label}</View>
          {figure}
        </View> : props.appearance ? <View role="listitem" accessible accessibilityLabel={spoken.filter(Boolean).join(', ')}
          style={{ flexDirection: 'row', alignItems: mark ? 'center' : 'flex-start', gap: props.theme.spacing.xsmall }}>
          <View style={{ height: lineHeight, justifyContent: 'center' }}>{swatch}</View>
          {mark}
          <View style={{ flexShrink: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: props.theme.spacing.xsmall }}>{label}{figure}</View>
        </View> : <View role="listitem" accessible accessibilityLabel={spoken.filter(Boolean).join(', ')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: props.theme.spacing.xsmall }}>
          {swatch}
          {mark}
          {label}
          {figure}
          <HappierText style={{ ...text.caption, marginLeft: 'auto' }} tabularNumbers>{segment.value !== null && Number.isFinite(segment.value) ? props.valueFormatter?.(segment.value) ?? exact : exact}</HappierText>
        </View>;
        return <View key={segment.id} style={keyed ? { width: '100%' } : props.appearance ? { maxWidth: '100%' } : { width: props.size === 'inline' ? '100%' : '50%', paddingRight: props.theme.spacing.small }}>
          {props.renderSegment?.(segment, visual, share) ?? visual}
        </View>;
      })}
    </View>}
  </View>;
}
