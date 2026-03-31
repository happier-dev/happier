import type { RelayAccessProvider, RelayAccessProviderDescriptor, RelayAccessStatus } from '../../types.js';

type CloudflareNamedConfig = Readonly<{
    providerId: 'cloudflareNamed';
    hostname: string;
    token: string;
}>;

type CloudflareNamedStatusResolution = Readonly<{
    status: RelayAccessStatus;
    config: CloudflareNamedConfig | null;
}>;

const descriptor = {
    id: 'cloudflareNamed',
    title: 'Cloudflare (named tunnel)',
    exposure: 'public',
    prerequisites: [{ kind: 'cloudflareHostname' }, { kind: 'cloudflareToken' }],
} as const satisfies RelayAccessProviderDescriptor;

function normalizeCloudflareNamedConfig(config: unknown): CloudflareNamedConfig | null {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return null;
    }

    const record = config as Record<string, unknown>;
    if (record.providerId !== 'cloudflareNamed') {
        return null;
    }

    const hostname = typeof record.hostname === 'string' ? record.hostname.trim() : '';
    if (!hostname) {
        return null;
    }

    const token = typeof record.token === 'string' ? record.token.trim() : '';
    if (!token) {
        return null;
    }

    if (/[\s\r\n\0/]/.test(hostname)) {
        return null;
    }

    try {
        const parsed = new URL(`https://${hostname}`);
        if (parsed.protocol !== 'https:' || parsed.hostname !== hostname) {
            return null;
        }
    } catch {
        return null;
    }

    return {
        providerId: 'cloudflareNamed',
        hostname,
        token,
    };
}

function buildMissingConfigStatus(reason: 'missing_hostname' | 'missing_token'): RelayAccessStatus {
    return {
        state: 'error',
        details: { reason },
    };
}

function buildEnabledStatus(config: CloudflareNamedConfig): RelayAccessStatus {
    return {
        state: 'enabled',
        shareUrl: `https://${config.hostname}`,
        details: {
            managed: false,
        },
    };
}

function resolveCloudflareNamedStatus(config: unknown): CloudflareNamedStatusResolution {
    const normalized = normalizeCloudflareNamedConfig(config);
    if (normalized) {
        return {
            config: normalized,
            status: buildEnabledStatus(normalized),
        };
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return {
            config: null,
            status: { state: 'unknown' },
        };
    }

    const record = config as Record<string, unknown>;
    const hostname = typeof record.hostname === 'string' ? record.hostname.trim() : '';
    const token = typeof record.token === 'string' ? record.token.trim() : '';
    if (!hostname) {
        return {
            config: null,
            status: buildMissingConfigStatus('missing_hostname'),
        };
    }
    if (!token) {
        return {
            config: null,
            status: buildMissingConfigStatus('missing_token'),
        };
    }

    return {
        config: null,
        status: {
            state: 'error',
            details: { reason: 'invalid_hostname' },
        },
    };
}

export const cloudflareNamedRelayAccessProvider: RelayAccessProvider = {
    descriptor,
    configure: ({ config }) => resolveCloudflareNamedStatus(config).status,
    status: ({ config }) => resolveCloudflareNamedStatus(config).status,
    disable: () => {
        return undefined;
    },
};
