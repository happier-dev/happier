import type { RelayAccessProvider } from '../../types.js';

import { relayAccessProviderDescriptorsById } from '../../catalog.js';

function normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

const descriptor = relayAccessProviderDescriptorsById.lan;

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
