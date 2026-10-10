/**
 * The raised edge: the one-pixel lip that makes a bordered control or surface read as standing a hair
 * above the page. A dark theme lights the top edge; a light theme darkens the bottom lip instead,
 * because a darker *top* reads as pressed in. The edge is that one side of the element's own border
 * drawn in a raised colour, so it sits exactly on the border line on every platform React Native
 * renders to (per-side border colours), never as a second line beside it.
 *
 * Colours come from the host theme (Happier derives them from each theme's own border and ink, so a
 * custom theme gets its own edge); this module owns which side carries it and which states drop it.
 * A control's edge travels with its low elevation (`lift`): both belong to "standing", so a pressed,
 * disabled, focused or invalid control loses both at once.
 */

import type { HappierPortableLayerStyle } from '../portableTypes.js';

/** Which side of a raised element carries its edge. */
export type HappierRaisedEdgeSide = 'top' | 'bottom';

/**
 * The side per colour scheme — the single place to flip it. Dark: a lit top. Light: a shaded bottom lip.
 */
export const HAPPIER_RAISED_EDGE_SIDE: Readonly<Record<'light' | 'dark', HappierRaisedEdgeSide>> = Object.freeze({
  light: 'bottom',
  dark: 'top',
});

/** A resolved edge: the side, the colour that side of the border takes, and the elevation paired with it. */
export type HappierRaisedEdge = Readonly<{
  side: HappierRaisedEdgeSide;
  color: string;
  /** The host's low elevation (shadow) a raised control stands on; surfaces carry their own elevation. */
  lift?: HappierPortableLayerStyle;
}>;

/**
 * The interaction states of a control. A pressed, disabled or keyboard-focused control sits flat (the
 * focus ring replaces the edge), and so does an invalid field (its danger border speaks alone).
 */
export type HappierRaisedEdgeState = Readonly<{
  pressed?: boolean;
  disabled?: boolean;
  focused?: boolean;
  invalid?: boolean;
}>;

export function isFlat(state: HappierRaisedEdgeState | undefined): boolean {
  return state !== undefined && (state.pressed === true || state.disabled === true || state.focused === true || state.invalid === true);
}

/**
 * The raised edge of a bordered control or surface in this colour scheme, or `null` while the state
 * sits flat.
 */
export function resolveHappierRaisedEdge(input: Readonly<{
  colorScheme: 'light' | 'dark';
  /** The raised colour of the element's border role (the host theme's `edge.*`). */
  color: string;
  lift?: HappierPortableLayerStyle;
  state?: HappierRaisedEdgeState;
}>): HappierRaisedEdge | null {
  if (isFlat(input.state)) return null;
  const side = HAPPIER_RAISED_EDGE_SIDE[input.colorScheme];
  return input.lift ? { side, color: input.color, lift: input.lift } : { side, color: input.color };
}

/**
 * The gloss of a filled accent control (primary, destructive): a light top line inside the fill in
 * every scheme — light catches the top of a filled button whichever way the page is lit. Flat while
 * pressed or disabled, like the edge.
 */
export function resolveHappierGloss(input: Readonly<{
  color: string;
  lift?: HappierPortableLayerStyle;
  state?: HappierRaisedEdgeState;
}>): HappierRaisedEdge | null {
  if (isFlat(input.state)) return null;
  return input.lift ? { side: 'top', color: input.color, lift: input.lift } : { side: 'top', color: input.color };
}

/**
 * A host-resolved edge (a palette role) in this state: the same edge while the control stands, `null`
 * once it sits flat.
 */
export function settleHappierRaisedEdge(
  edge: HappierRaisedEdge | null | undefined,
  state: HappierRaisedEdgeState,
): HappierRaisedEdge | null {
  return edge && !isFlat(state) ? edge : null;
}

/**
 * The style an edge (or gloss) contributes — that side's border colour, plus its lift — to spread after
 * the element's own border colour.
 */
export function happierRaisedEdgeStyle(edge: HappierRaisedEdge | null | undefined): HappierPortableLayerStyle | null {
  if (!edge) return null;
  const side = edge.side === 'top' ? { borderTopColor: edge.color } : { borderBottomColor: edge.color };
  return edge.lift ? { ...edge.lift, ...side } : side;
}
