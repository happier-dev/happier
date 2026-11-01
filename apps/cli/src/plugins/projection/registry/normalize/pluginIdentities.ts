/** One plugin identity may contribute once to a reference universe. */
export function assertUniquePluginIdentities(plugins: readonly Readonly<{ pluginId: string }>[]): void {
  const seenPluginIds = new Set<string>();
  for (const plugin of plugins) {
    if (seenPluginIds.has(plugin.pluginId)) {
      throw new Error(`Duplicate plugin identity '${plugin.pluginId}' in contribution reference universe`);
    }
    seenPluginIds.add(plugin.pluginId);
  }
}

/** A selected source replaces its fallback identity, never another selected source. */
export function excludeReplacedPluginIdentities<T extends Readonly<{ pluginId: string }>>(
  fallback: readonly T[],
  selected: readonly Readonly<{ pluginId: string }>[],
): readonly T[] {
  assertUniquePluginIdentities(fallback);
  assertUniquePluginIdentities(selected);
  const selectedIds = new Set(selected.map(plugin => plugin.pluginId));
  return fallback.filter(plugin => !selectedIds.has(plugin.pluginId));
}
