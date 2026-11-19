import { useThemeSurfaceBinding } from '../themeSurfaceBinding.js';
import { useCallback, useContext, type ReactNode, type Ref } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { HappierPageRowFieldLayoutContext } from '../layout/pageRowField.js';
import { HappierChevron } from '../collection/DisclosureChevron.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { useHappierHitArea } from '../interaction/hitArea.js';
import type { HappierHitReach } from '../../environment/interactiveTarget.js';
import { happierRaisedEdgeStyle, type HappierRaisedEdge } from '../layout/raisedEdge.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import { useHappierMaterialColorResolver } from '../layout/Surface.js';
import { resolveHappierTypeScale } from '../text/typeScale.js';

const SEARCH_FIELD_HIT_REACH: HappierHitReach = Object.freeze({ left: 0, right: 0 });
const SEARCH_FIELD_SURFACE_FRAME: HappierPortableStyle = Object.freeze({ maxWidth: '100%', minWidth: 0 });

/**
 * The compact rail/search well. It keeps its drawn height under every pointer; under a finger a tap just
 * above or below it still focuses the field, through the shared hit area (never a taller well).
 */
export const HAPPIER_SEARCH_FIELD_METRICS = Object.freeze({ heightPx: HAPPIER_PAGE_METRICS.controlHeightPx, iconInsetPx: 10, iconSizePx: 14, iconGapPx: 8, trailingInsetPx: 8 });

export function HappierSearchFieldBox(props: Readonly<{
  testID?: string;
  colors: Pick<HappierFieldBoxColors, 'borderColor' | 'backgroundColor' | 'edge'>;
  radius: number;
  /** A hit area the host asks for beyond the environment's finger target; it never grows the drawn well. */
  minimumTargetSize?: number;
  /**
   * How far the well's hit area may reach past it. By default it reaches up and down only: the controls
   * beside a search field own their own hit areas.
   */
  hitReach?: HappierHitReach;
  themeSurface?: import('@happier-dev/plugin-sdk/ui').SurfaceAddress;
  onFocusInput: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  style?: HappierStyleProp;
  /** A floating capsule can bind its material body without replacing this field's focus/hit owner. */
  renderSurface?: (input: Readonly<{ style: HappierStyleProp; children: ReactNode; themeSurface: import('@happier-dev/plugin-sdk/ui').SurfaceAddress }>) => ReactNode;
}>) {
  const surfaceBinding = useThemeSurfaceBinding(props.themeSurface ?? { surface: 'input', part: 'root' });
  const metrics = HAPPIER_SEARCH_FIELD_METRICS;
  const paintColor = useHappierMaterialColorResolver();
  const style = [{ flexDirection: 'row' as const, alignItems: 'center' as const, borderRadius: props.radius, paddingLeft: metrics.iconInsetPx, paddingRight: metrics.trailingInsetPx, paddingVertical: 0, minHeight: metrics.heightPx, backgroundColor: paintColor(props.colors.backgroundColor), borderColor: props.colors.borderColor, borderWidth: StyleSheet.hairlineWidth }, happierRaisedEdgeStyle(props.colors.edge), props.style, surfaceBinding.style];
  const children = <>
    {props.leading ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ marginRight: metrics.iconGapPx }}>{props.leading}</View> : null}
    {props.children}
    {props.trailing ?? null}
  </>;
  const pressableStyle = props.renderSurface ? SEARCH_FIELD_SURFACE_FRAME : style;
  const hitArea = useHappierHitArea({
    restingStyle: () => pressableStyle,
    hitTarget: props.minimumTargetSize,
    hitReach: props.hitReach ?? SEARCH_FIELD_HIT_REACH,
  });
  return <Pressable {...{ dataSet: props.renderSurface ? undefined : surfaceBinding.dataSet }} testID={props.testID ? `${props.testID}.field` : undefined} onPress={props.onFocusInput} accessible={false} focusable={false} tabIndex={-1}
    hitSlop={hitArea.hitSlop} onLayout={hitArea.onLayout} style={pressableStyle}>
    {hitArea.frame}
    {props.renderSurface ? props.renderSurface({ style, children, themeSurface: props.themeSurface ?? { surface: 'input', part: 'root' } }) : children}
  </Pressable>;
}

/**
 * The bordered field box of configuration pages: a page select's trigger and a
 * page text field share this one shape, so a row of fields reads as one set
 * whatever the control. Happier core's `fieldBox.ts` (text fields, the page
 * `DropdownMenu` trigger) and the plugin page-row `Select` read it here.
 */
/**
 * A field's value is the `label` role at regular weight (plan §4.1: field text is label): the box
 * already separates the value from its row title, so it needs no size step. The iOS-web 16px input
 * floor is the core `TextInput` owner's, applied over this.
 */
const FIELD_TEXT_ROLE = resolveHappierTypeScale('label', Platform.OS);

export const HAPPIER_FIELD_BOX_METRICS = Object.freeze({
  minHeightPx: HAPPIER_PAGE_METRICS.controlHeightPx,
  /** A control: the `md` step of the one radius base. */
  radiusPx: HAPPIER_RADIUS_V1.md,
  borderWidthPx: 1,
  paddingLeftPx: 12,
  paddingRightPx: 8,
  fontSizePx: FIELD_TEXT_ROLE.fontSize,
  lineHeightPx: FIELD_TEXT_ROLE.lineHeight,
  /** Narrowest width beside a label; stacked under the label a field spans the row instead. */
  inlineMinWidthPx: HAPPIER_PAGE_METRICS.fieldInlineMinWidthPx,
  /** A select trigger's box: wide enough for a short choice, never wider than a long one needs. */
  triggerMinWidthPx: 132,
  triggerMaxWidthPx: 280,
  /** Between the leading mark, the value and the trailing chevron. */
  triggerGapPx: 8,
  /** The chip density: a select that sits among a row's quiet facts (a role's engine) as a soft pill. */
  chipHeightPx: 28,
  chipPaddingLeftPx: 10,
  chipPaddingRightPx: 8,
  chipGapPx: 6,
});

/** The chip density's own shape: a pill with no border; the caller supplies a soft fill. */
const HAPPIER_FIELD_BOX_CHIP_SHAPE: HappierPortableStyle = Object.freeze({
  minHeight: HAPPIER_FIELD_BOX_METRICS.chipHeightPx,
  borderRadius: HAPPIER_FIELD_BOX_METRICS.chipHeightPx / 2,
  borderWidth: 0,
  paddingLeft: HAPPIER_FIELD_BOX_METRICS.chipPaddingLeftPx,
  paddingRight: HAPPIER_FIELD_BOX_METRICS.chipPaddingRightPx,
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
  /**
   * The value grows to fill its box and shrinks (cut with an ellipsis) when the box is full; its basis is
   * its own text, so a box sized to its content (`column`, `content`) is as wide as the value needs.
   */
  style: Readonly<{ flexGrow: 1; flexShrink: 1; flexBasis: 'auto'; color: string; fontSize: number; lineHeight: number }>;
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
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 'auto',
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
   * page-field width beside a label: at least that width, growing with a longer choice up to the
   * trigger's widest, so an ordinary option label is not cut. `row`: stacked under its label, the field spans the row.
   * `intrinsic`: toolbar choices omit the configuration-field width floor.
   */
  span?: 'content' | 'column' | 'row' | 'intrinsic';
  /**
   * `field` (default): the bordered configuration field. `chip`: a compact borderless pill that
   * sizes to its choice (never held to the field's width floor); pair it with a soft fill.
   */
  density?: 'field' | 'chip';
  /** The drawn box itself: what the field's choices hang from and match in width (the press target may be wider). */
  boxRef?: Ref<unknown>;
}>;

/**
 * A select's field-box trigger visual: the bordered box, an optional leading
 * mark, the value (or placeholder) and a trailing chevron. Not itself
 * pressable — the row or trigger around it owns the interaction and focus; that
 * trigger takes `HAPPIER_FOCUS_RING_DELEGATED_STYLE` when the box draws the ring.
 */
export function HappierFieldBoxTrigger({ colors, leading, children, trailing, span, density, boxRef }: HappierFieldBoxTriggerProps) {
  const paintColor = useHappierMaterialColorResolver();
  const rowLayout = useContext(HappierPageRowFieldLayoutContext);
  const chip = density === 'chip';
  const resolvedSpan = chip ? 'intrinsic' : span === 'column' && rowLayout
    ? rowLayout.stacked ? 'row' : rowLayout.maxWidthPx === null ? 'column' : 'content'
    : span;
  const maxWidthPx = span === 'column' || chip ? rowLayout?.maxWidthPx : null;
  // Beside a label the box is held to the row's room; a box that fills it is cutting its value.
  // React Native Web starts observing a view's size only when it mounts with an `onLayout`, and the
  // room is unknown on the first render, so every box in a field row observes from its first render
  // and the handler decides whether the room it was given is the one it filled.
  const onFieldSaturated = rowLayout?.onFieldSaturated;
  const observesSaturation = !chip && span === 'column' && onFieldSaturated !== undefined;
  const reportsSaturation = observesSaturation && !rowLayout?.stacked && typeof maxWidthPx === 'number';
  const handleLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    if (!reportsSaturation || typeof maxWidthPx !== 'number') return;
    if (event.nativeEvent.layout.width >= maxWidthPx - 0.5) onFieldSaturated?.(maxWidthPx);
  }, [maxWidthPx, onFieldSaturated, reportsSaturation]);
  return (
    <View
      ref={boxRef as Ref<View>}
      collapsable={false}
      {...(observesSaturation ? { onLayout: handleLayout } : {})}
      style={[chip ? HAPPIER_FIELD_BOX_CHIP_SHAPE : HAPPIER_FIELD_BOX_SHAPE, {
        flexDirection: 'row',
        alignItems: 'center',
        gap: chip ? HAPPIER_FIELD_BOX_METRICS.chipGapPx : HAPPIER_FIELD_BOX_METRICS.triggerGapPx,
        // A spanning field takes its row's width, whatever it is; a floor above that row would draw past it.
        minWidth: resolvedSpan === 'intrinsic' || resolvedSpan === 'row' ? 0 : HAPPIER_FIELD_BOX_METRICS.triggerMinWidthPx,
        ...(resolvedSpan === 'column' ? { minWidth: HAPPIER_FIELD_BOX_METRICS.inlineMinWidthPx } : {}),
        ...(resolvedSpan === 'row' ? { alignSelf: 'stretch' as const } : { maxWidth: maxWidthPx ?? HAPPIER_FIELD_BOX_METRICS.triggerMaxWidthPx }),
        borderColor: colors.borderColor,
        // A field is a control: it keeps its own fill on every plane, a popover's glass included (WF-ACCEPT-1119B 6).
        backgroundColor: paintColor(colors.backgroundColor, undefined, 'solidControl'),
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
  /** A field's refusal line beneath the box: the meta role. */
  errorFontSizePx: resolveHappierTypeScale('meta', Platform.OS).fontSize,
  errorLineHeightPx: resolveHappierTypeScale('meta', Platform.OS).lineHeight,
});

/**
 * How a text field presents. `field`: the bordered box of a row's control. `document`: long prose a
 * person reads and edits in place (a role's instructions, notes) as a soft filled card at reading
 * size, so it reads like the text it is rather than a form control.
 */
export type HappierFieldTextPresentation = 'field' | 'document';

/**
 * The input's own text box inside the field box: the field's text step with no
 * padding of its own (the box pads), a multiline field `lines` tall and
 * top-aligned, and a single-line field filling the box's drawn height, so a tap
 * anywhere in the box lands in the field without the box ever growing.
 */
export function resolveHappierFieldTextInputMetrics(input: Readonly<{
  multiline?: boolean;
  minLines?: number;
  /** @deprecated A finger's target never grows the drawn field; the input fills the box instead. Ignored. */
  nativeMinimumTargetSize?: number;
  presentation?: HappierFieldTextPresentation;
}>): Readonly<{
  fontSize: number;
  lineHeight: number;
  padding: 0;
  margin: 0;
  minHeight: number;
  textAlignVertical?: 'top';
}> {
  if (input.multiline && input.presentation === 'document') {
    const reading = resolveHappierTypeScale('reading', Platform.OS);
    return {
      fontSize: reading.fontSize,
      lineHeight: reading.lineHeight,
      padding: 0,
      margin: 0,
      minHeight: reading.lineHeight * (input.minLines ?? HAPPIER_FIELD_TEXT_METRICS.defaultMultilineLines),
      textAlignVertical: 'top',
    };
  }
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
    minHeight: HAPPIER_FIELD_BOX_METRICS.minHeightPx - 2 * HAPPIER_FIELD_BOX_METRICS.borderWidthPx,
  };
}

export type HappierFieldTextBoxProps = Readonly<{
  themeSurface?: import('@happier-dev/plugin-sdk/ui').SurfaceAddress;
  colors: Pick<HappierFieldBoxColors, 'borderColor' | 'backgroundColor' | 'edge'>;
  multiline?: boolean;
  /** The adapter's text input, styled with {@link resolveHappierFieldTextInputMetrics}. */
  children: ReactNode;
  /** The field's refusal, drawn by the adapter's text host (an alert), beneath the box. */
  error?: ReactNode;
  style?: HappierStyleProp;
  /** `document`: a soft filled card (the adapter supplies the fill and no border), card radius and roomy insets. */
  presentation?: HappierFieldTextPresentation;
  /**
   * A fixed mark the value continues (the `/` of a shortcut), drawn in the box before the text with no gap, so
   * `/` + `release-notes` reads as one `/release-notes`. The adapter decides whether assistive technology reads it.
   */
  leading?: ReactNode;
  /** Inline field actions or a mark at the end of the box (paste, reveal, a key hint), after the text. */
  trailing?: ReactNode;
}>;

/** The trailing slot's own breath inside the box's right padding, so an inline action never touches the edge. */
const HAPPIER_FIELD_TRAILING_INSET_PX = 4;

/** The document card's shape: the card step of the radius base and the field's own inset on both sides. */
const HAPPIER_FIELD_DOCUMENT_SHAPE: HappierPortableStyle = Object.freeze({
  borderRadius: HAPPIER_RADIUS_V1.xl,
  paddingRight: HAPPIER_FIELD_BOX_METRICS.paddingLeftPx,
  paddingVertical: HAPPIER_PAGE_METRICS.sectionHeaderGapPx,
});

/**
 * A configuration page's text field: the bordered field box a page select also
 * uses, placed as a row's control, with its refusal beneath it. Happier core's
 * `FieldTextInput` and the public `TextField presentation="field"` render it.
 */
export function HappierFieldTextBox(props: HappierFieldTextBoxProps) {
  const surfaceBinding = useThemeSurfaceBinding(props.themeSurface ?? { surface: 'input', part: 'root' });
  const paintColor = useHappierMaterialColorResolver();
  return (
    <View
      style={[
        {
          // Caller sizing belongs to this frame; registered styles can be opaque.
          minWidth: 0,
          maxWidth: '100%',
          flexShrink: 1,
        },
        props.style,
      ]}
    >
      <View
        style={{
          // Prefer the shared column intrinsically, but fill the caller's bounded frame.
          width: HAPPIER_FIELD_BOX_METRICS.inlineMinWidthPx,
          minWidth: '100%',
          maxWidth: '100%',
          gap: HAPPIER_FIELD_TEXT_METRICS.errorGapPx,
        }}
      >
        <View
          {...{ dataSet: surfaceBinding.dataSet }}
          style={[
            HAPPIER_FIELD_BOX_SHAPE,
            // A field is a control: it keeps its own fill on every plane, a popover's glass included (WF-ACCEPT-1119B 6).
            { justifyContent: 'center', borderColor: props.colors.borderColor, backgroundColor: paintColor(props.colors.backgroundColor, undefined, 'solidControl') },
            happierRaisedEdgeStyle(props.colors.edge),
            props.multiline ? { paddingVertical: HAPPIER_FIELD_TEXT_METRICS.multilinePaddingVerticalPx } : null,
            props.presentation === 'document' ? HAPPIER_FIELD_DOCUMENT_SHAPE : null,
            surfaceBinding.style,
          ]}
        >
          {props.leading == null && props.trailing == null ? props.children : (
            // One row: the mark, the value taking the room left, then the trailing actions.
            <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
              {props.leading == null ? null : <View style={{ flexShrink: 0 }}>{props.leading}</View>}
              <View style={{ flex: 1, minWidth: 0 }}>{props.children}</View>
              {props.trailing == null ? null : (
                <View style={{ flexShrink: 0, paddingRight: HAPPIER_FIELD_TRAILING_INSET_PX }}>{props.trailing}</View>
              )}
            </View>
          )}
        </View>
        {props.error ?? null}
      </View>
    </View>
  );
}
