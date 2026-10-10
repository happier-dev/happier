import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierProgress } from '../content/Foundation.js';
import { HappierText } from '../text/Text.js';
import { formatHappierDataShare, formatHappierDataValue } from './dataModel.js';
import { useHappierDataTextStyles } from './dataText.js';
import { Heatmap } from './Heatmap.js';
import type { HappierPortableStyle } from '../portableTypes.js';

export type CompositionSegment = Readonly<{ id: string; label: string; value: number | null; color?: string }>;
export type CompositionStripProps = Readonly<{
  theme: HappierUiTheme; label: string; total: number | null; segments: readonly CompositionSegment[];
  basis?: string; unknownLabel?: string; size?: 'inline' | 'tile' | 'full'; testID?: string;
  /** Reuse the exact legend when another public chart owns the picture. */
  variant?: 'strip' | 'waffle' | 'legend';
  minimumVisibleFraction?: number; minimumFillWidth?: number; segmentGap?: number;
  /** Visible ink only; accessibility retains the unabridged source amount. */
  valueFormatter?: (value: number) => string;
  shareFormatter?: (share: number) => string;
  renderSegment?: (segment: CompositionSegment, visual: ReactNode, share: number | null) => ReactNode;
  renderBarSegment?: (segment: CompositionSegment, visual: ReactNode, share: number | null) => ReactNode;
  /** Compact static/export legend; amounts remain exact in accessibility even when hidden in ink. */
  appearance?: Readonly<{ legend: 'compact'; height?: number; textStyle?: HappierPortableStyle; allowFontScaling?: boolean }>;
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
  const cells = props.variant === 'waffle' && disjoint ? rows.flatMap((row, rowIndex) => columns.map((column, columnIndex) => {
    const fraction = (rowIndex * columnCount + columnIndex + 0.5) / (rowCount * columnCount);
    let cumulative = 0;
    const segmentIndex = shares.findIndex(share => { cumulative += share ?? 0; return fraction < cumulative; });
    const segment = props.segments[segmentIndex];
    return { id: `${row.id}:${column.id}`, row: row.id, column: column.id, label: '', value: 1,
      color: segment ? segment.color ?? props.theme.colors.accent : props.theme.colors.surface };
  })) : [];
  return <View testID={props.testID} accessibilityLabel={`${props.label}: ${totalLabel}`} style={{ gap: props.theme.spacing.small }}>
    {props.variant === 'legend' ? null : props.variant === 'waffle' && disjoint ? <Heatmap theme={props.theme} label={props.label} rows={rows} columns={columns}
      cells={cells} decorative size={props.size} testID={props.testID ? `${props.testID}-grid` : undefined} />
    : disjoint ? <HappierProgress theme={props.theme} label={props.label} semantics="none" height={props.appearance?.height ?? 12}
      minimumVisibleFraction={props.minimumVisibleFraction} minimumFillWidth={props.minimumFillWidth} segmentGap={props.segmentGap}
      renderSegment={props.renderBarSegment ? (_segment, visual, index) => props.renderBarSegment!(props.segments[index]!, visual, shares[index] ?? null) : undefined}
      segments={props.segments.map((segment, index) => ({ value: shares[index] ?? 0, color: segment.color ?? props.theme.colors.accent }))} /> : null}
    <View role="list" style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: props.theme.spacing.small,
      columnGap: props.appearance ? props.theme.spacing.small : undefined }}>
      {props.segments.map((segment, index) => {
        const share = shares[index] ?? null;
        const exact = segment.value === null || !Number.isFinite(segment.value) ? props.unknownLabel ?? 'Unknown' : formatHappierDataValue(segment.value, text.locale);
        const visual = <View role="listitem" accessible accessibilityLabel={[segment.label, exact, props.basis, share === null ? undefined : formatHappierDataShare(share, text.locale)].filter(Boolean).join(', ')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: props.theme.spacing.xsmall }}>
          <View style={{ width: 8, height: 8, borderRadius: props.theme.radii.small, backgroundColor: segment.color ?? props.theme.colors.accent }} />
          {segment.label ? <HappierText allowFontScaling={props.appearance?.allowFontScaling} style={{ ...text.caption, ...props.appearance?.textStyle, flexShrink: 1 }}>{segment.label}</HappierText> : null}
          {share === null ? null : props.appearance ? <HappierText allowFontScaling={props.appearance.allowFontScaling}
            style={{ ...text.captionStrong, ...props.appearance.textStyle }} tabularNumbers>
            {props.shareFormatter?.(share) ?? formatHappierDataShare(share, text.locale)}
          </HappierText> : <View style={{ borderRadius: props.theme.radii.small, paddingHorizontal: props.theme.spacing.xsmall,
            backgroundColor: props.theme.colors.control }}><HappierText style={{ ...text.captionStrong, color: segment.color ?? props.theme.colors.accent }} tabularNumbers>
            {props.shareFormatter?.(share) ?? formatHappierDataShare(share, text.locale)}
          </HappierText></View>}
          {props.appearance ? null : <HappierText style={{ ...text.caption, marginLeft: 'auto' }} tabularNumbers>{segment.value !== null && Number.isFinite(segment.value) ? props.valueFormatter?.(segment.value) ?? exact : exact}</HappierText>}
        </View>;
        return <View key={segment.id} style={props.appearance ? undefined : { width: props.size === 'inline' ? '100%' : '50%', paddingRight: props.theme.spacing.small }}>
          {props.renderSegment?.(segment, visual, share) ?? visual}
        </View>;
      })}
    </View>
  </View>;
}
