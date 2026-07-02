type PluginUiProjectionEntry = Readonly<Record<string, unknown>>;

const DEFERRED_POLICY_FIELDS = [
    'visibility',
    'enabled',
    'featureGate',
    'compatibility',
] as const;

export function hasDeferredPluginUiPolicy(
    entry: PluginUiProjectionEntry | null | undefined,
): boolean {
    if (!entry) {
        return false;
    }
    return DEFERRED_POLICY_FIELDS.some((field) => entry[field] !== undefined);
}

export function canRenderPluginUiProjectionEntry(
    entry: PluginUiProjectionEntry | null | undefined,
): boolean {
    return !hasDeferredPluginUiPolicy(entry);
}
