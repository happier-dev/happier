import { useEffect, useRef, useState, type ReactNode } from 'react';
import { I18nManager, Platform, ScrollView, View } from 'react-native';

import { useOptionalHappierUiLocalization, useOptionalHappierUiTypography } from '../../environment/context.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HAPPIER_SEGMENTED_GEOMETRY } from './segmentedMetrics.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import { resolveHappierTabKeySelection } from '../navigation/Tabs.js';
import type { HappierFocusable, HappierPortableStyle } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { useHappierMaterialColorResolver } from '../layout/Surface.js';
import { resolveHappierTextStepStyle } from '../layout/pageText.js';
import { resolveHappierTypeScale } from '../text/typeScale.js';
import { useHappierFieldIssueSemantics } from './Fields.js';

/**
 * Control text is the `body` role (the lab's 13 to 13.5px segment, select and button text, rounded
 * down by the scale's half-size rule); a compact segment takes `micro`. The geometry
 * (`HAPPIER_SEGMENTED_GEOMETRY`) keeps the track 32 (compact 24) tall, whatever the role's own line height.
 */
const SEGMENT_LABEL_ROLE = Object.freeze({
  default: resolveHappierTypeScale('body', Platform.OS),
  compact: resolveHappierTypeScale('micro', Platform.OS),
});

/**
 * The segmented control's geometry and label type, shared by Happier core's
 * `SegmentedTabBar` and the plugin segmented `Select`, so a two-to-four-way
 * choice has one shape wherever it is drawn (the hosted HTML kit reads the geometry).
 */
export const HAPPIER_SEGMENTED_METRICS = Object.freeze({
  ...HAPPIER_SEGMENTED_GEOMETRY,
  labelFontSizePx: Object.freeze({ default: SEGMENT_LABEL_ROLE.default.fontSize, compact: SEGMENT_LABEL_ROLE.compact.fontSize }),
  pills: Object.freeze({ ...HAPPIER_SEGMENTED_GEOMETRY.pills, labelFontSizePx: SEGMENT_LABEL_ROLE.default.fontSize }),
  plain: Object.freeze({ ...HAPPIER_SEGMENTED_GEOMETRY.plain, labelFontSizePx: SEGMENT_LABEL_ROLE.default.fontSize }),
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
  /**
   * The outline an inherited choice's segment draws instead of the thumb surface (`valueSource`
   * `inherited`): ink border role, no fill, no lift. Absent, the host's track colour stands in.
   */
  inheritedThumbBorder?: string;
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
  /**
   * A narrow toolbar's form (List | Board on a phone): a segment with a leading mark shows the mark
   * alone, at the same height, and its label stays its accessible name. A segment without a mark
   * keeps its label, since nothing else could name it on screen.
   */
  iconOnly?: boolean;
  /**
   * A track that can be wider than its container (a phone's board columns). It scrolls sideways
   * instead of being clipped, and the chosen segment is kept in view whenever it changes.
   */
  scrollable?: boolean;
  /**
   * A track that takes its container's whole width, its segments sharing it equally (a panel's
   * level choice above what it means). Without it the track is content-sized.
   */
  fill?: boolean;
  /**
   * Where the chosen value comes from. `set` (default): the person chose it, drawn on the filled thumb.
   * `inherited`: it follows a default (a tool on its server's default), drawn as an outlined thumb with
   * the label in secondary ink, and announced with a "default" suffix. Selection semantics are unchanged.
   */
  valueSource?: 'set' | 'inherited';
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
  const typography = useOptionalHappierUiTypography();
  // Inside a typed field (a form's few-way choice) each segment carries the field's issue and
  // description, as the field's other controls do; elsewhere this is empty.
  const fieldIssue = useHappierFieldIssueSemantics();
  const localization = useOptionalHappierUiLocalization();
  const rtl = localization ? localization.direction === 'rtl' : I18nManager.isRTL;
  const size = props.size ?? 'default';
  const inherited = props.valueSource === 'inherited';
  const inheritedSuffix = inherited
    ? (localization?.translate('happier.plugin-ui.segmented.inherited', 'default') ?? 'default')
    : null;
  const groupDisabled = props.disabled === true;
  const segmentRefs = useRef(new Map<string, HappierFocusable>());
  const selectedIndex = props.segments.findIndex((segment) => segment.selected && !segment.disabled);
  const tabStopIndex = groupDisabled
    ? -1
    : selectedIndex >= 0 ? selectedIndex : props.segments.findIndex((segment) => !segment.disabled);
  const verticalPadding = HAPPIER_SEGMENTED_METRICS.segmentPaddingVerticalPx[size];
  const horizontalPadding = HAPPIER_SEGMENTED_METRICS.segmentPaddingHorizontalPx;
  const scrollable = props.scrollable === true;
  const scrollRef = useRef<ScrollView | null>(null);
  const reach = useRef({ viewport: 0, offset: 0, selected: selectedIndex, pending: true, segments: new Map<string, Readonly<{ x: number; width: number }>>() });
  reach.current.selected = selectedIndex;
  const revealSelected = () => {
    const state = reach.current;
    const chosen = props.segments[state.selected];
    const frame = chosen === undefined ? undefined : state.segments.get(chosen.key);
    if (!state.pending || frame === undefined || state.viewport === 0) return;
    // A choice is revealed once, so a reader who scrolls the strip on to other segments is not pulled back.
    state.pending = false;
    const margin = HAPPIER_SEGMENTED_METRICS.trackPaddingPx * 4;
    const target = frame.x < state.offset ? frame.x - margin
      : frame.x + frame.width > state.offset + state.viewport ? frame.x + frame.width - state.viewport + margin
      : null;
    if (target === null) return;
    state.offset = Math.max(0, target);
    scrollRef.current?.scrollTo({ x: state.offset, animated: false });
  };
  useEffect(() => {
    reach.current.pending = true;
    if (scrollable) revealSelected();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex, scrollable]);

  // A track that cannot show every label at its natural width gives up its segments' side padding and
  // spreads them across the width it has (a narrow pane, an enlarged text size), instead of clipping.
  // The natural width is measured only while it is roomy, so the two states never fight over a size.
  const fitsContainer = !props.wrap && !scrollable;
  const fill = fitsContainer && props.fill === true;
  const fit = useRef({ available: 0, natural: 0 });
  const [tight, setTight] = useState(false);
  const labelSignature = `${size}\u0000${props.segments.map((segment) => segment.label).join('\u0000')}`;
  useEffect(() => {
    fit.current.natural = 0;
    setTight(false);
  }, [labelSignature]);
  const refit = () => {
    const { available, natural } = fit.current;
    if (available === 0 || natural === 0) return;
    setTight(natural + HAPPIER_SEGMENTED_METRICS.trackPaddingPx * 2 > available + 0.5);
  };
  // A filled track spreads its segments over the width it is given, so it never needs the roomy padding.
  const stretch = tight || fill;
  const segmentPadding = stretch ? HAPPIER_SEGMENTED_METRICS.segmentPaddingTightPx : horizontalPadding;
  const fitRow = (segments: ReactNode) => fitsContainer ? (
    <View
      style={stretch ? { flexDirection: 'row', flexGrow: 1, minWidth: 0 } : { flexDirection: 'row', flexShrink: 0, alignSelf: 'flex-start' }}
      onLayout={(event) => {
        if (!stretch) fit.current.natural = event.nativeEvent.layout.width;
        refit();
      }}
    >{segments}</View>
  ) : segments;

  const track = (
    <View
      role="radiogroup"
      accessibilityLabel={props.accessibilityLabel}
      aria-label={props.accessibilityLabel}
      aria-disabled={groupDisabled || undefined}
      testID={props.testID}
      style={{
        flexDirection: 'row',
        flexWrap: props.wrap ? 'wrap' : 'nowrap',
        alignSelf: stretch ? 'stretch' : 'flex-start',
        ...(scrollable ? undefined : { maxWidth: '100%' }),
        padding: HAPPIER_SEGMENTED_METRICS.trackPaddingPx,
        borderRadius: HAPPIER_SEGMENTED_METRICS.trackRadiusPx[size],
        backgroundColor: paintColor(props.colors.track),
        // One dim on the track, not per segment, so the chosen surface is not dimmed twice.
        opacity: groupDisabled ? HAPPIER_SEGMENTED_METRICS.disabledOpacity : 1,
      }}
    >
      {fitRow(props.segments.map((segment, index) => {
        const disabled = groupDisabled || segment.disabled;
        const showsLabel = props.iconOnly !== true || segment.leading === undefined || segment.leading === null;
        const pressable = (
          <HappierPressable
            key={scrollable ? undefined : segment.key}
            accessibilityRole="radio"
            accessibilityLabel={segment.selected && inheritedSuffix !== null
              ? `${segment.accessibilityLabel ?? segment.label}, ${inheritedSuffix}`
              : segment.accessibilityLabel ?? segment.label}
            checked={segment.selected}
            disabled={disabled}
            describedById={fieldIssue.descriptionId}
            invalid={fieldIssue.invalid}
            errorMessageId={fieldIssue.issueId}
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
              gap: segment.leading && showsLabel ? HAPPIER_SEGMENTED_METRICS.trackPaddingPx * 2 : 0,
              justifyContent: 'center',
              paddingVertical: verticalPadding,
              paddingHorizontal: segmentPadding,
              ...(fill ? { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }
                : tight ? { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0 } : undefined),
              borderRadius: HAPPIER_SEGMENTED_METRICS.segmentRadiusPx[size],
              ...happierFocusRingStyle({ visible: state.focused, color: props.colors.focusRing }),
              backgroundColor: segment.selected && !inherited ? paintColor(props.colors.thumb, undefined, 'solidControl') : 'transparent',
              // An inherited value is outlined: the same box (the border sits inside it), no fill, no lift.
              ...(segment.selected && inherited
                ? { borderWidth: 1, borderColor: props.colors.inheritedThumbBorder ?? props.colors.track, paddingVertical: verticalPadding - 1, paddingHorizontal: segmentPadding - 1 }
                : undefined),
              ...(segment.selected && !inherited && !state.pressed ? props.colors.thumbLift : undefined),
              opacity: !groupDisabled && segment.disabled
                ? HAPPIER_SEGMENTED_METRICS.disabledOpacity
                : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
            })}
          >
            {segment.leading}
            {showsLabel ? <HappierText
              accessible={false}
              numberOfLines={1}
              style={{
                // The label's line box is its slot, so every segmented control is padding + slot tall.
                ...resolveHappierTextStepStyle({
                  fontSize: HAPPIER_SEGMENTED_METRICS.labelFontSizePx[size],
                  lineHeight: HAPPIER_SEGMENTED_METRICS.labelSlotPx[size],
                  weight: segment.selected ? HAPPIER_SEGMENTED_METRICS.labelActiveEmphasis : 'regular',
                }, typography),
                color: segment.selected && !inherited ? props.colors.activeLabel : props.colors.label,
              }}
            >
              {segment.label}
            </HappierText> : null}
          </HappierPressable>
        );
        // A scrolling track reads each segment's frame to keep the chosen one in view.
        return scrollable ? (
          <View key={segment.key} onLayout={(event) => {
            const { x, width } = event.nativeEvent.layout;
            reach.current.segments.set(segment.key, { x, width });
            revealSelected();
          }}>{pressable}</View>
        ) : pressable;
      }))}
    </View>
  );
  if (!scrollable) return fitsContainer ? <View style={{ alignSelf: stretch ? 'stretch' : 'flex-start', maxWidth: '100%' }} onLayout={(event) => { fit.current.available = event.nativeEvent.layout.width; refit(); }}>{track}</View> : track;
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      scrollEventThrottle={16}
      style={{ flexGrow: 0 }}
      onLayout={(event) => { reach.current.viewport = event.nativeEvent.layout.width; revealSelected(); }}
      onScroll={(event) => { reach.current.offset = event.nativeEvent.contentOffset.x; }}
    >
      {track}
    </ScrollView>
  );
}
