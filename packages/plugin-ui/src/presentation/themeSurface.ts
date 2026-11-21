import type { PluginUiThemeV1, SurfaceAddress } from '@happier-dev/plugin-sdk/ui';

export type { SurfaceAddress };

/** Explicit addresses for the existing selection anatomy; callers choose its semantic surface. */
export type ThemeSelectionSurfaceBinding = Readonly<{
  root: SurfaceAddress;
  row: SurfaceAddress;
  label?: SurfaceAddress;
  sectionTitle?: SurfaceAddress;
}>;

/** Read the host compiler's mode-resolved table; web keeps its CSS cascade. */
export function resolveHappierThemeSurfaceStyle(
  theme: Pick<PluginUiThemeV1, 'surfaces'> | null,
  address: SurfaceAddress,
  platform: string,
) {
  if (platform === 'web') return undefined;
  const part = theme?.surfaces?.[address.surface]?.[address.part];
  return part?.states[address.state ?? 'default'] ?? part?.base;
}
