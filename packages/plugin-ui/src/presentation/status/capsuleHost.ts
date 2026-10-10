import type { ComponentType, ReactNode } from 'react';

import type { HappierPortableStyle } from '../portableTypes.js';

/** The glyphs the floating surface primitives draw; the host maps each to its icon pack. */
export type HappierSurfaceGlyph = 'hand' | 'warning' | 'sparkle' | 'pointer';

export type HappierSurfaceGlyphRenderer = (glyph: HappierSurfaceGlyph, color: string, size: number) => ReactNode;

/** `primary` is the filled action, `secondary` the bordered one, `plain` a bare text action. */
export type HappierCapsuleButtonEmphasis = 'primary' | 'secondary' | 'plain';

/**
 * What a floating capsule (`HappierStatusCapsule`, `HappierPresenceCapsule`) asks its host to draw.
 *
 * The capsule owns its geometry, states, copy placement, semantics and test ids; the host supplies
 * only the leaves that belong to the runtime: the floating material (Happier: its glass panel), the
 * type face of each text role (app font scale), the small inline button, the spinner, the icon pack
 * and, optionally, the morph between states. The same capsule therefore renders in Happier core and in
 * a plugin surface, each with its own runtime leaves.
 */
export type HappierCapsuleHost = Readonly<{
  /**
   * The floating material. `low` sits over a page as a quiet note; `high` floats the presence capsule.
   * With `reshape`, the material is drawn behind the content and travels to the content's new size when
   * it changes (the content itself lays out at once); `testID` then names the content box. With
   * `fill`, the material is only a backing: it fills the box it is placed in and holds no content.
   */
  Surface: ComponentType<Readonly<{ elevation: 'low' | 'high'; reshape?: boolean; fill?: boolean; testID: string; children: ReactNode }>>;
  /**
   * Places a docked capsule on the edge of the surface it narrates and owns its arrival and its leave
   * (Happier: the overlay motion its popovers use). It stays mounted while it leaves and renders
   * `children(true)`; a leaving dock takes no presses and is hidden from assistive technology. Absent,
   * the capsule appears and disappears at once.
   */
  Dock?: ComponentType<Readonly<{
    visible: boolean;
    /** The frame edge the capsule stands on, which it arrives from and leaves into. */
    edge: 'top' | 'bottom';
    style: HappierPortableStyle;
    children: (leaving: boolean) => ReactNode;
  }>>;
  /**
   * One run of capsule text. `title` and `meta` are the row title and row meta type roles; a run with
   * no role only lays out the runs nested in it (one line holding a title and its meta).
   */
  Text: ComponentType<Readonly<{
    role?: 'title' | 'meta';
    color?: string;
    numberOfLines?: number;
    style?: HappierPortableStyle;
    children: ReactNode;
  }>>;
  /** The capsule's small inline action. */
  Button: ComponentType<Readonly<{
    title: string;
    emphasis: HappierCapsuleButtonEmphasis;
    onPress: () => void;
    loading?: boolean;
    leading?: ReactNode;
    testID: string;
  }>>;
  Spinner: ComponentType<Readonly<{ color: string }>>;
  renderGlyph: HappierSurfaceGlyphRenderer;
  /**
   * Morphs the capsule in place when its state changes (agent → stopping → you have control). The host
   * owns the motion and its reduced-motion fallback; absent, a change lands at once.
   */
  Morph?: ComponentType<Readonly<{ stateKey: string; children: ReactNode }>>;
}>;

/** The themed colour roles a floating capsule draws with (Happier passes its exact tokens). */
export type HappierCapsuleColors = Readonly<{
  /** A title, and the status capsule's sentence. */
  text: string;
  /** A meta line and the spinner. */
  secondaryText: string;
  /** The line that must be read whole (an action whose effect is unknown). */
  warning: string;
  /** The round plate behind the presence capsule's mark. */
  /** The in-flow strip's ground and hairline edge. */
  stripBackground: string;
  stripBorder: string;
}>;
