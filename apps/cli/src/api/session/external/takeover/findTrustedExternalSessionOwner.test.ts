import { describe, expect, it } from 'vitest';

import { findTrustedExternalSessionOwner } from './findTrustedExternalSessionOwner';

describe('findTrustedExternalSessionOwner', () => {
    it('matches ohMyPi markers using the provider resume id field from metadata', () => {
        const marker = findTrustedExternalSessionOwner({
            markers: [{
                pid: 4242,
                happySessionId: 'happy-1',
                happyHomeDir: '/tmp/happy-home',
                createdAt: 1,
                updatedAt: 2,
                flavor: 'ohMyPi',
                metadata: {
                    flavor: 'ohMyPi',
                    ohMyPiSessionId: 'omp-session-1',
                },
            }],
            agentId: 'ohMyPi',
            remoteSessionId: 'omp-session-1',
        });

        expect(marker?.pid).toBe(4242);
    });

    it('ignores markers whose provider metadata resolves to a different vendor session id', () => {
        const marker = findTrustedExternalSessionOwner({
            markers: [{
                pid: 4242,
                happySessionId: 'happy-1',
                happyHomeDir: '/tmp/happy-home',
                createdAt: 1,
                updatedAt: 2,
                flavor: 'ohMyPi',
                metadata: {
                    flavor: 'ohMyPi',
                    ohMyPiSessionId: 'omp-session-2',
                },
            }],
            agentId: 'ohMyPi',
            remoteSessionId: 'omp-session-1',
        });

        expect(marker).toBeNull();
    });
});
