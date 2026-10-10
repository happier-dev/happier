import { describe, expect, it, vi } from 'vitest';

import type { RemoteHostLocalOverrides } from '@/sync/domains/remoteHosts/remoteHostLocalOverrides';

import { isEligiblePersonalHomeRelocationHost } from './personalHomeRelocationEligibility';

const overrides = vi.hoisted(() => ({
    read: vi.fn<(remoteHostId: string) => RemoteHostLocalOverrides | null>(() => null),
}));

vi.mock('@/sync/domains/remoteHosts/remoteHostLocalOverrides', () => ({
    getRemoteHostLocalOverrides: (hostId: string) => overrides.read(hostId),
}));

describe('isEligiblePersonalHomeRelocationHost', () => {
    it('keeps Move Home destinations to managed SSH hosts whose configured key authentication can actually start the existing task', () => {
        const keyFileHost = {
            id: 'host-1',
            name: 'Server',
            ssh: { target: 'ops@server.example.test', authMode: 'keyfile' as const },
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: null,
        };

        expect(isEligiblePersonalHomeRelocationHost(keyFileHost, false)).toBe(false);
        overrides.read.mockReturnValueOnce({ identityFilePath: '/Users/me/.ssh/id_ed25519' });
        expect(isEligiblePersonalHomeRelocationHost(keyFileHost, false)).toBe(true);
        expect(isEligiblePersonalHomeRelocationHost({ ...keyFileHost, ssh: { target: 'ops@server.example.test', authMode: 'agent' } }, false)).toBe(true);
        const passwordHost = {
            ...keyFileHost,
            ssh: {
                target: 'ops@server.example.test',
                authMode: 'password' as const,
                passwordSecretRef: 'happier:shared-secret:v1:ssh-password',
            },
        };
        expect(isEligiblePersonalHomeRelocationHost(passwordHost, false)).toBe(false);
        expect(isEligiblePersonalHomeRelocationHost(passwordHost, true)).toBe(true);
    });
});
