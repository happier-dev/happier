import { describe, expect, it } from 'vitest';

import { resolveDaemonPeerMediationPolicy } from './resolveDaemonPeerMediationPolicy';

describe('resolveDaemonPeerMediationPolicy', () => {
    it('inherits when no daemon policy env is configured', () => {
        expect(resolveDaemonPeerMediationPolicy({
            env: {},
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
        })).toBeNull();
    });

    it('uses most-specific non-null precedence within daemon env', () => {
        expect(resolveDaemonPeerMediationPolicy({
            env: {
                HAPPIER_DAEMON_PEER_MEDIATION_DIRECT_ENABLED: '0',
                HAPPIER_DAEMON_PEER_MEDIATION_TRANSFER_DIRECT_ENABLED: '1',
            },
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
        })).toBe(true);

        expect(resolveDaemonPeerMediationPolicy({
            env: {
                HAPPIER_DAEMON_PEER_MEDIATION_TRANSFER_DIRECT_ENABLED: '0',
                HAPPIER_DAEMON_PEER_MEDIATION_LOOPBACK_DIRECT_ENABLED: '1',
            },
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
        })).toBe(true);

        expect(resolveDaemonPeerMediationPolicy({
            env: {
                HAPPIER_DAEMON_PEER_MEDIATION_TRANSFER_DIRECT_ENABLED: '1',
                HAPPIER_DAEMON_PEER_MEDIATION_LOOPBACK_DIRECT_ENABLED: '0',
            },
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
        })).toBe(false);
    });

    it('treats invalid env tokens as inherit', () => {
        expect(resolveDaemonPeerMediationPolicy({
            env: {
                HAPPIER_DAEMON_PEER_MEDIATION_DIRECT_ENABLED: 'not-a-bool',
            },
            flowKind: 'bounded_transfer',
            routeKind: 'loopback_direct',
        })).toBeNull();
    });
});
