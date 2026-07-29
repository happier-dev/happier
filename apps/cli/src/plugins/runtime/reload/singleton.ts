import { createPluginReloadController } from './controller';

export const pluginReloadController = createPluginReloadController({
    invalidateCaches: async () => {
        const { invalidateDaemonContributionRegistryProjectionCache } = await import('../../../rpc/handlers/daemonContributionRegistryProjection');
        invalidateDaemonContributionRegistryProjectionCache();
    },
});
