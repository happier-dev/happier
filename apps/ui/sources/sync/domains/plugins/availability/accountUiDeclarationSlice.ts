import type { PluginUiProjectionModel } from '../ui/projection';

/** Patch one producer-owned declaration while preserving every unrelated row and family. */
export function replaceAccountUiDeclarationSlice(
    previous: PluginUiProjectionModel | null,
    next: PluginUiProjectionModel | null,
    pluginId: string,
): PluginUiProjectionModel | null {
    if (!previous) return next;
    const updates: Record<string, unknown> = {};
    for (const [family, value] of Object.entries(previous)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const rows = value as Readonly<Record<string, unknown>>;
        const replacement = next?.[family as keyof PluginUiProjectionModel];
        const incoming = replacement && typeof replacement === 'object' && !Array.isArray(replacement)
            ? replacement as Readonly<Record<string, unknown>> : {};
        let changed: Record<string, unknown> | undefined;
        for (const [id, row] of Object.entries(rows)) {
            const owned = id === pluginId || id.startsWith(`${pluginId}/`)
                || row !== null && typeof row === 'object' && 'pluginId' in row && row.pluginId === pluginId;
            if (!owned || row === incoming[id]) continue;
            changed ??= { ...rows };
            delete changed[id];
        }
        for (const [id, row] of Object.entries(incoming)) {
            if (rows[id] === row) continue;
            changed ??= { ...rows };
            changed[id] = row;
        }
        if (changed) updates[family] = Object.freeze(changed);
    }
    return Object.keys(updates).length === 0 ? previous : Object.freeze({ ...previous, ...updates });
}
