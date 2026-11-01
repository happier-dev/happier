import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionSupervisor,
    type ManagedConnectionSupervisorConfig,
} from '@happier-dev/connection-supervisor';

/** Persistent socket lifecycles start/stop this owner with HTTP readiness; socket failures never publish HTTP verdicts. */
export function createSocketConnectionSupervisor(
    config: Pick<ManagedConnectionSupervisorConfig, 'createTransport' | 'onConnected' | 'onStateChange'>,
): ManagedConnectionSupervisor {
    const supervisor = createManagedConnectionSupervisor({
        ...DEFAULT_MANAGED_CONNECTION_POLICY,
        ...config,
        probeReadiness: async () => ({ status: 'ready' }),
        onConnected: (context) => {
            supervisor.resetRetryBackoff?.();
            return config.onConnected?.(context);
        },
    });
    return supervisor;
}
