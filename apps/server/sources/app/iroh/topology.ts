import { getSocketAdapterFromEnv, resolveDefaultSocketAdapter, resolveServerFlavorFromEnv } from '@/config/backends';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';

export type HomeIrohTopologyFailure = 'iroh_multi_instance_unsupported';

/** Redis deployments require one operator-declared holder; followers remain HTTPS-only. */
export function readHomeIrohTopologyFailure(env: NodeJS.ProcessEnv): HomeIrohTopologyFailure | null {
    const flavor = resolveServerFlavorFromEnv(env, 'full');
    return getSocketAdapterFromEnv(env, resolveDefaultSocketAdapter(flavor)) === 'redis-streams'
        && readServerConfig(env, SERVER_CONFIG.HAPPIER_HOME_IROH_HOLDER) !== true
        ? 'iroh_multi_instance_unsupported'
        : null;
}
