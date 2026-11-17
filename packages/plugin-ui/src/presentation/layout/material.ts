import { isFlat, type HappierRaisedEdgeState } from './raisedEdge.js';
import type { HappierPortableLayerStyle } from '../portableTypes.js';

export type HappierSurfaceFinishRole = 'card' | 'floating' | 'composer' | 'primaryButton' | 'secondaryButton';
export type HappierSurfaceGradient = Readonly<{
  colors: readonly [string, string, ...string[]];
  locations?: readonly [number, number, ...number[]];
  start?: Readonly<{ x: number; y: number }>;
  end?: Readonly<{ x: number; y: number }>;
  /** Paints the stops only in a fixed-height strip along one edge, so a tall surface keeps a flat middle. */
  band?: Readonly<{ edge: 'top' | 'bottom'; height: number }>;
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

/** CSS gradient geometry shared by web paint and Android's native background image. */
export function happierSurfaceGradientCssParts(gradient: HappierSurfaceGradient): Readonly<{
  angle: number;
  stops: readonly Readonly<{ color: string; percent: number }>[];
}> {
  const start = gradient.start ?? { x: 0.5, y: 0 };
  const end = gradient.end ?? { x: 0.5, y: 1 };
  const angle = Math.atan2(end.x - start.x, start.y - end.y) * 180 / Math.PI;
  return {
    angle: angle < 0 ? angle + 360 : angle,
    stops: gradient.colors.map((color, index) => ({ color, percent: (gradient.locations?.[index] ?? index / (gradient.colors.length - 1)) * 100 })),
  };
}

/** CSS paints on the existing surface: no additional web element or opaque background. */
export function happierSurfaceGradientWebStyle(gradient: HappierSurfaceGradient | null | undefined, clipToPaddingBox = true): HappierPortableLayerStyle | null {
  if (!gradient) return null;
  const { angle, stops: parts } = happierSurfaceGradientCssParts(gradient);
  const stops = parts.map(({ color, percent }) => `${color} ${percent}%`);
  return { backgroundImage: `linear-gradient(${angle}deg, ${stops.join(', ')})`, ...(clipToPaddingBox ? { backgroundClip: 'padding-box' as const } : {}),
    ...(gradient.band ? { backgroundSize: `100% ${gradient.band.height}px`, backgroundPosition: gradient.band.edge, backgroundRepeat: 'no-repeat' as const } : {}) };
}

/**
 * Material G's one extra grounding step for in-flow cards on dark. A light card stands on its host's own
 * card grounding whether Soft or Flat (W3: the faintest trace of each cue), so light adds no lift here.
 */
export function happierSurfaceFinishLift(gradient: HappierSurfaceGradient | null | undefined, role: HappierSurfaceFinishRole, dark: boolean, web: boolean): HappierPortableLayerStyle | null {
  if (!gradient || role !== 'card' || !dark) return null;
  return web
    ? { boxShadow: '0 2px 4px -1px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.1)' }
    : { shadowColor: '#000000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 2, elevation: 2 };
}

/** The app's material groups. Policy and user preferences remain host-owned. */
export type HappierMaterialRole = 'chrome' | 'sidebar' | 'content' | 'card' | 'floating';

/** Base control gradients obey the same paint policy as their fill; finish overlays stay separate. */
export function happierMaterialGradient(gradient: HappierSurfaceGradient | null | undefined, resolveColor: (color: string) => string): HappierSurfaceGradient | null | undefined {
  if (!gradient) return gradient;
  const [first, second, ...rest] = gradient.colors;
  const colors = [resolveColor(first), resolveColor(second), ...rest.map(color => resolveColor(color))] as const;
  return colors.every((color, index) => color === gradient.colors[index]) ? gradient : { ...gradient, colors };
}

/** An inner control chooses ink over glass, while the same solid surface keeps its exact authored fill. */
export function happierMaterialInnerBackgroundColor(baseColor: string, translucentColor: string, role: HappierMaterialRole, web: boolean, authoredTranslucent?: boolean): string {
  return happierMaterialInnerBackgroundPaint(baseColor, translucentColor, role, web, color => color,
    (inputs, calculate) => calculate(...inputs), authoredTranslucent);
}

/** Preserve the selected input alongside its paint, including the authored-alpha branch. */
export function happierMaterialInnerBackgroundPaint<T>(base: T, translucent: T, role: HappierMaterialRole, web: boolean,
  readColor: (paint: T) => string,
  derive: (inputs: readonly [T, T], calculate: (base: string, translucent: string) => string) => T,
  authoredTranslucent?: boolean): T {
  const baseColor = readColor(base);
  // A host that resolved a theme token can supply its actual alpha instead of the syntax hint.
  if (!web || baseColor === 'transparent' || (authoredTranslucent ?? /^(?:rgba\(|hsla\(|#[\da-f]{8}$)/iu.test(baseColor))) return base;
  const prefix = `--happier-glass-${role}-nested-`;
  return derive([base, translucent], (baseColor, translucentColor) =>
    `var(${prefix}inner-background-color, color-mix(in srgb, ${baseColor} var(${prefix}opacity, 100%), ${translucentColor}))`);
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
  return happierMaterialBackgroundPaint(baseColor, role, web, nested,
    (inputs, calculate) => calculate(...inputs));
}

export function happierMaterialBackgroundPaint<T>(base: T, role: HappierMaterialRole, web: boolean, nested: boolean,
  derive: (inputs: readonly [T], calculate: (base: string) => string) => T): T {
  if (!web) return base;
  const prefix = `--happier-glass-${role}-${nested ? 'nested-' : ''}`;
  // RNW admits CSS variable colors but drops bare color-mix(). The unset
  // background variable lets its CSS fallback carry the real opacity paint.
  return derive([base], baseColor => {
    const color = `color-mix(in srgb, ${baseColor} var(${prefix}opacity, 100%), transparent)`;
    return `var(${prefix}background-color, ${color})`;
  });
}
