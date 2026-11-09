import type { RegistryKindV1 } from '@happier-dev/protocol/registries';
import { useRegistryActionRead } from './useRegistryActionRead';
import { useRegistrySourceRevision } from './useRegistrySourceRevision';

export function useRegistryItem(input: { kind: RegistryKindV1; sourceId: string; itemId: string; version?: string }, enabled = true) {
    const revision = useRegistrySourceRevision(enabled, [input.sourceId]);
    const read = useRegistryActionRead('registries.items.read', input, value => value, revision, enabled && Boolean(input.sourceId), { sourceIds: [input.sourceId] });
    return { item: read.value?.item ?? null, loading: read.loading, stale: read.stale, error: read.error, status: read.status, refresh: read.refresh };
}
