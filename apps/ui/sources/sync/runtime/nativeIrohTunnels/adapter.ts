import { createIrohNativeAdapter, type IrohHomeTunnelLease, type IrohNativeAdapter, type IrohRelayPolicy } from '@happier-dev/iroh-native';
import { updateActiveServerRuntimeOrigin } from '@/sync/domains/server/serverRuntime';

export type IrohHomeTunnelInput = Readonly<{
    homeServerIdentityId: string;
    endpointId: string;
    policy: IrohRelayPolicy;
}>;

/** UI lifecycle adapter. Payload bytes stay in the native implementation. */
export function createUiIrohNativeAdapter(params: Readonly<{
    native?: Parameters<typeof createIrohNativeAdapter>[0];
    onLease?: (lease: IrohHomeTunnelLease) => void;
    getGeneration?: () => number;
}> = {}): IrohNativeAdapter {
    const adapter = createIrohNativeAdapter(params.native);
    let activeLeaseId: string | null = null;
    const readGeneration = params.getGeneration ?? (() => 0);
    return {
        async ensureHomeTunnel(input) {
            const generation = readGeneration();
            const lease = await adapter.ensureHomeTunnel(input);
            const currentGeneration = readGeneration();
            if (currentGeneration !== generation) {
                await adapter.releaseHomeTunnel(lease.leaseId);
                throw new Error('iroh_home_tunnel_stale_generation');
            }
            updateActiveServerRuntimeOrigin({ runtimeOrigin: lease.runtimeOrigin, carrier: 'iroh' });
            activeLeaseId = lease.leaseId;
            params.onLease?.(lease);
            return lease;
        },
        async releaseHomeTunnel(leaseId) {
            await adapter.releaseHomeTunnel(leaseId);
            // Clearing is deliberately lifecycle-only; Lane 04 remains the snapshot writer.
            if (activeLeaseId === leaseId) {
                activeLeaseId = null;
                updateActiveServerRuntimeOrigin({ carrier: 'https' });
            }
        },
    };
}

export { createIrohNativeAdapter } from '@happier-dev/iroh-native';
