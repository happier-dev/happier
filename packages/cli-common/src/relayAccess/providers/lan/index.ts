import type { RelayAccessProvider } from '../../types.js';

import { readBuiltinRelayAccessProviderId, relayAccessProviderDescriptorsById } from '../../catalog.js';

function normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

const descriptor = relayAccessProviderDescriptorsById.lan;

export const lanRelayAccessProvider: RelayAccessProvider = {
    descriptor,
    status: ({ config }) => {
        if (!config || readBuiltinRelayAccessProviderId(config.provider) !== 'lan') {
            return { state: 'unknown' };
        }

        const value = config.config;
        const normalized = normalizeUrl(value !== null && typeof value === 'object' && 'url' in value && typeof value.url === 'string' ? value.url : '');
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
