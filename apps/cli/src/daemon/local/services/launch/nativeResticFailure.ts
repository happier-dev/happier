import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

const code = 'service_admission_unavailable';
const reason = 'backup_destination_host_network_unavailable';
const remedy = 'Use a container-reachable backup endpoint, or run this backup on a native Linux Docker Engine host.';
const message = `Loopback backup endpoints require native Linux Docker host networking. ${remedy}`;

export function refuseNativeResticHostNetwork(): never {
    throw new PluginError({ code, message, details: { reason } });
}

/** Only this owner's closed marker crosses; native messages and endpoint bytes do not. */
export function readDeploymentNativeResticFailure(errorCode: string, error: unknown): ActionExecuteFailure | null {
    if (errorCode !== code || !isPluginError(error) || error.code !== code) return null;
    const details = error.details;
    if (!details || typeof details !== 'object' || Array.isArray(details)
        || Object.keys(details).length !== 1 || !('reason' in details) || details.reason !== reason) return null;
    return { ok: false, errorCode, error: message,
        details: { reason, requiredFact: 'nativeLinuxHostNetwork', remedy } };
}
