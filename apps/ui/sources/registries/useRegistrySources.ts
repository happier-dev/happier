import type { RegistryKindV1, RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { useRegistrySourceRevision } from './useRegistrySourceRevision';
import { useRegistryActionRead } from './useRegistryActionRead';

const parse = (value: unknown) => REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(value);
const EMPTY_SOURCES: readonly RegistrySourceDescriptorV1[] = [];
export function useRegistrySources(kind?: RegistryKindV1, enabled = true) {
    const revision = useRegistrySourceRevision(enabled);
    const read = useRegistryActionRead('registries.sources.list', kind ? { kind } : {}, parse, revision, enabled);
    return { sources: read.value?.sources ?? EMPTY_SOURCES, hasValue: read.value !== null, loading: read.loading, error: read.error,
        status: read.error ? 'unavailable' as const : read.value ? 'ready' as const : 'loading' as const, refresh: read.refresh };
}
