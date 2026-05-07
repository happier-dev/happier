import type { ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectedServiceDisplayNameKey =
    | 'connectedServices.serviceNames.claudeSubscription'
    | 'connectedServices.serviceNames.openaiCodex'
    | 'connectedServices.serviceNames.openai'
    | 'connectedServices.serviceNames.anthropic'
    | 'connectedServices.serviceNames.gemini'
    | 'connectedServices.serviceNames.github'
    | 'connectedServices.fallbackName';

export function resolveConnectedServiceDisplayNameKey(serviceId: ConnectedServiceId): ConnectedServiceDisplayNameKey {
    switch (serviceId) {
        case 'claude-subscription':
            return 'connectedServices.serviceNames.claudeSubscription';
        case 'openai-codex':
            return 'connectedServices.serviceNames.openaiCodex';
        case 'openai':
            return 'connectedServices.serviceNames.openai';
        case 'anthropic':
            return 'connectedServices.serviceNames.anthropic';
        case 'gemini':
            return 'connectedServices.serviceNames.gemini';
        case 'github':
            return 'connectedServices.serviceNames.github';
        default:
            return 'connectedServices.fallbackName';
    }
}

export function resolveConnectedServiceDisplayName(
    serviceId: ConnectedServiceId,
    translate: (key: ConnectedServiceDisplayNameKey) => string,
): string {
    return translate(resolveConnectedServiceDisplayNameKey(serviceId));
}
