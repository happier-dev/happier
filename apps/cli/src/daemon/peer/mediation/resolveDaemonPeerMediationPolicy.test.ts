import { describe, expect, it } from 'vitest';
import type { PeerFlowKindV1 } from '@happier-dev/protocol';

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

    it('applies the canonical flow policy to every supported daemon peer surface', () => {
        const envKeyByFlow = {
            bounded_transfer: 'HAPPIER_DAEMON_PEER_MEDIATION_TRANSFER_DIRECT_ENABLED',
            tcp_tunnel: 'HAPPIER_DAEMON_PEER_MEDIATION_TUNNEL_DIRECT_ENABLED',
            voice_media: 'HAPPIER_DAEMON_PEER_MEDIATION_TUNNEL_DIRECT_ENABLED',
            live_stream: 'HAPPIER_DAEMON_PEER_MEDIATION_LIVE_STREAM_DIRECT_ENABLED',
            machine_rpc: 'HAPPIER_DAEMON_PEER_MEDIATION_RPC_DIRECT_ENABLED',
        } satisfies Readonly<Record<PeerFlowKindV1, string>>;

        for (const [flowKind, envKey] of Object.entries(envKeyByFlow) as Array<[PeerFlowKindV1, string]>) {
            expect(resolveDaemonPeerMediationPolicy({
                env: {
                    HAPPIER_DAEMON_PEER_MEDIATION_DIRECT_ENABLED: '0',
                    [envKey]: '1',
                },
                flowKind,
                routeKind: 'loopback_direct',
            }), flowKind).toBe(true);
        }
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
