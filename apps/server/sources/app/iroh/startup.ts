import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';

import type { BoundServerListener } from '@/app/runtime/startupReceipt';
import type { HomeConnectionDescriptorContinuityStore } from '@/app/features/homeConnectionDescriptorContinuity';
import { readHomeConnectionDescriptor } from '@/app/features/homeConnectionDescriptorPublication';
import { onShutdown } from '@/utils/process/shutdown';
import { log } from '@/utils/logging/log';

import {
    beginHomeIrohEndpointStartup,
    ensureHomeIrohEndpoint,
    markHomeIrohEndpointRetired,
    markHomeIrohEndpointStartupUnavailable,
    registerHomeIrohComposition,
    stopHomeIrohEndpoint,
} from './homeIrohEndpoint';
import { verifyPersonalHomeExposureProof } from './personalHomeExposureProof';
import { readHomeIrohTopologyFailure } from './topology';

/** API roles prepare before listen so discovery never mistakes startup for retirement. */
export function prepareHomeIrohStartup(env: NodeJS.ProcessEnv) {
    const topologyFailure = readHomeIrohTopologyFailure(env);
    const retired = readServerConfig(env, SERVER_CONFIG.HAPPIER_HOME_IROH_MODE) === 'disabled';
    if (readServerConfig(env, SERVER_CONFIG.HAPPIER_HOME_IROH_HOLDER) === true) {
        log({ module: 'iroh', level: 'warn', diagnostic: 'iroh_holder_declared', mode: retired ? 'disabled' : 'enabled' },
            'This process is declared the sole Home Iroh holder. Exactly one API process may hold the endpoint key; the declaration does not verify exclusivity.');
    }
    if (topologyFailure) markHomeIrohEndpointStartupUnavailable(topologyFailure);
    else if (!retired) beginHomeIrohEndpointStartup();

    return async (params: Readonly<{
        listener: BoundServerListener | null;
        ingressPort: number | null;
        continuityStore: HomeConnectionDescriptorContinuityStore | null;
    }>): Promise<void> => {
        try {
            if (topologyFailure) {
                // Public discovery reads committed facts only. Publish the
                // shared HTTPS set without registering or retiring Iroh.
                if (params.continuityStore) await readHomeConnectionDescriptor({
                    env,
                    continuityStore: params.continuityStore,
                    visibility: 'authenticated',
                });
                return;
            }
            if (!params.continuityStore) {
                markHomeIrohEndpointStartupUnavailable('continuity_metadata_unavailable');
                return;
            }
            if (!params.ingressPort) {
                markHomeIrohEndpointStartupUnavailable('api_listen_port_unavailable');
                return;
            }
            if (!retired && !verifyPersonalHomeExposureProof({ env, listener: params.listener })) {
                markHomeIrohEndpointStartupUnavailable('exposure_proof_missing');
                return;
            }
            onShutdown('iroh', () => stopHomeIrohEndpoint());
            registerHomeIrohComposition({
                env,
                apiPort: params.ingressPort,
                continuityStore: params.continuityStore,
            });
            if (retired) markHomeIrohEndpointRetired();
            const state = retired ? null : await ensureHomeIrohEndpoint({
                env,
                apiPort: params.ingressPort,
                continuityStore: params.continuityStore,
            });
            if (retired || state?.status === 'active') {
                // Commit through the sole publisher before discovery.
                await readHomeConnectionDescriptor({
                    env,
                    continuityStore: params.continuityStore,
                    visibility: 'authenticated',
                });
            }
        } catch {
            await stopHomeIrohEndpoint().catch(() => {
                log({ module: 'iroh', level: 'warn' }, 'Home Iroh cleanup remains pending');
            });
            markHomeIrohEndpointStartupUnavailable(topologyFailure ?? 'native_error');
        }
    };
}
