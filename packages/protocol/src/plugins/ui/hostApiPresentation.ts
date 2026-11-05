import type { PluginUiJsonValueV1 } from '../contributions/ui/json.js';
import { PLUGIN_UI_HOST_API_BASE_VERSION_V1 } from './hostApiDefinition.js';

function isObject(value: PluginUiJsonValueV1 | undefined): value is { [key: string]: PluginUiJsonValueV1 } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The installed API 1.0 reader has a closed theme and predates statusTint
 * (acme.composer.issue-dogfood generation gen-1793077265101-21aacbc2-c69c-4e95-8f7d-bb0700078817).
 * Project only these later disclosures, preserving existing identity/authority.
 * Call only for a context result or a registered watchContext event; arbitrary
 * Resource JSON may deliberately have an identical shape and stays untouched.
 * Retire this projection only when support for that API generation is removed.
 */
export function projectPluginUiRenderContextForHostApiVersionV1(
  value: PluginUiJsonValueV1 | undefined,
  version: string | undefined,
): PluginUiJsonValueV1 | undefined {
  if (version !== PLUGIN_UI_HOST_API_BASE_VERSION_V1 || !isObject(value)) return value;
  const surface = value.surface;
  if (!isObject(surface)) return value;
  let projectedSurface = surface;
  const theme = surface.theme;
  if (isObject(theme) && Object.hasOwn(theme, 'statusTint')) {
    const { statusTint: _statusTint, ...legacyTheme } = theme;
    projectedSurface = { ...projectedSurface, theme: legacyTheme };
  }
  return projectedSurface === surface ? value : { ...value, surface: projectedSurface };
}
