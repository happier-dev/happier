import type { PluginContributionIdentityV1 } from '../../contributionIdentity.js';
import { PLUGIN_UI_INLINE_SURFACE_SLOTS_V1, type PluginUiInlineSurfaceBindingV1, type PluginUiSurfaceBindingV1 } from './surfaceRegistry.js';

/** Read already-admitted projection rows; physical hosts are never an inventory filter. */
export function selectPluginUiWidgetEntriesV1<T extends Readonly<{ id: string; binding?: PluginUiSurfaceBindingV1 }>>(
  entries: readonly T[],
  options?: Readonly<{ surface?: PluginContributionIdentityV1; targetKind?: 'session' | 'app' }>,
): readonly (T & Readonly<{ binding: PluginUiInlineSurfaceBindingV1 }>)[] {
  return Object.freeze(entries.filter((entry): entry is T & Readonly<{ binding: PluginUiInlineSurfaceBindingV1 }> => {
    const binding = entry.binding;
    return binding?.kind === 'inline' && binding.role === PLUGIN_UI_INLINE_SURFACE_SLOTS_V1.widget.role
      && (options?.targetKind === undefined || binding.targetKind === options.targetKind)
      && (options?.surface === undefined || (binding.surface.pluginId === options.surface.pluginId
        && binding.surface.localId === options.surface.localId));
  }).sort((left, right) => left.id.localeCompare(right.id)));
}
