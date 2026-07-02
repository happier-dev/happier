import {
    isConnectedServiceAccountGroupConfigurationSupported,
    isConnectedServiceRuntimeFallbackSupported,
    resolveConnectedServiceRuntimeFallbackCapability,
} from '@happier-dev/agents';
import type { ConnectedServiceId } from '@happier-dev/protocol';

export function resolveConnectedServiceRuntimeGroupCapability(serviceId: ConnectedServiceId) {
    return resolveConnectedServiceRuntimeFallbackCapability(serviceId);
}

export function isConnectedServiceAccountGroupConfigurationRuntimeSupported(serviceId: ConnectedServiceId): boolean {
    return isConnectedServiceAccountGroupConfigurationSupported(serviceId);
}

export function isConnectedServiceRuntimeGroupFallbackSupported(serviceId: ConnectedServiceId): boolean {
    return isConnectedServiceRuntimeFallbackSupported(serviceId);
}
