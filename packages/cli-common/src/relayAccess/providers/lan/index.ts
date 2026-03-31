import type { RelayAccessProvider, RelayAccessProviderDescriptor } from '../../types.js';

function normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

const descriptor = {
    id: 'lan',
    title: 'LAN / custom URL',
    exposure: 'private',
    prerequisites: [{ kind: 'manualUrl' }],
} as const satisfies RelayAccessProviderDescriptor;

export const lanRelayAccessProvider: RelayAccessProvider = {
    descriptor,
    status: ({ config }) => {
        if (config?.providerId !== 'lan') {
            return { state: 'unknown' };
        }

        const normalized = normalizeUrl(config.url);
        if (normalized.length === 0) {
            return {
                state: 'error',
                details: { reason: 'missing_url' },
            };
        }

        return {
            state: 'enabled',
            shareUrl: normalized,
        };
    },
};
