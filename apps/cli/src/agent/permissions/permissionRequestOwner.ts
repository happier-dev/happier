export type PermissionRequestOwner = Readonly<{
    kind: 'plugin';
    pluginId: string;
    runtimeId?: string;
}>;

export function normalizePermissionRequestOwner(value: unknown): PermissionRequestOwner | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.kind !== 'plugin') return null;
    const pluginId = typeof record.pluginId === 'string' ? record.pluginId.trim() : '';
    if (!pluginId) return null;
    const runtimeId = typeof record.runtimeId === 'string' ? record.runtimeId.trim() : '';
    return Object.freeze({
        kind: 'plugin',
        pluginId,
        ...(runtimeId ? { runtimeId } : {}),
    });
}

export function isPermissionRequestOwnedByPlugin(
    owner: PermissionRequestOwner | null | undefined,
    pluginId: string,
): boolean {
    const normalizedPluginId = pluginId.trim();
    return Boolean(
        normalizedPluginId
        && owner
        && owner.kind === 'plugin'
        && owner.pluginId === normalizedPluginId,
    );
}
