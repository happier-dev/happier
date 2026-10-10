import { useRef, type ReactNode } from 'react';
import { I18nManager, View } from 'react-native';

import { useOptionalHappierUiLocalization } from '../../environment/context.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HAPPIER_RADIUS_V1, happierInnerRadius } from '../../environment/radius.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import { resolveHappierTabKeySelection } from '../navigation/Tabs.js';
import type { HappierFocusable, HappierPortableStyle } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { useHappierMaterialColorResolver } from '../layout/Surface.js';

/**
 * The segmented control's geometry and label type, shared by Happier core's
 * `SegmentedTabBar` and the plugin segmented `Select`, so a two-to-four-way
 * choice has one shape wherever it is drawn.
 *
 * These are padding-driven visible heights: a segment never carries a
 * `minHeight`, because a minimum sized for a touch target silently becomes the
 * drawn box. `labelSlotPx` is the label's nominal optical slot (Inter's line
 * box at these sizes), used only to reason about a press frame; scaled text
 * grows the segment past it.
 *
 * `segmentMinWidthPx` is not the platform touch target: segments are flush
 * siblings in one track, so a 44/48 floor multiplies across them. A dense
 * pointer layout meets WCAG 2.2 SC 2.5.8 (24 CSS px) instead.
 */
const SEGMENTED_TRACK_PADDING_PX = 2;

export const HAPPIER_SEGMENTED_METRICS = Object.freeze({
  /** The track's inset: the gap around the segments and the thumb's inset. */
  trackPaddingPx: SEGMENTED_TRACK_PADDING_PX,
  /** A control (`md`); the compact track one step smaller (`sm`). Segments sit concentric inside it. */
  trackRadiusPx: Object.freeze({ default: HAPPIER_RADIUS_V1.md, compact: HAPPIER_RADIUS_V1.sm }),
  segmentRadiusPx: Object.freeze({
    default: happierInnerRadius(HAPPIER_RADIUS_V1.md, SEGMENTED_TRACK_PADDING_PX),
    compact: happierInnerRadius(HAPPIER_RADIUS_V1.sm, SEGMENTED_TRACK_PADDING_PX),
  }),
  segmentPaddingVerticalPx: Object.freeze({ default: 7, compact: 4 }),
  /** A content-sized segment's side padding (a segment hugging its label). */
  segmentPaddingHorizontalPx: 12,
  labelSlotPx: Object.freeze({ default: 14, compact: 12 }),
  labelFontSizePx: Object.freeze({ default: 12, compact: 10 }),
  labelActiveFontWeight: '600' as const,
  segmentMinWidthPx: 24,
  /** One unavailable segment, or a whole unavailable control. */
  disabledOpacity: 0.5,
  /** Separate list-filter pills share the tab interaction owner, without a segmented track. */
  pills: Object.freeze({ gapPx: 8, radiusPx: 999, paddingVerticalPx: 4, paddingHorizontalPx: 8, labelFontSizePx: 13, labelSlotPx: 18 }),
  /**
   * A destination's page tabs (lab `p-overview` header): no track, a glyph beside each label, the
   * chosen tab on the ink selection fill. Controls' radius step; the label on the pill type step.
   */
  plain: Object.freeze({ gapPx: 2, radiusPx: HAPPIER_RADIUS_V1.md, paddingVerticalPx: 6, paddingHorizontalPx: 11, labelFontSizePx: 13, labelSlotPx: 18, iconGapPx: 7 }),
});

export type HappierSegmentedSize = 'default' | 'compact';

export type HappierSegmentedChoiceColors = Readonly<{
  track: string;
  /** The chosen segment's surface. */
  thumb: string;
  /** The low elevation the chosen segment stands on (the host's control lift); absent, it sits flat. */
  thumbLift?: HappierPortableStyle;
  label: string;
  activeLabel: string;
  focusRing: string;
}>;

export type HappierSegmentedChoiceSegment = Readonly<{
  key: string;
  label: string;
  selected: boolean;
  disabled: boolean;
  accessibilityLabel?: string;
  testID?: string;
  leading?: ReactNode;
}>;

export type HappierSegmentedChoiceProps = Readonly<{
  /** The group's accessible name (a page row's title names it visibly). */
  accessibilityLabel: string;
  segments: readonly HappierSegmentedChoiceSegment[];
  /** Called with the pressed or arrowed-to segment's index; the caller owns what it means. */
  onSelect: (index: number) => void;
  disabled?: boolean;
  size?: HappierSegmentedSize;
  colors: HappierSegmentedChoiceColors;
  testID?: string;
  /** Footprint choices may reflow at narrow widths or enlarged text. */
  wrap?: boolean;
}>;

/**
 * A single-choice radio group drawn as a segmented control: content-sized
 * segments on one track, the chosen one on a raised surface. Arrow keys move
 * the choice (skipping unavailable segments, mirrored in right-to-left
 * layouts) through the shared tablist key rule, and the group keeps one tab
 * stop on the chosen segment.
 */
export function HappierSegmentedChoice(props: HappierSegmentedChoiceProps) {
  const paintColor = useHappierMaterialColorResolver();
  const localization = useOptionalHappierUiLocalization();
  const rtl = localization ? localization.direction === 'rtl' : I18nManager.isRTL;
  const size = props.size ?? 'default';
  const groupDisabled = props.disabled === true;
  const segmentRefs = useRef(new Map<string, HappierFocusable>());
  const selectedIndex = props.segments.findIndex((segment) => segment.selected && !segment.disabled);
  const tabStopIndex = groupDisabled
    ? -1
    : selectedIndex >= 0 ? selectedIndex : props.segments.findIndex((segment) => !segment.disabled);
  const verticalPadding = HAPPIER_SEGMENTED_METRICS.segmentPaddingVerticalPx[size];
  const horizontalPadding = HAPPIER_SEGMENTED_METRICS.segmentPaddingHorizontalPx;

  return (
    <View
      role="radiogroup"
      accessibilityLabel={props.accessibilityLabel}
      aria-label={props.accessibilityLabel}
      aria-disabled={groupDisabled || undefined}
      testID={props.testID}
      style={{
        flexDirection: 'row',
        flexWrap: props.wrap ? 'wrap' : 'nowrap',
        alignSelf: 'flex-start',
        maxWidth: '100%',
        padding: HAPPIER_SEGMENTED_METRICS.trackPaddingPx,
        borderRadius: HAPPIER_SEGMENTED_METRICS.trackRadiusPx[size],
        backgroundColor: paintColor(props.colors.track),
        // One dim on the track, not per segment, so the chosen surface is not dimmed twice.
        opacity: groupDisabled ? HAPPIER_SEGMENTED_METRICS.disabledOpacity : 1,
      }}
    >
      {props.segments.map((segment, index) => {
        const disabled = groupDisabled || segment.disabled;
        return (
          <HappierPressable
            key={segment.key}
            accessibilityRole="radio"
            accessibilityLabel={segment.accessibilityLabel ?? segment.label}
            checked={segment.selected}
            disabled={disabled}
            tabIndex={index === tabStopIndex ? 0 : -1}
            testID={segment.testID}
            controlRef={(node) => {
              if (node) segmentRefs.current.set(segment.key, node);
              else segmentRefs.current.delete(segment.key);
            }}
            onPress={() => { props.onSelect(index); }}
            onKeyDown={(key) => {
              if (groupDisabled) return false;
              const nextIndex = resolveHappierTabKeySelection({
                tabs: props.segments,
                currentIndex: index,
                key,
                rtl,
              });
              if (nextIndex === null) return false;
              const next = props.segments[nextIndex];
              if (!next) return false;
              props.onSelect(nextIndex);
              if (nextIndex !== index) segmentRefs.current.get(next.key)?.focus();
              return true;
            }}
            style={(state) => ({
              minWidth: HAPPIER_SEGMENTED_METRICS.segmentMinWidthPx,
              alignItems: 'center',
              flexDirection: 'row',
              gap: segment.leading ? HAPPIER_SEGMENTED_METRICS.trackPaddingPx * 2 : 0,
              justifyContent: 'center',
              paddingVertical: verticalPadding,
              paddingHorizontal: horizontalPadding,
              borderRadius: HAPPIER_SEGMENTED_METRICS.segmentRadiusPx[size],
              ...happierFocusRingStyle({ visible: state.focused, color: props.colors.focusRing }),
              backgroundColor: segment.selected ? paintColor(props.colors.thumb) : 'transparent',
              ...(segment.selected && !state.pressed ? props.colors.thumbLift : undefined),
              opacity: !groupDisabled && segment.disabled
                ? HAPPIER_SEGMENTED_METRICS.disabledOpacity
                : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
            })}
          >
            {segment.leading}
            <HappierText
              accessible={false}
              numberOfLines={1}
              style={{
                fontSize: HAPPIER_SEGMENTED_METRICS.labelFontSizePx[size],
                // The label's line box is its slot, so every segmented control is padding + slot tall.
                lineHeight: HAPPIER_SEGMENTED_METRICS.labelSlotPx[size],
                color: segment.selected ? props.colors.activeLabel : props.colors.label,
                ...(segment.selected ? { fontWeight: HAPPIER_SEGMENTED_METRICS.labelActiveFontWeight } : {}),
              }}
            >
              {segment.label}
            </HappierText>
          </HappierPressable>
        );
      })}
    </View>
  );
}
