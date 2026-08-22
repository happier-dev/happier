import {
    PluginRuntimeCapabilityFamilyV1Schema,
    type PluginRuntimeCapabilityFamilyV1,
} from '@happier-dev/protocol';

export type PluginRuntimeAuthoritySnapshotV1 = Readonly<{
    runtimeCapabilities: readonly PluginRuntimeCapabilityFamilyV1[];
}>;

type RuntimeAuthorityRegistryProjection = Readonly<{
    runtimeCapabilitiesByPluginId?: ReadonlyMap<string, ReadonlySet<string>>;
}>;

export function snapshotActivatedPluginRuntimeAuthority(
    registry: RuntimeAuthorityRegistryProjection | null,
    pluginId: string,
): PluginRuntimeAuthoritySnapshotV1 | null {
    const runtimeCapabilities =
        registry?.runtimeCapabilitiesByPluginId?.get(pluginId);
    if (!runtimeCapabilities) return null;
    return Object.freeze({
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
    capabilities: ReadonlySet<string>;
}> {
    return Object.freeze({
        capabilities: new Set(authority?.runtimeCapabilities ?? []),
    });
}
