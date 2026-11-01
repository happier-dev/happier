import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Platform,
  Pressable as ReactNativePressable,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { HappierHitReach } from '../../environment/interactiveTarget.js';
import { useHappierHitArea } from './hitArea.js';
import { isHappierFocusVisible } from './focusVisible.js';
import type {
  HappierFocusable,
  HappierGestureResponderEvent,
  HappierStyleProp,
} from '../portableTypes.js';

/**
 * The single implementation owner for Happier's pressable interaction
 * (UI-T27) — the mechanism behind every button, icon button and plugin action.
 *
 * Extracted from `apps/ui/sources/components/ui/buttons/IconButton.tsx` and
 * `RoundButton.tsx`, which each carried their OWN copy of it: `IconButton`
 * detected a thenable with a local `isPromiseLike` and guarded reentry with a
 * `busyRef`, while `RoundButton` ran a separate `setLoading(true)` around its
 * `action` prop and left the same-tick reentry hole open. Two owners for one
 * press→pending machine had already drifted; this is the consolidation, not a
 * third copy.
 *
 * What it owns:
 *
 * - **Async-pending lifecycle.** A press handler that returns a thenable puts
 *   the control in a busy state until the promise SETTLES — resolve or reject
 *   alike. A rejection clears pending without fabricating an error status,
 *   because the caller, not the button, owns what a failure means.
 * - **Same-tick reentry.** The guard is a ref, not the rendered state: React has
 *   not committed `busy` yet when a second press arrives in the same tick, and a
 *   state-only guard fires the action twice.
 * - **Unmount safety.** A promise that settles after unmount must not set state.
 * - **Interaction state.** `pressed`/`hovered`/`focused` reach the style callback
 *   AND the children, so a control can react to hover without a second state.
 *   React Native Web reports `hovered`/`focused` in the press state; the
 *   `react-native` types do not model them, so they are merged here once rather
 *   than re-normalized by every caller.
 * - **Accessibility identity.** Role, label, hint and the composed
 *   `busy`/`disabled`/`selected` state, so a pending control announces itself as
 *   busy instead of silently ignoring presses.
 *
 * What it deliberately does NOT own: colour, chrome and typography. Those come
 * from the caller's `style` callback — Happier core resolves them from
 * Unistyles, a plugin surface from its projected theme (§3.10.2). One mechanism,
 * two chromes, is the split this seam exists to make; one chrome, two
 * mechanisms, is what it removes.
 */
/**
 * The interaction facts THIS owner holds, available to content and overlays.
 *
 * Native paint layers need the same press fact as CSS chrome. The existing
 * press-in/out boundary supplies it to content without changing its parent.
 */
export type HappierPressableState = Readonly<{
  pressed: boolean;
  hovered: boolean;
  focused: boolean;
  /** Composite-widget roving highlight; it is not a semantic selected value. */
  highlighted: boolean;
  selected: boolean;
  /** An async press is in flight, or the caller declared the control busy. */
  busy: boolean;
  /** Declared disabled, or disabled because a press is in flight. */
  disabled: boolean;
}>;

/** {@link HappierPressableState} plus the per-frame press flag. */
export type HappierPressableStyleState = HappierPressableState & Readonly<{ pressed: boolean }>;

export type HappierPressableRole = 'button' | 'checkbox' | 'link' | 'radio' | 'tab' | 'switch' | 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'option';

export type HappierPressableProps = Readonly<{
  /**
   * Runs on press. Return a thenable to get the pending lifecycle; return
   * anything else (including nothing) for an instantaneous action.
   */
  onPress: (event?: HappierGestureResponderEvent) => unknown;
  onPressIn?: (event?: HappierGestureResponderEvent) => void;
  /** Pairs with `onPressIn`: fires when the press releases or is cancelled. */
  onPressOut?: (event?: HappierGestureResponderEvent) => void;
  /** Native touch context invocation; callers retain the semantic outcome. */
  onLongPress?: (event?: HappierGestureResponderEvent) => void;
  /** Web context invocation; this is absent from React Native's native prop model. */
  onContextMenu?: (event: unknown) => void;
  /** Framework-neutral keyboard hook used by compound selection owners; inactive while disabled or busy. */
  onKeyDown?: (key: string, event: unknown) => boolean;
  /**
   * Reports this control's own focus transitions to a composite owner.
   *
   * A tablist, listbox or menu has to know which of its controls currently
   * holds focus in order to recover it when that control is removed. Reading
   * `document.activeElement` after the removal cannot answer that — the node is
   * already gone and platforms disagree about where focus went — so the fact is
   * published while the control still exists. This is not a second focus state:
   * it is emitted from the one this owner already keeps.
   */
  onFocusChange?: (focused: boolean) => void;
  /** The pointer's hover entering and leaving, from the same hover fact the chrome uses (never touch). */
  onHoverChange?: (hovered: boolean) => void;
  disabled?: boolean;
  /**
   * A disabled control that can say why. When given, the control stays reachable while disabled:
   * it keeps its tab stop, hover and press, still announces itself disabled, and a press (pointer,
   * touch or keyboard) calls this instead of `onPress`, with the press event. The caller shows its
   * reason here, so a touch user who cannot hover still learns why the control does nothing.
   */
  onDisabledPress?: (event?: HappierGestureResponderEvent) => void;
  /**
   * Declare the busy state instead of deriving it from the press promise, for a
   * control whose work is owned elsewhere. A declared or derived true value
   * keeps the control busy; `false` cannot hide a promise this owner started.
   */
  busy?: boolean;
  /** An enclosing field has an invalid value. RNW receives `aria-invalid`. */
  invalid?: boolean;
  /** The enclosing field's validation message identity, when invalid. */
  errorMessageId?: string;
  /**
   * The identity of the element that DESCRIBES this control, beside its name.
   *
   * React Native Web has no `accessibilityHint` mapping at all, so a hint alone
   * reaches native assistive technology and nothing on the web. A caller that
   * owns a description renders it with a stable `nativeID` and names that id
   * here, which is the one description relationship RNW actually emits.
   */
  describedById?: string;
  /** Visual/current-row state owned by a composite widget's roving selection. */
  highlighted?: boolean;
  selected?: boolean;
  /**
   * The navigation control for what the page shows now (a column row). The web announces it as
   * `aria-current`; native assistive technology reads it as the selected state.
   */
  current?: 'page';
  expanded?: boolean;
  /** Position within a list-like composite role, projected to native/RNW ARIA. */
  accessibilityPositionInSet?: number;
  /** Total size for a list-like composite role, projected to native/RNW ARIA. */
  accessibilitySetSize?: number;
  hasPopup?: 'dialog' | 'menu';
  /** Checked state; `mixed` announces a partially checked checkbox or checkbox menu item. */
  checked?: boolean | 'mixed';
  accessibilityRole?: HappierPressableRole;
  /**
   * ARIA-only composite role (a menu's checked items, a tree's items); native assistive tech uses
   * accessibilityRole.
   */
  webRole?: 'menuitemcheckbox' | 'menuitemradio' | 'treeitem';
  /** Nesting level of a tree item (1-based), projected to `aria-level`. */
  accessibilityLevel?: number;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** The control's current value, announced by native assistive technology and RNW ARIA. */
  accessibilityValue?: Readonly<{ min?: number; max?: number; now?: number; text?: string }>;
  /** Native assistive actions, supplied by the owning domain operation. */
  accessibilityActions?: readonly Readonly<{ name: string; label?: string }>[];
  onAccessibilityAction?: (event: Readonly<{ nativeEvent: Readonly<{ actionName: string }> }>) => void;
  /**
   * A precise pointer's extra press reach, forwarded as React Native `hitSlop`. Where the control has
   * a hit area (a finger, or a declared `hitTarget`), the hit area replaces it.
   */
  hitSlop?: number | Readonly<{ top?: number; bottom?: number; left?: number; right?: number }>;
  /**
   * The smallest hit area this control asks for, beyond the environment's touch target (44, 48 on
   * Android, under a finger). It never changes the drawn size: the hit area reaches past the drawn box
   * (native `hitSlop`, an invisible frame on the web).
   */
  hitTarget?: number;
  /**
   * How far the hit area may reach past the drawn box on each side: half the gap to a neighbour, or the
   * free space to a clipping edge. Omitted sides reach as far as the target needs; `0` keeps the hit
   * area on the drawn box (a control whose own frame already owns its reach).
   */
  hitReach?: HappierHitReach;
  testID?: string;
  /** Internal composite-widget focus registration; disabled controls report no target. */
  controlRef?: (instance: HappierFocusable | null) => void;
  /** Web roving-tabindex projection for composite widgets. */
  tabIndex?: -1 | 0;
  /** Stable DOM/native identity for labelled relationships. */
  nativeID?: string;
  /** Web tab-to-panel relationship. */
  controls?: string;
  /** Web ARIA shortcut declaration for a composite row's owner-defined key. */
  keyboardShortcuts?: string;
  style?: HappierStyleProp | ((state: HappierPressableStyleState) => HappierStyleProp);
  /**
   * Rendered beside the pressable rather than inside it, in a relatively
   * positioned anchor.
   *
   * This exists for exactly one reason: a hover/focus affordance such as a
   * tooltip must read the control's interaction state but must NOT join its
   * accessibility subtree, or a screen reader announces the hint as part of the
   * button's own name. Without it, `IconButton` would have to keep a second
   * hover/focus state beside this one — which is the duplication this owner
   * removes. Callers that need no overlay pay nothing: the anchor is not
   * rendered at all.
   */
  overlay?: (state: HappierPressableState) => ReactNode;
  children?: ReactNode | ((state: HappierPressableState) => ReactNode);
}>;

/**
 * React Native Web reports hover and focus in the press state; the
 * `react-native` types stop at `pressed`.
 */
type WebPressState = Readonly<{ pressed: boolean; hovered?: boolean; focused?: boolean }>;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null) return false;
  const valueType = typeof value;
  if (valueType !== 'object' && valueType !== 'function') return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

function readKeyboardEventKey(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const candidate = event as Readonly<{
    key?: unknown;
    nativeEvent?: Readonly<{ key?: unknown }>;
  }>;
  const key = candidate.nativeEvent?.key ?? candidate.key;
  return typeof key === 'string' ? key : null;
}

function isKeyboardGeneratedClick(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const candidate = event as Readonly<{
    detail?: unknown;
    nativeEvent?: Readonly<{ detail?: unknown }>;
  }>;
  return (candidate.nativeEvent?.detail ?? candidate.detail) === 0;
}

const anchorStyle: ViewStyle = { position: 'relative' };


function isTouchPointer(event: unknown): boolean {
  const native = (event as { nativeEvent?: { pointerType?: unknown } } | null)?.nativeEvent;
  return native?.pointerType === 'touch';
}

/** Whether this focus shows its ring: {@link isHappierFocusVisible} for the focused element. */
function isFocusVisible(event: unknown): boolean {
  return isHappierFocusVisible((event as { target?: unknown } | null)?.target);
}

export function HappierPressable({
  onPress,
  onPressIn,
  onPressOut,
  onLongPress,
  onContextMenu,
  onKeyDown,
  onFocusChange,
  onHoverChange,
  disabled,
  onDisabledPress,
  busy,
  invalid,
  errorMessageId,
  describedById,
  highlighted,
  selected,
  current,
  expanded,
  accessibilityPositionInSet,
  accessibilitySetSize,
  hasPopup,
  checked,
  accessibilityRole = 'button',
  webRole,
  accessibilityLevel,
  accessibilityLabel,
  accessibilityHint,
  accessibilityValue,
  accessibilityActions,
  onAccessibilityAction,
  hitSlop,
  hitTarget,
  hitReach,
  testID,
  controlRef,
  tabIndex,
  nativeID,
  controls,
  keyboardShortcuts,
  style,
  overlay,
  children,
}: HappierPressableProps) {
  const [pendingPress, setPendingPress] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Web: losing focus commits after the focus move has settled. A focus-dependent overlay (a
  // tooltip, its anchor) that unmounted inside the blur event removed nodes while the document's
  // active element was briefly <body>; a trapped focus scope (the web modal's) reads that as "the
  // focused element was removed" and pulls focus to its container, so Tab never reached the next
  // control (composer chips after "Open prompts").
  const blurCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (blurCommitRef.current !== null) clearTimeout(blurCommitRef.current);
  }, []);
  const pendingRef = useRef(false);
  const controlNodeRef = useRef<HappierFocusable | null>(null);
  const pendingKeyboardFocusRestoreRef = useRef(false);
  // RNW's PressResponder processes keydown before its caller hook. A compound
  // widget that consumed Enter has already published its outcome, so ignore
  // the paired deferred press once: RNW calls it from document keyup for a
  // non-native control and the browser emits a detail-0 click for a native
  // button. This is intentionally a one-key fact, not a second lifecycle.
  const consumedKeyboardPressRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const isBusy = busy === true || pendingPress;
  const isDisabled = disabled === true || isBusy;
  // Disabled but explaining itself: reachable (focus, hover, press) while every action stays refused.
  const explainsDisabled = disabled === true && !isBusy && onDisabledPress !== undefined;
  // React Native Web writes `aria-disabled` from its own `disabled` prop, which stays false here so the
  // control keeps its tab stop and press. The element still has to announce itself disabled, so the
  // one attribute RNW overwrote is restored on the node while the control explains itself.
  // On leaving that state the node gets the value the next render owns, read from a ref updated during
  // render (cleanup runs after the next commit).
  const isDisabledRef = useRef(isDisabled);
  isDisabledRef.current = isDisabled;
  useEffect(() => {
    if (Platform.OS !== 'web' || !explainsDisabled) return;
    const node = controlNodeRef.current as unknown as { setAttribute?: (name: string, value: string) => void } | null;
    node?.setAttribute?.('aria-disabled', 'true');
    return () => node?.setAttribute?.('aria-disabled', String(isDisabledRef.current));
  }, [explainsDisabled]);

  useEffect(() => {
    // StrictMode probes setup -> cleanup -> setup. Reasserting this in setup
    // keeps async settlement live after the probe.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (isBusy || !pendingKeyboardFocusRestoreRef.current) return;
    pendingKeyboardFocusRestoreRef.current = false;
    // A pending keyboard activation can make a native web button lose focus.
    // Restore only when no later focus destination replaced it; pointer actions
    // and explicit focus moves stay owned by their original caller.
    if (Platform.OS === 'web' && document.activeElement !== document.body) return;
    controlNodeRef.current?.focus?.();
  }, [isBusy]);

  const setControlRef = useCallback((node: HappierFocusable | null) => {
    controlNodeRef.current = node;
    controlRef?.(isDisabled ? null : node);
  }, [controlRef, isDisabled]);

  const handlePress = useCallback((event?: HappierGestureResponderEvent) => {
    const key = readKeyboardEventKey(event);
    const consumedKey = consumedKeyboardPressRef.current;
    if (consumedKey !== null && (
      key === consumedKey
      || (consumedKey === 'Enter' && isKeyboardGeneratedClick(event))
    )) {
      consumedKeyboardPressRef.current = null;
      return;
    }
    // A pointer or an unrelated press cannot be the paired keyboard default;
    // never let a lost keyup suppress a later real action.
    consumedKeyboardPressRef.current = null;
    if (pendingRef.current || busy === true) return;
    if (disabled === true) {
      onDisabledPress?.(event);
      return;
    }

    const result = onPress(event);
    if (!isThenable(result)) return;

    pendingRef.current = true;
    pendingKeyboardFocusRestoreRef.current = focused && (
      key !== null || isKeyboardGeneratedClick(event)
    );
    setPendingPress(true);
    void Promise.resolve(result).catch(() => undefined).finally(() => {
      pendingRef.current = false;
      if (mountedRef.current) setPendingPress(false);
    });
  }, [busy, disabled, focused, onDisabledPress, onPress]);

  const handleKeyDown = useCallback((event: unknown) => {
    // RNW still forwards custom keys while disabled. Admit them through the
    // same pending/disabled guard as a press before a compound owner can edit.
    if (pendingRef.current || disabled === true || busy === true) return;
    const candidate = event as Readonly<{
      preventDefault?: () => void;
      stopPropagation?: () => void;
    }>;
    const key = readKeyboardEventKey(event);
    if (key === null) return;

    if (!onKeyDown?.(key, event)) {
      // RNW does not activate tabs, switches or checkboxes with Space. Keep that press semantic
      // here; compound widgets that already handle it retain first refusal.
      if (Platform.OS === 'web' && (accessibilityRole === 'tab' || accessibilityRole === 'switch' || accessibilityRole === 'checkbox') && (key === ' ' || key === 'Spacebar')) {
        candidate.preventDefault?.();
        candidate.stopPropagation?.();
        handlePress({ nativeEvent: { key } });
        return;
      }
      if (Platform.OS === 'web' && key === 'Enter') consumedKeyboardPressRef.current = null;
      return;
    }

    // RNW 0.21.2 considers Enter valid for every pressable role and has
    // already armed its document keyup here. Space is only responder-owned
    // for a buttonish target, while our composite radio Space path is owned
    // by ItemGroup and never reaches that deferred press.
    if (Platform.OS === 'web' && key === 'Enter') consumedKeyboardPressRef.current = key;
    candidate.preventDefault?.();
    candidate.stopPropagation?.();
  }, [accessibilityRole, busy, disabled, handlePress, onKeyDown]);

  const state: HappierPressableState = {
    pressed: pressed && !isDisabled,
    hovered,
    focused,
    highlighted: highlighted === true,
    selected: selected === true,
    busy: isBusy,
    disabled: isDisabled,
  };

  const renderedContent = typeof children === 'function' ? children(state) : children;
  const hitArea = useHappierHitArea({
    restingStyle: () => (typeof style === 'function' ? style({ ...state, pressed: false }) : style),
    hitTarget,
    hitReach,
    hitSlop,
  });
  const content = hitArea.frame === null ? renderedContent : <>{hitArea.frame}{renderedContent}</>;
  const webContextMenuProps = Platform.OS === 'web' && onContextMenu && !isDisabled
    ? { onContextMenu: (event: unknown) => onContextMenu(event) }
    : undefined;
  const nativeAccessibilityRole = accessibilityRole === 'option'
    ? undefined
    : accessibilityRole === 'menuitemcheckbox'
      ? 'checkbox'
      : accessibilityRole === 'menuitemradio'
        ? 'radio'
        : accessibilityRole;
  const platformRoleProps = Platform.OS === 'web'
    ? { role: webRole ?? accessibilityRole }
    : { accessibilityRole: nativeAccessibilityRole };
  const semanticSelected = accessibilityRole === 'option' || accessibilityRole === 'tab' || webRole === 'treeitem'
    ? selected === true
    : Platform.OS !== 'web' && current !== undefined ? true : undefined;
  // The `aria-posinset`/`aria-setsize` pair below is React Native Web only —
  // React Native maps neither on a device. Android's accessibility service reads
  // membership from `accessibilityCollectionItem`, which React Native's Android
  // view config accepts but its published types omit. Derived from the SAME two
  // values as the web aliases, so the two channels cannot disagree.
  const nativeCollectionItem = Platform.OS === 'web'
    || accessibilityPositionInSet === undefined
    || accessibilitySetSize === undefined
    ? undefined
    : {
        rowIndex: accessibilityPositionInSet - 1,
        columnIndex: 0,
        rowSpan: 1,
        columnSpan: 1,
        heading: false,
      };
  // Preserve a static style as a static host prop. Besides avoiding a needless
  // callback for declarative chrome that has no press-state variation, this
  // keeps the host's resolved semantic theme projection observable to the
  // renderer. Stateful callers still receive the complete shared interaction
  // state below.
  const pressableStyle = typeof style === 'function'
    ? (pressState: WebPressState) => {
      // React Native Web reports hover and focus here too. Merging them with
      // the locally tracked values keeps the chrome correct on a renderer that
      // reports only one of the two.
      const web = pressState as WebPressState;
      const styleState: HappierPressableStyleState = {
        ...state,
        hovered: web.hovered === true || hovered,
        // On web RNW reports any focus, including the focus a pointer press leaves behind; the
        // ring follows the browser's focus-visible decision instead (keyboard focus only).
        focused: Platform.OS === 'web' ? focused : web.focused === true || focused,
        pressed: pressState.pressed,
      };
      return style(styleState);
    }
    : style;

  const pressable = (
    <ReactNativePressable
      ref={setControlRef}
      nativeID={nativeID}
      testID={testID}
      {...platformRoleProps}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityValue={accessibilityValue}
      // RNW ignores the native value object; project its fields from the same caller-owned value.
      aria-valuemin={accessibilityValue?.min}
      aria-valuemax={accessibilityValue?.max}
      aria-valuenow={accessibilityValue?.now}
      aria-valuetext={accessibilityValue?.text}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={isDisabled ? undefined : onAccessibilityAction}
      // Emitted in BOTH prop shapes on purpose, from one computed fact.
      // `accessibilityState` is React Native's documented primary API and the
      // shape the app's existing renderer assertions read; React Native Web
      // drops it entirely and maps only the `aria-*` aliases to real DOM
      // attributes. Sending one shape would leave a pending control silent to a
      // screen reader on the other platform. React Native resolves the aliases
      // over the object, and both are derived here from the same values, so
      // they cannot disagree.
      accessibilityState={{ busy: isBusy, checked, disabled: isDisabled, expanded,
        selected: Platform.OS === 'web' ? semanticSelected : selected }}
      aria-busy={isBusy || undefined}
      aria-disabled={isDisabled || undefined}
      aria-selected={Platform.OS === 'web' && current !== undefined ? undefined : semanticSelected}
      aria-pressed={accessibilityRole === 'button' ? selected : undefined}
      aria-current={current}
      aria-level={accessibilityLevel}
      aria-posinset={accessibilityPositionInSet}
      aria-setsize={accessibilitySetSize}
      // @ts-expect-error React Native's published types omit the Android-only collection-item prop its view config accepts.
      accessibilityCollectionItem={nativeCollectionItem}
      aria-checked={checked}
      aria-invalid={invalid || undefined}
      aria-errormessage={invalid ? errorMessageId : undefined}
      aria-describedby={describedById}
      aria-expanded={expanded}
      aria-haspopup={hasPopup}
      aria-controls={controls}
      aria-keyshortcuts={keyboardShortcuts}
      tabIndex={isDisabled && !explainsDisabled ? -1 : tabIndex}
      disabled={isDisabled && !explainsDisabled}
      // A touch target is a hit area, never a drawn size: native reaches it with hitSlop, the web
      // (whose Pressable ignores hitSlop) with the invisible frame above, and the box keeps its size.
      hitSlop={hitArea.hitSlop}
      onLayout={hitArea.onLayout}
      onPress={handlePress}
      onPressIn={(event) => { setPressed(true); onPressIn?.(event); }}
      onPressOut={(event) => { setPressed(false); onPressOut?.(event); }}
      onLongPress={isDisabled ? undefined : onLongPress}
      {...webContextMenuProps}
      onKeyDown={Platform.OS === 'web' ? handleKeyDown : undefined}
      // A finger has no hover: a touch that RNW reports as a pointer entering never paints hover
      // chrome or opens a hover tooltip.
      onHoverIn={(event: unknown) => { if (isTouchPointer(event)) return; setHovered(true); onHoverChange?.(true); }}
      onHoverOut={() => { setHovered(false); onHoverChange?.(false); }}
      onFocus={(event: unknown) => {
        if (blurCommitRef.current !== null) clearTimeout(blurCommitRef.current);
        blurCommitRef.current = null;
        setFocused(isFocusVisible(event));
        onFocusChange?.(true);
      }}
      onBlur={() => {
        if (Platform.OS === 'web') {
          if (blurCommitRef.current !== null) clearTimeout(blurCommitRef.current);
          blurCommitRef.current = setTimeout(() => {
            blurCommitRef.current = null;
            setFocused(false);
          }, 0);
        } else {
          setFocused(false);
        }
        onFocusChange?.(false);
      }}
      style={pressableStyle}
    >
      {content}
    </ReactNativePressable>
  );

  if (!overlay) return pressable;

  return (
    <View style={anchorStyle}>
      {pressable}
      {overlay(state)}
    </View>
  );
}
