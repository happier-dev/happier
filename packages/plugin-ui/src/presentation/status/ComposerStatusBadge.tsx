import type { ReactElement, ReactNode, RefObject } from 'react';
import { Pressable, View } from 'react-native';

import { HappierBadge } from '../content/Foundation.js';
import { useHappierHitArea } from '../interaction/hitArea.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import type { HappierTypeEmphasis, HappierTypeRole } from '../text/typeScale.js';

/** What a composer status item is saying: work under way, finished, needing a look, or simply a fact. */
export type HappierComposerStatusTone = 'neutral' | 'active' | 'paused' | 'warning' | 'complete';
/** `prominent` (default): a capsule among the composer's chips. `quiet`: plain words, no chrome. */
export type HappierComposerStatusEmphasis = 'quiet' | 'prominent';
/** The status state whose tint, ink and marker colours an item draws. */
export type HappierComposerStatusState = 'info' | 'success' | 'warning' | 'neutral';

/**
 * The one tone → state map for the composer's status items. `paused` reads as a muted, inactive
 * state, the same as `neutral`.
 */
export function resolveHappierComposerStatusState(tone: HappierComposerStatusTone): HappierComposerStatusState {
  if (tone === 'active') return 'info';
  if (tone === 'complete') return 'success';
  if (tone === 'warning') return 'warning';
  return 'neutral';
}

/**
 * The words' type. Beside the composer's chips a prominent item takes the composer's own status-line
 * type (row meta, semibold); a quiet item is the same row meta at regular weight, so it sits on one
 * line height and size with the strip's other plain values ("91% left") instead of reading a point
 * smaller beside them. Its ink is the secondary role (the adapters' choice), like those values.
 */
export const HAPPIER_COMPOSER_STATUS_BADGE_TYPE: Readonly<Record<HappierComposerStatusEmphasis, Readonly<{
  role: HappierTypeRole;
  emphasis: HappierTypeEmphasis;
  letterSpacing: number;
}>>> = Object.freeze({
  prominent: Object.freeze({ role: 'meta', emphasis: 'semiBold', letterSpacing: 0 }),
  quiet: Object.freeze({ role: 'meta', emphasis: 'regular', letterSpacing: 0 }),
});

/**
 * The item's rhythm beside the composer's chips (lab `.l12-sb`): 24 high on the row-meta line, an 8/9
 * inset and 6 between mark and words. A quiet item has no inset and sits 4 from its mark. Under a
 * finger the shared hit area reaches the touch target; the drawn item never grows into a row of plain
 * 11pt status text.
 */
export const HAPPIER_COMPOSER_STATUS_BADGE_METRICS = Object.freeze({
  paddingTop: 4,
  paddingBottom: 4,
  paddingLeft: 8,
  paddingRight: 9,
  gap: 6,
  quietGap: 4,
  caretSize: 11,
  /** A leading mark's box, at the words' line. */
  iconSize: 14,
});

export type HappierComposerStatusBadgeProps = Readonly<{
  /** The words as plain text: the accessible name when no other is given. */
  label: string;
  /** The words drawn by the realm's own text element, in {@link HAPPIER_COMPOSER_STATUS_BADGE_TYPE}. */
  text: ReactNode;
  /** A decorative mark before the words, in the state's marker ink. */
  leading?: ReactNode;
  /** The realm's caret glyph; drawn only when the item opens a popover and is prominent. */
  caret?: ReactNode;
  opensPopover?: boolean;
  emphasis?: HappierComposerStatusEmphasis;
  /** The state tint behind a prominent item (the host's `state.*.background`). */
  tintColor: string;
  /** The words' ink: the primary role on a prominent item's tint, the secondary role for a quiet item's plain words. */
  inkColor: string;
  onPress?: () => void;
  /** The node an anchored popover measures. */
  anchorRef?: RefObject<unknown>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: Readonly<{ expanded: boolean }>;
  testID?: string;
}>;

// No percentage cap: the item sits in the strip's content-sized cluster, where a percentage of that
// cluster is cyclic and wraps even a short reason inside a sliver of its own width. The strip's
// overflow collapse owns narrow rows; the item shrinks so its words ellipsize instead of spilling.
const WRAPPER_STYLE: HappierPortableStyle = { flexShrink: 1, minWidth: 0 };
const WRAPPER_PRESSED_STYLE: HappierPortableStyle = { flexShrink: 1, minWidth: 0, opacity: HAPPIER_PRESS_FEEDBACK_V1.opacity };
const BADGE_SHRINK_STYLE: HappierPortableStyle = { flexShrink: 1, minWidth: 0 };
const QUIET_STYLE: HappierPortableStyle = { flexShrink: 1, minWidth: 0, gap: HAPPIER_COMPOSER_STATUS_BADGE_METRICS.quietGap };

/**
 * The composer's status item: the one implementation of the instrument strip's status capsule, its
 * press target and the anchor its popover measures. Core and plugin authors each pass their realm's
 * text, glyphs and inks; the chrome, rhythm, caret rule and semantics are decided here once.
 */
export function HappierComposerStatusBadge(props: HappierComposerStatusBadgeProps): ReactElement {
  const quiet = props.emphasis === 'quiet';
  const metrics = HAPPIER_COMPOSER_STATUS_BADGE_METRICS;
  // Content-sized: the shared owner measures the item and reaches its hit area to the finger target
  // (an invisible frame on the web, which ignores a raw platform `hitSlop`).
  const hitArea = useHappierHitArea({ restingStyle: () => WRAPPER_STYLE });
  const badge = (
    <HappierBadge
      color={props.inkColor}
      backgroundColor={quiet ? 'transparent' : props.tintColor}
      shape="capsule"
      {...(quiet
        ? { horizontalPadding: 0, verticalPadding: 0 }
        : { gap: metrics.gap })}
      style={(quiet
        ? QUIET_STYLE
        : [BADGE_SHRINK_STYLE, {
          paddingTop: metrics.paddingTop,
          paddingBottom: metrics.paddingBottom,
          paddingLeft: metrics.paddingLeft,
          paddingRight: metrics.paddingRight,
        }]) as HappierStyleProp}
      leading={props.leading}
      trailing={props.opensPopover && !quiet ? props.caret : undefined}
    >
      <>{props.text}</>
    </HappierBadge>
  );

  if (!props.onPress) {
    return (
      <View
        ref={props.anchorRef as RefObject<View>}
        testID={props.testID}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={props.accessibilityHint}
        accessibilityState={props.accessibilityState}
        style={WRAPPER_STYLE}
      >
        {badge}
      </View>
    );
  }

  return (
    <Pressable
      ref={props.anchorRef as RefObject<View>}
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={props.accessibilityState}
      // React Native Web announces disclosure through the ARIA prop, not `accessibilityState`.
      aria-expanded={props.accessibilityState?.expanded}
      hitSlop={hitArea.hitSlop}
      onLayout={hitArea.onLayout}
      onPress={props.onPress}
      style={({ pressed }) => (pressed ? WRAPPER_PRESSED_STYLE : WRAPPER_STYLE)}
    >
      {hitArea.frame}
      {badge}
    </Pressable>
  );
}
