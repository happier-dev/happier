/**
 * Released 0.2 plugin Account preferences used opaque root Settings keys.
 * Scoped plugin records now own writes; a current host-owned key must never
 * be borrowed by a plugin simply because it declares a field with that name.
 * Callers supply their canonical host defaults rather than copying a key list.
 */
export function isReleasedFlatPluginSettingKey(params: Readonly<{
    localId: string;
    hostDefaults: Readonly<Record<string, unknown>>;
}>): boolean {
    const localId = params.localId.trim();
    return localId.length > 0 && !Object.hasOwn(params.hostDefaults, localId);
}

export function readReleasedFlatPluginSettingValue(params: Readonly<{
    settings: Readonly<Record<string, unknown>> | null | undefined;
    localId: string;
    hostDefaults: Readonly<Record<string, unknown>>;
}>): unknown {
    const localId = params.localId.trim();
    if (!isReleasedFlatPluginSettingKey({ localId, hostDefaults: params.hostDefaults })) return undefined;
    const settings = params.settings;
    if (!settings || typeof settings !== 'object' || !Object.hasOwn(settings, localId)) return undefined;
    return settings[localId];
}
