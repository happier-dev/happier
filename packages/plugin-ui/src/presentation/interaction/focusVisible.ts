import { Platform, type ViewStyle } from 'react-native';

import type { HappierPortableLayerStyle } from '../portableTypes.js';

type FocusVisibleTarget = Readonly<{ matches?: (selector: string) => boolean }>;
type InputModality = 'keyboard' | 'pointer';

/** Published on `<html>` so the browser's own ring (`theme.css`) follows the same decision. */
const INPUT_MODALITY_ATTRIBUTE = 'data-happier-input-modality';
/** A modifier pressed on its own (Cmd/Ctrl-click, Shift-select) is not keyboard navigation. */
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'OS', 'Hyper', 'Super', 'CapsLock', 'Fn']);

let latestModality: InputModality | null = null;

function recordModality(modality: InputModality): void {
  // Only a change touches <html>: an attribute write there restyles the whole document.
  if (latestModality === modality) return;
  latestModality = modality;
  document.documentElement?.setAttribute(INPUT_MODALITY_ATTRIBUTE, modality);
}

/**
 * The last input type, recorded at the document before any handler runs. Browsers disagree about
 * focus that script moves right after a click: WebKit (Safari, the macOS desktop webview) does not
 * focus a clicked button, so a popover focusing its first control on open is a script focus with no
 * focused predecessor, and WebKit reports it as `:focus-visible`. Recording the input here makes the
 * decision the same in every engine.
 */
function installInputModalityRecorder(): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  const onPointer = () => recordModality('pointer');
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || MODIFIER_KEYS.has(event.key)) return;
    recordModality('keyboard');
  };
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('mousedown', onPointer, true);
  document.addEventListener('touchstart', onPointer, { capture: true, passive: true });
  document.addEventListener('keydown', onKey, true);
}

installInputModalityRecorder();

function matchesFocusVisible(target: FocusVisibleTarget | null | undefined): boolean {
  if (typeof target?.matches !== 'function') return true;
  try {
    return target.matches(':focus-visible');
  } catch {
    // An engine without `:focus-visible` cannot tell keyboard from pointer focus; show the ring.
    return true;
  }
}

/**
 * The one decision of whether a focused control shows its focus ring.
 *
 * On the web: never right after a pointer press, whatever the engine reports; otherwise the
 * browser's `:focus-visible` decides (keyboard focus shows the ring). Native focus only ever comes
 * from a keyboard or an assistive technology, so it always shows. React Native Web reports `focused`
 * for EVERY focus, including the one a mouse click leaves, so a control that paints its ring from
 * that flag alone keeps a ring after every click; route the flag through here instead.
 *
 * `target` is the focused element (a focus event's `target`). Without one, the document's active
 * element is read, which is the focused control while a focus change is being rendered.
 */
export function isHappierFocusVisible(target?: unknown): boolean {
  if (Platform.OS !== 'web') return true;
  if (latestModality === 'pointer') return false;
  if (target !== undefined && target !== null) return matchesFocusVisible(target as FocusVisibleTarget);
  if (typeof document === 'undefined') return true;
  return matchesFocusVisible(document.activeElement as FocusVisibleTarget | null);
}

/**
 * A focus flag reported by a pressable (React Native Web's `focused`) narrowed to whether its ring
 * shows: `focused && isHappierFocusVisible()`. For controls that are not a `HappierPressable`, which
 * already applies this to the `focused` it hands its style and children.
 */
export function resolveHappierFocusRingVisible(focused: boolean | undefined): boolean {
  return focused === true && isHappierFocusVisible();
}

/**
 * The one focus ring (DESIGN.md, Accessibility): 2px of the focus colour, held 2px off the control so
 * the page shows through as the gap. An outline follows the control's radius on the web and on React
 * Native's native outline props, never takes layout space, and never merges with the control's own
 * border, so it reads on every surface.
 */
export const HAPPIER_FOCUS_RING_V1 = Object.freeze({ widthPx: 2, gapPx: 2 });

/**
 * Where the ring sits. `outset` is every control. `inset` draws it inside the box with no gap, and is
 * only for a full-bleed row or tab whose container clips anything drawn outside it.
 */
export type HappierFocusRingPlacement = 'outset' | 'inset';

/**
 * The focus ring's style, or null while it does not show. `visible` is the ring decision
 * ({@link resolveHappierFocusRingVisible}, or a `HappierPressable`'s `focused`, which already is it).
 * Outline keys are outside the portable author vocabulary on purpose; this owner is the one place
 * shared controls ask for them.
 */
export function happierFocusRingStyle(input: Readonly<{
  visible: boolean;
  color: string;
  placement?: HappierFocusRingPlacement;
}>): HappierPortableLayerStyle | null {
  if (!input.visible) return null;
  const ring: ViewStyle = {
    outlineStyle: 'solid',
    outlineWidth: HAPPIER_FOCUS_RING_V1.widthPx,
    outlineColor: input.color,
    outlineOffset: input.placement === 'inset' ? -HAPPIER_FOCUS_RING_V1.widthPx : HAPPIER_FOCUS_RING_V1.gapPx,
  };
  return ring as HappierPortableLayerStyle;
}

/**
 * For a focusable that draws its ring on a child — the visible control inside a larger hit box — so
 * the browser's own ring on the focusable does not draw a second ring around the hit box. Web only:
 * native focusables paint no ring of their own.
 */
export const HAPPIER_FOCUS_RING_DELEGATED_STYLE: HappierPortableLayerStyle | null = Platform.OS === 'web'
  ? ({ outlineStyle: 'none' } as unknown as HappierPortableLayerStyle)
  : null;
