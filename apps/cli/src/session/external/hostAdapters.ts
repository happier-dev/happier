import { readBuiltInHostCatalogEntries } from '@/backends/builtInHostCatalogEntries';
import type {
    ExternalSessionRuntimeHostAdapterParams,
    ExternalSessionRuntimeHostAdapters,
} from '@/backends/types';

export async function resolveExternalSessionRuntimeHostAdapters(
    params: ExternalSessionRuntimeHostAdapterParams,
): Promise<ExternalSessionRuntimeHostAdapters> {
    const adapterSets = await Promise.all(
        Object.values(readBuiltInHostCatalogEntries()).map(async (entry) => {
            if (!entry?.getExternalSessionRuntimeHostAdapters) return null;
            return await entry.getExternalSessionRuntimeHostAdapters(params);
        }),
    );
    return Object.freeze({
        transcriptStores: Object.freeze(adapterSets.flatMap((set) => set?.transcriptStores ?? [])),
        candidateHosts: Object.freeze(adapterSets.flatMap((set) => set?.candidateHosts ?? [])),
    });
}
