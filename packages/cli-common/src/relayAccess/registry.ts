import { tailscaleRelayAccessProvider } from './providers/tailscale/index.js';
import { caddyRelayAccessProvider } from './providers/caddy/index.js';
import type { AccessProviderRefV1 } from '@happier-dev/protocol/plugins/contributions/catalog';
import type { RelayAccessProvider } from './types.js';

import {
    getRelayAccessProviderDescriptor,
    relayAccessProviderDescriptors,
    relayAccessProviderDescriptorsById,
    relayAccessProviderIds,
    readBuiltinRelayAccessProviderId,
} from './catalog.js';

import { localOnlyRelayAccessProvider } from './providers/localOnly/index.js';
import { lanRelayAccessProvider } from './providers/lan/index.js';
import { tailscaleServeRelayAccessProvider } from './providers/tailscaleServe/index.js';
import { tailscaleFunnelRelayAccessProvider } from './providers/tailscaleFunnel/index.js';
import { cloudflareNamedRelayAccessProvider } from './providers/cloudflareNamed/index.js';

export { getRelayAccessProviderDescriptor, relayAccessProviderDescriptors, relayAccessProviderDescriptorsById, relayAccessProviderIds };
export { createBuiltinRelayAccessSelection, parseRelayAccessConfig, readBuiltinRelayAccessProviderId, filterRelayAccessProviderDescriptors,
    type RelayAccessBuildPolicy } from './catalog.js';

/** Static native codecs; installed contributions execute through host role admission. */
export const relayAccessProviders: readonly RelayAccessProvider[] = [localOnlyRelayAccessProvider, lanRelayAccessProvider,
    tailscaleServeRelayAccessProvider, tailscaleFunnelRelayAccessProvider, cloudflareNamedRelayAccessProvider, tailscaleRelayAccessProvider,
    caddyRelayAccessProvider];

export function getRelayAccessProvider(provider: AccessProviderRefV1): RelayAccessProvider {
    const id = readBuiltinRelayAccessProviderId(provider);
    const codec = relayAccessProviders.find(candidate => candidate.descriptor.id === id);
    if (!codec) throw Object.assign(new Error('access_provider_unavailable'), { code: 'access_provider_unavailable' });
    return codec;
}
