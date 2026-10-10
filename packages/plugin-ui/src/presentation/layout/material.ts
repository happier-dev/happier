import { isFlat, type HappierRaisedEdgeState } from './raisedEdge.js';
import type { HappierPortableLayerStyle } from '../portableTypes.js';

export type HappierSurfaceFinishRole = 'card' | 'floating' | 'composer' | 'primaryButton' | 'secondaryButton';
export type HappierSurfaceGradient = Readonly<{
  colors: readonly [string, string, ...string[]];
  locations?: readonly [number, number, ...number[]];
  start?: Readonly<{ x: number; y: number }>;
  end?: Readonly<{ x: number; y: number }>;
}>;

/** The single role/state policy. Gradients are ink overlays, never replacement fills. */
export function resolveHappierSurfaceFinish(input: Readonly<{
  role: HappierSurfaceFinishRole;
  finish?: 'flat' | 'soft';
  parts?: Partial<Record<HappierSurfaceFinishRole, Readonly<{ finish?: 'flat' | 'soft' }>>>;
  gradients: Partial<Record<HappierSurfaceFinishRole, HappierSurfaceGradient | null>>;
  state?: HappierRaisedEdgeState;
  nested?: boolean;
}>): HappierSurfaceGradient | null {
  if (input.nested || isFlat(input.state) || (input.parts?.[input.role]?.finish ?? input.finish ?? 'soft') === 'flat') return null;
  return input.gradients[input.role] ?? null;
}

/** CSS paints on the existing surface: no additional web element or opaque background. */
export function happierSurfaceGradientWebStyle(gradient: HappierSurfaceGradient | null | undefined, clipToPaddingBox = true): HappierPortableLayerStyle | null {
  if (!gradient) return null;
  const start = gradient.start ?? { x: 0.5, y: 0 };
  const end = gradient.end ?? { x: 0.5, y: 1 };
  const angle = Math.atan2(end.x - start.x, start.y - end.y) * 180 / Math.PI;
  const stops = gradient.colors.map((color, index) => `${color} ${(gradient.locations?.[index] ?? index / (gradient.colors.length - 1)) * 100}%`);
  return { backgroundImage: `linear-gradient(${angle < 0 ? angle + 360 : angle}deg, ${stops.join(', ')})`, ...(clipToPaddingBox ? { backgroundClip: 'padding-box' as const } : {}) };
}

/** Material G's one extra grounding step for in-flow cards. Flat retains the incumbent elevation. */
export function happierSurfaceFinishLift(gradient: HappierSurfaceGradient | null | undefined, role: HappierSurfaceFinishRole, dark: boolean, web: boolean): HappierPortableLayerStyle | null {
  if (!gradient || role !== 'card') return null;
  return web
    ? { boxShadow: dark ? '0 2px 4px -1px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.1)' : '0 2px 4px -1px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.05)' }
    : { shadowColor: '#000000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: dark ? 0.06 : 0.07, shadowRadius: 2, elevation: 2 };
}

/** The app's four material groups. Policy and user preferences remain host-owned. */
export type HappierMaterialRole = 'chrome' | 'sidebar' | 'content' | 'floating';

/** Base control gradients obey the same paint policy as their fill; finish overlays stay separate. */
export function happierMaterialGradient(gradient: HappierSurfaceGradient | null | undefined, resolveColor: (color: string) => string): HappierSurfaceGradient | null | undefined {
  if (!gradient) return gradient;
  const [first, second, ...rest] = gradient.colors;
  const colors = [resolveColor(first), resolveColor(second), ...rest.map(color => resolveColor(color))] as const;
  return colors.every((color, index) => color === gradient.colors[index]) ? gradient : { ...gradient, colors };
}

/** An inner control chooses ink over glass, while the same solid surface keeps its exact authored fill. */
export function happierMaterialInnerBackgroundColor(baseColor: string, translucentColor: string, role: HappierMaterialRole, web: boolean): string {
  if (!web || baseColor === 'transparent' || /^(?:rgba\(|hsla\(|#[\da-f]{8}$)/iu.test(baseColor)) return baseColor;
  const prefix = `--happier-glass-${role}-nested-`;
  return `var(${prefix}inner-background-color, color-mix(in srgb, ${baseColor} var(${prefix}opacity, 100%), ${translucentColor}))`;
}

/**
 * Apply the host's material opacity to the background paint only. Native
 * materials are rendered by the host; missing web policy keeps the base color.
 * Nested coats consume their own host projection so they do not accumulate tint.
 */
export function happierMaterialBackgroundColor(
  baseColor: string,
  role: HappierMaterialRole,
  web: boolean,
  nested = false,
): string {
  if (!web) return baseColor;
  const prefix = `--happier-glass-${role}-${nested ? 'nested-' : ''}`;
  const color = `color-mix(in srgb, ${baseColor} var(${prefix}opacity, 100%), transparent)`;
  // RNW admits CSS variable colors but drops bare color-mix(). The unset
  // background variable lets its CSS fallback carry the real opacity paint.
  return `var(${prefix}background-color, ${color})`;
}
