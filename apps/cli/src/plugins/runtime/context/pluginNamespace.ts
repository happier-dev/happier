export function normalizePluginStorageNamespace(pluginId: string): string {
    const trimmed = pluginId.trim();
    if (!trimmed) {
        return 'unknown';
    }
    return trimmed
        .replace(/[\\/]/g, '_')
        .replace(/\.\.+/g, '_')
        .replace(/[^a-zA-Z0-9._@-]/g, '_');
}
