import { createPluginReloadController } from './controller';

export const pluginReloadController = createPluginReloadController({
    invalidateCaches: async () => {
        const { invalidateDaemonContributionRegistryProjectionCache } = await import('../../../rpc/handlers/daemonContributionRegistryProjection');
        invalidateDaemonContributionRegistryProjectionCache();
    },
    dispatchReloadHookEvent: async (event) => {
        const { dispatchPluginReloadHookEvent } = await import('../hooks/execution/dispatchPluginReloadHookEvent');
        await dispatchPluginReloadHookEvent(event);
    },
    publishInstalledManifestProjections: async (params) => {
        const { publishInstalledPluginManifestProjectionsToServer } = await import('../../projection/server/installedManifests');
        await publishInstalledPluginManifestProjectionsToServer(params);
    },
});
