import { describe, expect, it } from 'vitest';

import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

import { findTrustedExternalSessionOwners } from './findTrustedExternalSessionOwners';

describe('findTrustedExternalSessionOwners', () => {
    it('matches Pi markers through the canonical vendor resume-id reader', () => {
        const matches = findTrustedExternalSessionOwners({
            markers: [{
                pid: 4343,
                trackingKey: legacyPidSessionTrackingKey(4343),
                happySessionId: 'happy-pi-1',
                happyHomeDir: '/tmp/happy-home',
                createdAt: 1,
                updatedAt: 2,
                flavor: 'pi',
                metadata: {
                    flavor: 'pi',
                    piSessionId: 'pi-session-1',
                },
            }],
            agentId: 'pi',
            remoteSessionId: 'pi-session-1',
        });

        expect(matches[0]?.happySessionId).toBe('happy-pi-1');
    });

    it('matches ohMyPi markers using the provider resume id field from metadata', () => {
        const matches = findTrustedExternalSessionOwners({
            markers: [{
                pid: 4242,
                trackingKey: legacyPidSessionTrackingKey(4242),
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

        expect(matches[0]?.pid).toBe(4242);
    });

    it('matches the exact provider-minted bytes the marker persisted', () => {
        // The Agent minted this id; the marker stores it verbatim through the
        // canonical vendor resume-id reader. Surrounding whitespace, the
        // embedded newline, `/`, `+` and `=` are part of the identity, so a
        // takeover query that re-canonicalizes it can never find its owner.
        const remoteSessionId = '  provider\nses/AB+cd==  ';
        const matches = findTrustedExternalSessionOwners({
            markers: [{
                pid: 4444,
                trackingKey: legacyPidSessionTrackingKey(4444),
                happySessionId: 'happy-opaque-1',
                happyHomeDir: '/tmp/happy-home',
                createdAt: 1,
                updatedAt: 2,
                flavor: 'ohMyPi',
                metadata: {
                    flavor: 'ohMyPi',
                    ohMyPiSessionId: remoteSessionId,
                },
            }],
            agentId: 'ohMyPi',
            remoteSessionId,
        });

        expect(matches[0]?.happySessionId).toBe('happy-opaque-1');
    });

    it('never matches a marker by a trimmed rewrite of the provider identity', () => {
        const matches = findTrustedExternalSessionOwners({
            markers: [{
                pid: 4445,
                trackingKey: legacyPidSessionTrackingKey(4445),
                happySessionId: 'happy-opaque-2',
                happyHomeDir: '/tmp/happy-home',
                createdAt: 1,
                updatedAt: 2,
                flavor: 'ohMyPi',
                metadata: {
                    flavor: 'ohMyPi',
                    ohMyPiSessionId: 'provider\nses/AB+cd==',
                },
            }],
            agentId: 'ohMyPi',
            remoteSessionId: '  provider\nses/AB+cd==  ',
        });

        expect(matches).toEqual([]);
    });

    it('fails closed on an all-whitespace remote session id', () => {
        const matches = findTrustedExternalSessionOwners({
            markers: [{
                pid: 4446,
                trackingKey: legacyPidSessionTrackingKey(4446),
                happySessionId: 'happy-opaque-3',
                happyHomeDir: '/tmp/happy-home',
                createdAt: 1,
                updatedAt: 2,
                flavor: 'ohMyPi',
                metadata: {
                    flavor: 'ohMyPi',
                    ohMyPiSessionId: ' \n\t ',
                },
            }],
            agentId: 'ohMyPi',
            remoteSessionId: ' \n\t ',
        });

        expect(matches).toEqual([]);
    });

    it('ignores markers whose provider metadata resolves to a different vendor session id', () => {
        const matches = findTrustedExternalSessionOwners({
            markers: [{
                pid: 4242,
                trackingKey: legacyPidSessionTrackingKey(4242),
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

        expect(matches).toEqual([]);
    });
});
