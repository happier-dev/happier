import { DaemonPluginUiArtifactByteIdentityV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    PluginUiArtifactsManifestEntryV2Schema,
    type PluginUiArtifactsManifestEntryV2,
} from '@happier-dev/protocol/plugins/ui';

type DaemonPluginUiArtifactByteIdentity = ReturnType<typeof DaemonPluginUiArtifactByteIdentityV1Schema.parse>;

/**
 * Projected bundle entries are normalized once, frozen, and reused per entry across publications,
 * so their nested artifact facts are parsed once per object, not once per reader per resolution.
 * Every client-executable, invalidation and adoption reader goes through here.
 */
function readOncePerObject<T>(parse: (value: unknown) => T | null): (value: unknown) => T | null {
    const results = new WeakMap<object, T | null>();
    return (value) => {
        if (value === null || typeof value !== 'object') return parse(value);
        if (results.has(value)) return results.get(value) ?? null;
        const parsed = parse(value);
        results.set(value, parsed);
        return parsed;
    };
}

export const readPluginUiArtifactGraph = readOncePerObject<PluginUiArtifactsManifestEntryV2>((value) => {
    const parsed = PluginUiArtifactsManifestEntryV2Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
});

export const readDaemonPluginUiArtifactByteIdentity = readOncePerObject<DaemonPluginUiArtifactByteIdentity>((value) => {
    const parsed = DaemonPluginUiArtifactByteIdentityV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
});
