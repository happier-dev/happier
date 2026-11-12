import type { RegistryKindV1, RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { useRegistryListSourceSelection } from './useRegistrySourceRevision';
import { useRegistryActionRead } from './useRegistryActionRead';

const EMPTY_SOURCES: readonly RegistrySourceDescriptorV1[] = [];
export function useRegistrySources(kind?: RegistryKindV1, enabled = true) {
    const selection = useRegistryListSourceSelection(undefined, enabled);
    const read = useRegistryActionRead('registries.sources.list', kind ? { kind } : {}, value => value, selection.revision, enabled, { resolving: selection.resolving });
    return { sources: read.value?.sources ?? EMPTY_SOURCES, hasValue: read.value !== null,
        loading: read.loading, error: read.error,
        failureStatus: read.status,
        status: read.error ? 'unavailable' as const : read.value ? 'ready' as const : 'loading' as const, refresh: read.refresh };
}
