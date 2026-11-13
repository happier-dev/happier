import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';

/** The resume inventory settles catalog refusals even while a Machine projection is pending. */
export function useResumeBrowseCatalog(machineId: string | null, serverId: string | null) {
    const projection = useDaemonMergedProjectionInputs({ machineId, serverId, sections: DAEMON_AGENT_CATALOG_SECTIONS });
    const { catalog, refresh } = useAcpCatalogForServer(serverId);
    if (catalog.status !== 'ready' && catalog.status !== 'loading') {
        return { phase: 'unavailable' as const, reason: catalog.reason, catalog, projection, retry: refresh };
    }
    return { phase: catalog.status === 'loading' || projection.phase === 'loading' ? 'loading' as const : 'ready' as const,
        catalog, projection, retry: refresh };
}
