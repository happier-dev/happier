import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, type IconName } from './Icon';

/**
 * Shell chrome's one glyph ink (owner 2026-11-10: the area around the page stays quiet). Every chrome
 * glyph — the app rail, the title strip, the tab strip, the right utility rail, a pane or session
 * header's actions — rests in the secondary ink drawn at this opacity, and comes up to the primary ink
 * while it is the open destination, or hovered, pressed or keyboard-focused. At rest it stays above 3:1
 * against the rail in light and dark (non-text UI minimum, WCAG 1.4.11); `text.tertiary` falls under it
 * on the light rail.
 */
const CHROME_GLYPH_REST_OPACITY = 0.8;
const REST_STYLE = Object.freeze({ opacity: CHROME_GLYPH_REST_OPACITY });

/**
 * Whether the control a glyph stands in is under the pointer, pressed, keyboard-focused or selected.
 * `IconButton` provides it from its pressable's own state, so glyphs need no second hover state.
 */
export const ChromeGlyphEmphasisContext = React.createContext(false);

export type ChromeGlyphInk = Readonly<{
  color: string;
  style?: typeof REST_STYLE;
}>;

/** The chrome glyph's ink: quiet at rest, the primary ink while `active` or while its control is engaged. */
export function useChromeGlyphInk(active = false): ChromeGlyphInk {
  const engaged = React.useContext(ChromeGlyphEmphasisContext);
  const { theme } = useUnistyles();
  return active || engaged
    ? { color: theme.colors.text.primary }
    : { color: theme.colors.text.secondary, style: REST_STYLE };
}

/** A chrome glyph in the chrome ink. `children` draws a non-seam glyph (a sidebar toggle) in the same ink. */
export function ChromeGlyph(
  props: Readonly<
    {
      size: number;
      active?: boolean;
      weight?: React.ComponentProps<typeof Icon>['weight'];
    } & (
      | { name: IconName; children?: never }
      | { name?: never; children: (ink: ChromeGlyphInk) => React.ReactNode }
    )
  >,
) {
  const ink = useChromeGlyphInk(props.active === true);
  if (props.children) return <>{props.children(ink)}</>;
  return (
    <Icon
      name={props.name!}
      size={props.size}
      weight={props.weight}
      color={ink.color}
      style={ink.style}
    />
  );
}
