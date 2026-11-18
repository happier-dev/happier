import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionSupervisor,
    type ManagedConnectionSupervisorConfig,
} from '@happier-dev/connection-supervisor';
import { resolveSocketErrorClassification } from './resolveSocketErrorClassification';

/** Persistent socket demand follows HTTP readiness, without writing HTTP verdicts. */
export function createSocketConnectionSupervisor(
    config: Pick<ManagedConnectionSupervisorConfig, 'createTransport' | 'onConnected' | 'onStateChange'>
        & Partial<Pick<ManagedConnectionSupervisorConfig, 'probeReadiness' | 'classifyTransportErrorToProbeResult' | 'onAuthFailed'>>,
): ManagedConnectionSupervisor {
    const supervisor = createManagedConnectionSupervisor({
        ...DEFAULT_MANAGED_CONNECTION_POLICY,
        probeReadiness: async () => ({ status: 'ready' }),
        classifyTransportErrorToProbeResult: error => {
            const { statusCode } = resolveSocketErrorClassification(error);
            // The Home rejects an invalid Socket.IO credential with a structured 401.
            return statusCode === 401 ? { status: 'auth_failed', statusCode } : null;
        },
        ...config,
        onConnected: context => {
            supervisor.resetRetryBackoff?.();
            return config.onConnected?.(context);
        },
    });
    return supervisor;
}
