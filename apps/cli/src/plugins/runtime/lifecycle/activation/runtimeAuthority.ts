import {
    PluginPermissionCapabilityV1Schema,
    PluginRuntimeCapabilityFamilyV1Schema,
    type PluginPermissionCapabilityV1,
    type PluginRuntimeCapabilityFamilyV1,
} from '@happier-dev/protocol';

export type PluginRuntimeAuthoritySnapshotV1 = Readonly<{
    permissions: readonly PluginPermissionCapabilityV1[];
    runtimeCapabilities: readonly PluginRuntimeCapabilityFamilyV1[];
}>;

type RuntimeAuthorityRegistryProjection = Readonly<{
    permissionsByPluginId?: ReadonlyMap<
        string,
        ReadonlySet<PluginPermissionCapabilityV1>
    >;
    runtimeCapabilitiesByPluginId?: ReadonlyMap<string, ReadonlySet<string>>;
}>;

export function snapshotActivatedPluginRuntimeAuthority(
    registry: RuntimeAuthorityRegistryProjection | null,
    pluginId: string,
): PluginRuntimeAuthoritySnapshotV1 | null {
    const permissions = registry?.permissionsByPluginId?.get(pluginId);
    const runtimeCapabilities =
        registry?.runtimeCapabilitiesByPluginId?.get(pluginId);
    if (!permissions || !runtimeCapabilities) return null;
    return Object.freeze({
        permissions: Object.freeze(
            PluginPermissionCapabilityV1Schema.array().parse(
                [...permissions].sort(),
            ),
        ),
        runtimeCapabilities: Object.freeze(
            PluginRuntimeCapabilityFamilyV1Schema.array().parse(
                [...runtimeCapabilities].sort(),
            ),
        ),
    });
}

export function materializePluginRuntimeAuthority(
    authority: PluginRuntimeAuthoritySnapshotV1 | null | undefined,
): Readonly<{
    permissions: ReadonlySet<string>;
    capabilities: ReadonlySet<string>;
}> {
    const permissions = new Set(authority?.permissions ?? []);
    return Object.freeze({
        permissions,
        capabilities: new Set([
            ...permissions,
            ...(authority?.runtimeCapabilities ?? []),
        ]),
    });
}
