import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import { HappierChevron } from '../collection/DisclosureChevron.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { happierRaisedEdgeStyle, type HappierRaisedEdge } from '../layout/raisedEdge.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';

/** The compact rail/search well; phones take the platform target supplied by the adapter. */
export const HAPPIER_SEARCH_FIELD_METRICS = Object.freeze({ heightPx: 32, iconInsetPx: 10, iconSizePx: 14, iconGapPx: 8, trailingInsetPx: 8 });

export function HappierSearchFieldBox(props: Readonly<{
  testID?: string;
  colors: Pick<HappierFieldBoxColors, 'borderColor' | 'backgroundColor' | 'edge'>;
  radius: number;
  minimumTargetSize?: number;
  onFocusInput: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  style?: HappierStyleProp;
}>) {
  const metrics = HAPPIER_SEARCH_FIELD_METRICS;
  return <Pressable testID={props.testID ? `${props.testID}.field` : undefined} onPress={props.onFocusInput} accessible={false} focusable={false} tabIndex={-1} style={[{ flexDirection: 'row', alignItems: 'center', borderRadius: props.radius, paddingLeft: metrics.iconInsetPx, paddingRight: metrics.trailingInsetPx, paddingVertical: 0, minHeight: Math.max(metrics.heightPx, props.minimumTargetSize ?? 0), backgroundColor: props.colors.backgroundColor, borderColor: props.colors.borderColor, borderWidth: StyleSheet.hairlineWidth }, happierRaisedEdgeStyle(props.colors.edge), props.style]}>
    {props.leading ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ marginRight: metrics.iconGapPx }}>{props.leading}</View> : null}
    {props.children}
    {props.trailing ?? null}
  </Pressable>;
}

/**
 * The bordered field box of configuration pages: a page select's trigger and a
 * page text field share this one shape, so a row of fields reads as one set
 * whatever the control. Happier core's `fieldBox.ts` (text fields, the page
 * `DropdownMenu` trigger) and the plugin page-row `Select` read it here.
 */
export const HAPPIER_FIELD_BOX_METRICS = Object.freeze({
  minHeightPx: 32,
  /** A control: the `md` step of the one radius base. */
  radiusPx: HAPPIER_RADIUS_V1.md,
  borderWidthPx: 1,
  paddingLeftPx: 12,
  paddingRightPx: 8,
  fontSizePx: 13.5,
  lineHeightPx: 18,
  /** Narrowest width beside a label; stacked under the label a field spans the row instead. */
  inlineMinWidthPx: 240,
  /** A select trigger's box: wide enough for a short choice, never wider than a long one needs. */
  triggerMinWidthPx: 132,
  triggerMaxWidthPx: 280,
  /** Between the leading mark, the value and the trailing chevron. */
  triggerGapPx: 8,
});

export type HappierFieldBoxColors = Readonly<{
  borderColor: string;
  backgroundColor: string;
  valueColor: string;
  placeholderColor: string;
  /**
   * The box's raised edge (`resolveHappierRaisedEdge` over the host's raised control-border colour);
   * absent or `null` draws it flat, as an invalid field does.
   */
  edge?: HappierRaisedEdge | null;
  /**
   * The keyboard focus ring's colour while a select trigger's box carries it; absent or `null` draws
   * none. Never set for a text field: its caret is its focus cue.
   */
  focusRing?: string | null;
}>;

/** The value text a select trigger shows, and how it is drawn. */
export type HappierFieldBoxLabel = Readonly<{
  text: string;
  /** True when no choice is made and the box asks for one. */
  placeholder: boolean;
  style: Readonly<{ flex: 1; color: string; fontSize: number; lineHeight: number }>;
}>;

/**
 * An empty field says it is waiting for a choice ("Choose…") rather than
 * showing a blank box. Each adapter draws the returned text with its own text
 * host, which keeps its typography scale owner.
 */
export function resolveHappierFieldBoxLabel(input: Readonly<{
  value: string | null | undefined;
  placeholder: string;
  colors: Pick<HappierFieldBoxColors, 'valueColor' | 'placeholderColor'>;
}>): HappierFieldBoxLabel {
  const chosen = typeof input.value === 'string' && input.value.length > 0 ? input.value : null;
  return {
    text: chosen ?? input.placeholder,
    placeholder: chosen === null,
    style: {
      flex: 1,
      color: chosen === null ? input.colors.placeholderColor : input.colors.valueColor,
      fontSize: HAPPIER_FIELD_BOX_METRICS.fontSizePx,
      lineHeight: HAPPIER_FIELD_BOX_METRICS.lineHeightPx,
    },
  };
}

/** The field box's own shape; colours come from the caller. */
export const HAPPIER_FIELD_BOX_SHAPE: HappierPortableStyle = Object.freeze({
  minHeight: HAPPIER_FIELD_BOX_METRICS.minHeightPx,
  borderRadius: HAPPIER_FIELD_BOX_METRICS.radiusPx,
  borderWidth: HAPPIER_FIELD_BOX_METRICS.borderWidthPx,
  paddingLeft: HAPPIER_FIELD_BOX_METRICS.paddingLeftPx,
  paddingRight: HAPPIER_FIELD_BOX_METRICS.paddingRightPx,
});

export type HappierFieldBoxTriggerProps = Readonly<{
  colors: Pick<HappierFieldBoxColors, 'borderColor' | 'backgroundColor' | 'edge' | 'focusRing'>;
  /** A mark before the value (a selected agent's brand mark). */
  leading?: ReactNode;
  /** The value text, drawn by the adapter's text host from {@link resolveHappierFieldBoxLabel}. */
  children: ReactNode;
  /** The adapter's chevron (it owns the icon pack). */
  trailing?: ReactNode;
  /**
   * `content` (default): sized to its choice, within the trigger bounds. `column`: the shared
   * page-field width beside a label. `row`: stacked under its label, the field spans the row.
   * `intrinsic`: toolbar choices omit the configuration-field width floor.
   */
  span?: 'content' | 'column' | 'row' | 'intrinsic';
}>;

/**
 * A select's field-box trigger visual: the bordered box, an optional leading
 * mark, the value (or placeholder) and a trailing chevron. Not itself
 * pressable — the row or trigger around it owns the interaction and focus; that
 * trigger takes `HAPPIER_FOCUS_RING_DELEGATED_STYLE` when the box draws the ring.
 */
export function HappierFieldBoxTrigger({ colors, leading, children, trailing, span }: HappierFieldBoxTriggerProps) {
  return (
    <View
      style={[HAPPIER_FIELD_BOX_SHAPE, {
        flexDirection: 'row',
        alignItems: 'center',
        gap: HAPPIER_FIELD_BOX_METRICS.triggerGapPx,
        minWidth: span === 'intrinsic' ? 0 : HAPPIER_FIELD_BOX_METRICS.triggerMinWidthPx,
        ...(span === 'column' ? { width: HAPPIER_FIELD_BOX_METRICS.inlineMinWidthPx } : {}),
        ...(span === 'row' ? { alignSelf: 'stretch' as const } : { maxWidth: HAPPIER_FIELD_BOX_METRICS.triggerMaxWidthPx }),
        borderColor: colors.borderColor,
        backgroundColor: colors.backgroundColor,
      }, happierRaisedEdgeStyle(colors.edge), colors.focusRing ? happierFocusRingStyle({ visible: true, color: colors.focusRing }) : null]}
    >
      {leading ?? null}
      {children}
      {trailing ?? null}
    </View>
  );
}

/**
 * A field box's trailing chevron for adapters without an icon pack of their own (a plugin surface's icon
 * vocabulary has no caret): the shared drawn chevron, pointing down when closed and up when open.
 */
export function HappierFieldBoxChevron({ open, color, size = 16 }: Readonly<{
  open: boolean;
  color: string;
  size?: number;
}>) {
  return (
    <View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      {/* The shared caret at four fifths of the field's icon box, the lab chip caret's size. */}
      <HappierChevron direction={open ? 'up' : 'down'} color={color} size={Math.round(size * 0.8)} />
    </View>
  );
}

/**
 * A page text field's measures around the shared field-box shape: a multiline
 * field's vertical padding and default height in lines, the gap to its refusal
 * and the refusal's text step.
 */
export const HAPPIER_FIELD_TEXT_METRICS = Object.freeze({
  multilinePaddingVerticalPx: 7,
  defaultMultilineLines: 3,
  errorGapPx: 4,
  errorFontSizePx: 12,
  errorLineHeightPx: 16,
});

/**
 * The input's own text box inside the field box: the field's text step with no
 * padding of its own (the box pads), at least one line tall, a multiline field
 * `lines` tall and top-aligned, and — on a touch platform — the native target
 * floor, so a tap anywhere in the box lands in the field.
 */
export function resolveHappierFieldTextInputMetrics(input: Readonly<{
  multiline?: boolean;
  minLines?: number;
  nativeMinimumTargetSize?: number;
}>): Readonly<{
  fontSize: number;
  lineHeight: number;
  padding: 0;
  margin: 0;
  minHeight: number;
  textAlignVertical?: 'top';
}> {
  const line = HAPPIER_FIELD_BOX_METRICS.lineHeightPx;
  if (input.multiline) {
    return {
      fontSize: HAPPIER_FIELD_BOX_METRICS.fontSizePx,
      lineHeight: line,
      padding: 0,
      margin: 0,
      minHeight: line * (input.minLines ?? HAPPIER_FIELD_TEXT_METRICS.defaultMultilineLines),
      textAlignVertical: 'top',
    };
  }
  return {
    fontSize: HAPPIER_FIELD_BOX_METRICS.fontSizePx,
    lineHeight: line,
    padding: 0,
    margin: 0,
    minHeight: Math.max(line, input.nativeMinimumTargetSize ?? 0),
  };
}

export type HappierFieldTextBoxProps = Readonly<{
  colors: Pick<HappierFieldBoxColors, 'borderColor' | 'backgroundColor' | 'edge'>;
  multiline?: boolean;
  /** The adapter's text input, styled with {@link resolveHappierFieldTextInputMetrics}. */
  children: ReactNode;
  /** The field's refusal, drawn by the adapter's text host (an alert), beneath the box. */
  error?: ReactNode;
  style?: HappierStyleProp;
}>;

/**
 * A configuration page's text field: the bordered field box a page select also
 * uses, placed as a row's control, with its refusal beneath it. Happier core's
 * `FieldTextInput` and the public `TextField presentation="field"` render it.
 */
export function HappierFieldTextBox(props: HappierFieldTextBoxProps) {
  return (
    <View
      style={[
        {
          // Prefer the field column in an intrinsic inline slot, but span a bounded stacked slot
          // even when it is narrower than that column. A hard numeric minimum defeats shrinking.
          width: HAPPIER_FIELD_BOX_METRICS.inlineMinWidthPx,
          minWidth: '100%',
          maxWidth: '100%',
          flexShrink: 1,
          gap: HAPPIER_FIELD_TEXT_METRICS.errorGapPx,
        },
        props.style,
      ]}
    >
      <View
        style={[
          HAPPIER_FIELD_BOX_SHAPE,
          { justifyContent: 'center', borderColor: props.colors.borderColor, backgroundColor: props.colors.backgroundColor },
          happierRaisedEdgeStyle(props.colors.edge),
          props.multiline ? { paddingVertical: HAPPIER_FIELD_TEXT_METRICS.multilinePaddingVerticalPx } : null,
        ]}
      >
        {props.children}
      </View>
      {props.error ?? null}
    </View>
  );
}
