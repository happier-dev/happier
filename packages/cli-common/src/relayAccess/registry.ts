import type { RelayAccessProvider, RelayAccessProviderId } from './types.js';

import {
    getRelayAccessProviderDescriptor,
    relayAccessProviderDescriptors,
    relayAccessProviderDescriptorsById,
    relayAccessProviderIds,
} from './catalog.js';

import { localOnlyRelayAccessProvider } from './providers/localOnly/index.js';
import { lanRelayAccessProvider } from './providers/lan/index.js';
import { tailscaleServeRelayAccessProvider } from './providers/tailscaleServe/index.js';
import { tailscaleFunnelRelayAccessProvider } from './providers/tailscaleFunnel/index.js';
import { cloudflareNamedRelayAccessProvider } from './providers/cloudflareNamed/index.js';

export { getRelayAccessProviderDescriptor, relayAccessProviderDescriptors, relayAccessProviderDescriptorsById, relayAccessProviderIds };

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
