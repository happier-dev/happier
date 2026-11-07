import { createContext, useContext, useState, type ReactElement, type ReactNode } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';

import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import type { HappierStyleProp } from '../portableTypes.js';

export type HappierRowActionRevealSlotProps = Readonly<{
  revealed: boolean;
  reserveWidth?: number;
  style?: HappierStyleProp;
  /** Notified when descendant focus enters/leaves, for hosts that mirror it. */
  onFocus?: () => void;
  onBlur?: () => void;
  /**
   * Reads the reduced-motion preference when the slot renders (a reveal is a render). A host with a shared
   * preference watch passes its non-subscribing read; without it the environment's resolved preference is used.
   */
  readReducedMotion?: () => boolean;
  testID?: string;
  children: ReactNode;
}>;

/** Whether the slot around an action has ever been revealed; outside a slot, icons always mount. */
const RowActionIconsMountedContext = createContext(true);

/**
 * The one reveal mechanism for a row's quiet actions (a message's pin/copy/fork, a tool row's pin, a
 * Projects row's menu, a public List row's overflow).
 *
 * Contract:
 * - the slot reserves its footprint, so revealing never shifts the row;
 * - only opacity changes, so a reveal can never move the content around it; on web the fade is a CSS
 *   transition (no JS animation, no per-frame render), instant under reduced motion;
 * - a hidden slot is not clickable (`pointerEvents: none`), so it never swallows text selection or
 *   clicks in the corner it occupies;
 * - hidden actions stay in the accessibility tree and stay focusable, and the SLOT reveals itself on
 *   descendant focus, so no host can leave invisible-but-activatable actions behind. `onFocus`/`onBlur`
 *   only notify hosts that mirror the focus into their own hover state;
 * - icons wrapped in `HappierRowActionDeferredIcon` mount on the slot's first reveal (or focus) and then
 *   stay: a list mounts a closed slot per row, and the pixels of actions nobody can see yet are most of
 *   what each one costs.
 */
export function HappierRowActionRevealSlot(props: HappierRowActionRevealSlotProps): ReactElement {
  const [focusWithin, setFocusWithin] = useState(false);
  const revealed = props.revealed || focusWithin;
  // Latched, so icons stay through the fade-out and for the row's life instead of remounting per hover.
  const [iconsMounted, setIconsMounted] = useState(revealed);
  if (revealed && !iconsMounted) setIconsMounted(true);
  const environmentReducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion === true;
  const isWeb = Platform.OS === 'web';
  const reducedMotion = isWeb && (props.readReducedMotion ? props.readReducedMotion() : environmentReducedMotion);

  return (
    <View
      testID={props.testID}
      onFocus={() => {
        setFocusWithin(true);
        props.onFocus?.();
      }}
      onBlur={() => {
        setFocusWithin(false);
        props.onBlur?.();
      }}
      {...(isWeb ? {} : { pointerEvents: revealed ? ('auto' as const) : ('none' as const) })}
      style={[
        slotStyle,
        props.reserveWidth != null ? { width: props.reserveWidth } : null,
        props.style,
        isWeb ? (revealed ? webRevealedPointerStyle : webHiddenPointerStyle) : null,
        isWeb ? (reducedMotion ? webInstantStyle : webFadeStyle) : null,
        revealed ? revealedStyle : hiddenStyle,
      ]}
    >
      <RowActionIconsMountedContext.Provider value={iconsMounted}>{props.children}</RowActionIconsMountedContext.Provider>
    </View>
  );
}

/**
 * An action's icon inside a `HappierRowActionRevealSlot`, mounted once the slot has been revealed. The
 * action itself stays mounted, labelled and focusable while hidden; only its icon waits, in a box of the
 * icon's size so revealing never changes the action's hit size or shifts the row.
 */
export function HappierRowActionDeferredIcon(props: Readonly<{ size: number; children: ReactNode }>): ReactElement {
  const iconsMounted = useContext(RowActionIconsMountedContext);
  if (iconsMounted) return <>{props.children}</>;
  return <View style={readIconBoxStyle(props.size)} />;
}

const iconBoxStyles = new Map<number, ViewStyle>();
function readIconBoxStyle(size: number): ViewStyle {
  let style = iconBoxStyles.get(size);
  if (!style) {
    style = { width: size, height: size };
    iconBoxStyles.set(size, style);
  }
  return style;
}

const slotStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' };
const revealedStyle: ViewStyle = { opacity: 1 };
const hiddenStyle: ViewStyle = { opacity: 0 };
// react-native-web forwards these as CSS; the native ViewStyle type does not declare them.
const webRevealedPointerStyle = { pointerEvents: 'auto' } as ViewStyle;
const webHiddenPointerStyle = { pointerEvents: 'none' } as ViewStyle;
const webFadeStyle = {
  transitionProperty: 'opacity',
  transitionDuration: `${HAPPIER_MOTION_V1.fastMs}ms`,
  transitionTimingFunction: `cubic-bezier(${HAPPIER_MOTION_V1.standardBezier.join(', ')})`,
} as unknown as ViewStyle;
const webInstantStyle = { transitionProperty: 'opacity', transitionDuration: '0ms' } as unknown as ViewStyle;
