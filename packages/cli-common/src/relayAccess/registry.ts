import type { RelayAccessProvider, RelayAccessProviderDescriptor, RelayAccessProviderId } from './types.js';

import { localOnlyRelayAccessProvider } from './providers/localOnly/index.js';
import { lanRelayAccessProvider } from './providers/lan/index.js';
import { tailscaleServeRelayAccessProvider } from './providers/tailscaleServe/index.js';
import { tailscaleFunnelRelayAccessProvider } from './providers/tailscaleFunnel/index.js';
import { cloudflareNamedRelayAccessProvider } from './providers/cloudflareNamed/index.js';

export const relayAccessProviderIds = [
    'localOnly',
    'lan',
    'tailscaleServe',
    'tailscaleFunnel',
    'cloudflareNamed',
] as const satisfies readonly RelayAccessProviderId[];

export const relayAccessProviderDescriptorsById: Readonly<Record<RelayAccessProviderId, RelayAccessProviderDescriptor>> = Object.freeze({
    localOnly: localOnlyRelayAccessProvider.descriptor,
    lan: lanRelayAccessProvider.descriptor,
    tailscaleServe: tailscaleServeRelayAccessProvider.descriptor,
    tailscaleFunnel: tailscaleFunnelRelayAccessProvider.descriptor,
    cloudflareNamed: cloudflareNamedRelayAccessProvider.descriptor,
});

export const relayAccessProviderDescriptors: readonly RelayAccessProviderDescriptor[] = relayAccessProviderIds.map(
    (id) => relayAccessProviderDescriptorsById[id],
);

export function getRelayAccessProviderDescriptor(providerId: RelayAccessProviderId): RelayAccessProviderDescriptor {
    return relayAccessProviderDescriptorsById[providerId];
}

const providersById: Record<RelayAccessProviderId, RelayAccessProvider> = {
    localOnly: localOnlyRelayAccessProvider,
    lan: lanRelayAccessProvider,
    tailscaleServe: tailscaleServeRelayAccessProvider,
    tailscaleFunnel: tailscaleFunnelRelayAccessProvider,
    cloudflareNamed: cloudflareNamedRelayAccessProvider,
};

export const relayAccessProviders: readonly RelayAccessProvider[] = relayAccessProviderIds.map((id) => providersById[id]);

export function getRelayAccessProvider(providerId: RelayAccessProviderId): RelayAccessProvider {
    return providersById[providerId];
}
