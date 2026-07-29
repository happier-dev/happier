import { CATALOG_AGENT_IDS, type CatalogAgentId } from '@/agent/catalog/ids';
import { logger } from '@/ui/logger';

async function resolveManagedServerShutdownCleanup(agentId: CatalogAgentId) {
    const { getManagedServerShutdownCleanup } = await import('./catalogHooks');
    return await getManagedServerShutdownCleanup(agentId);
}

export async function stopManagedServersOnDaemonShutdownBestEffort(): Promise<void> {
    for (const agentId of CATALOG_AGENT_IDS) {
        const cleanup = await resolveManagedServerShutdownCleanup(agentId).catch((error) => {
            logger.debug(`[DAEMON RUN] Failed to resolve managed-server shutdown cleanup for ${agentId}`, error);
            return null;
        });
        if (!cleanup) continue;

        await cleanup().catch((error) => {
            logger.debug(`[DAEMON RUN] Managed-server shutdown cleanup failed for ${agentId}`, error);
        });
    }
}
