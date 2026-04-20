import { invalidateDaemonContributionRegistryProjectionCache } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { dispatchPluginReloadHookEvent } from '@/extensions/hooks/execution/dispatchPluginReloadHookEvent';

import { createPluginReloadController } from './controller';

export const pluginReloadController = createPluginReloadController({
    invalidateCaches: () => {
        invalidateDaemonContributionRegistryProjectionCache();
    },
    dispatchReloadHookEvent: dispatchPluginReloadHookEvent,
});
