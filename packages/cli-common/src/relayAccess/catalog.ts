import type { RelayAccessProviderDescriptor, RelayAccessProviderId } from './types.js';

export type { RelayAccessConfig, RelayAccessProviderDescriptor, RelayAccessProviderId } from './types.js';

export const relayAccessProviderIds = [
    'localOnly',
    'lan',
    'tailscaleServe',
    'tailscaleFunnel',
    'cloudflareNamed',
] as const satisfies readonly RelayAccessProviderId[];

const descriptorsById = {
    localOnly: {
        id: 'localOnly',
        title: 'Local only',
        exposure: 'private',
        prerequisites: [],
    },
    lan: {
        id: 'lan',
        title: 'LAN / custom URL',
        exposure: 'private',
        prerequisites: [{ kind: 'manualUrl' }],
    },
    tailscaleServe: {
        id: 'tailscaleServe',
        title: 'Tailscale Serve',
        exposure: 'private',
        prerequisites: [{ kind: 'tailscaleInstalled' }, { kind: 'tailscaleAuth' }],
    },
    tailscaleFunnel: {
        id: 'tailscaleFunnel',
        title: 'Tailscale Funnel',
        exposure: 'public',
        prerequisites: [{ kind: 'tailscaleInstalled' }, { kind: 'tailscaleAuth' }],
    },
    cloudflareNamed: {
        id: 'cloudflareNamed',
        title: 'Cloudflare (named tunnel)',
        exposure: 'public',
        prerequisites: [{ kind: 'cloudflareHostname' }, { kind: 'cloudflareToken' }],
    },
} as const satisfies Readonly<Record<RelayAccessProviderId, RelayAccessProviderDescriptor>>;

export const relayAccessProviderDescriptorsById: Readonly<Record<RelayAccessProviderId, RelayAccessProviderDescriptor>> = Object.freeze(
    descriptorsById,
);

export const relayAccessProviderDescriptors: readonly RelayAccessProviderDescriptor[] = relayAccessProviderIds.map(
    (id) => relayAccessProviderDescriptorsById[id],
);

export function getRelayAccessProviderDescriptor(providerId: RelayAccessProviderId): RelayAccessProviderDescriptor {
    return relayAccessProviderDescriptorsById[providerId];
}
