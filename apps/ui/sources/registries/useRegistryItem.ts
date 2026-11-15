import type { RegistryKindV1, RegistryAppMappingV1 } from '@happier-dev/protocol/registries';
import { useRegistryActionRead } from './useRegistryActionRead';
import { useRegistrySourceRevision } from './useRegistrySourceRevision';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export function useRegistryItem(input: { kind: RegistryKindV1; sourceId: string; itemId: string; version?: string; appMappingCorrection?: RegistryAppMappingV1 }, enabled = true, options?: Readonly<{ installMachineId?: string | null; scope?: ServerAccountScope }>) {
    const revision = useRegistrySourceRevision(enabled, [input.sourceId]);
    const read = useRegistryActionRead('registries.items.read', input, value => value, revision, enabled && Boolean(input.sourceId), { sourceIds: [input.sourceId], installMachineId: options?.installMachineId, ...(options?.scope ? { scope: options.scope } : {}) });
    return { item: read.value?.item ?? null, loading: read.loading, stale: read.stale, error: read.error, status: read.status, refresh: read.refresh };
}
