import type { RegistryKindV1, RegistryAppMappingV1 } from '@happier-dev/protocol/registries';
import { useRegistryActionRead } from './useRegistryActionRead';
import { useRegistrySourceRevision } from './useRegistrySourceRevision';

export function useRegistryItem(input: { kind: RegistryKindV1; sourceId: string; itemId: string; version?: string; appMappingCorrection?: RegistryAppMappingV1 }, enabled = true, options?: Readonly<{ installMachineId?: string | null }>) {
    const revision = useRegistrySourceRevision(enabled, [input.sourceId]);
    const read = useRegistryActionRead('registries.items.read', input, value => value, revision, enabled && Boolean(input.sourceId), { sourceIds: [input.sourceId], installMachineId: options?.installMachineId });
    return { item: read.value?.item ?? null, loading: read.loading, stale: read.stale, error: read.error, status: read.status, refresh: read.refresh };
}
