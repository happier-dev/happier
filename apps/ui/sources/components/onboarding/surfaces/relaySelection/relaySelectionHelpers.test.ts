import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/accessEndpoints/classify', () => ({
    classifyAccessEndpointHostedHttpsCompatibility: vi.fn(),
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    isSameServerUrl: vi.fn(),
    normalizeServerUrl: (value: string) => value,
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: vi.fn(),
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    HAPPIER_CLOUD_SERVER_URL: 'https://api.happier.dev',
    getOrCreateHappierCloudServerProfile: vi.fn(),
    listServerProfiles: vi.fn(() => []),
}));
vi.mock('@/sync/domains/server/setup/setupSurfacePolicy', () => ({
    resolveSetupSurfacePolicy: vi.fn(() => ({ relay: { allowHappierCloud: true } })),
}));

import { resolveTrueLocalRelayRuntimeBindUrl } from './relaySelectionHelpers';

describe('resolveTrueLocalRelayRuntimeBindUrl', () => {
    it('accepts every valid IPv4 loopback bind address', () => {
        expect(resolveTrueLocalRelayRuntimeBindUrl({
            activeServerUrl: 'https://relay.example.test',
            activeLocalRelayUrl: 'http://127.0.0.2:3005',
        })).toBe('http://127.0.0.2:3005');
    });
});
