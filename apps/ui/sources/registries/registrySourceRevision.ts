import type { RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';

/** A read consumes source configuration, not the containing Account row's revision. */
export function registrySourceRevision(sources: readonly RegistrySourceDescriptorV1[], sourceIds?: readonly string[]): string {
    const selected = sourceIds === undefined ? null : new Set(sourceIds);
    return JSON.stringify(selected === null ? sources : sources.filter(source => selected.has(source.id)));
}
