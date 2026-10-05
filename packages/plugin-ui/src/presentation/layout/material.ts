/** The app's four material groups. Policy and user preferences remain host-owned. */
export type HappierMaterialRole = 'chrome' | 'sidebar' | 'content' | 'floating';

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
