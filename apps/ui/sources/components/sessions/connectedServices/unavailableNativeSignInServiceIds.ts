import type { ConnectedServiceBindingSelectionV2 } from '@happier-dev/protocol/connect/connected-service-bindings';

const NO_UNAVAILABLE_SERVICES: readonly string[] = [];

export function resolveUnavailableNativeSignInServiceIds(
    connectedToNativeSwitchUnsupported: true | undefined,
    appliedBindings: Readonly<Record<string, ConnectedServiceBindingSelectionV2 | undefined>> | undefined,
): readonly string[] {
    if (!connectedToNativeSwitchUnsupported || !appliedBindings) return NO_UNAVAILABLE_SERVICES;
    return Object.keys(appliedBindings).filter(serviceId => appliedBindings[serviceId]?.source === 'connected');
}
