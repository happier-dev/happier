import { describe, expect, it } from 'vitest';

import { buildRelayAccessTailscaleSecureAccessSystemTaskSpec } from './buildRelayAccessTailscaleSecureAccessSystemTaskSpec';

describe('buildRelayAccessTailscaleSecureAccessSystemTaskSpec', () => {
    it('builds the canonical secure-access task for Serve and Funnel targets', () => {
        expect(buildRelayAccessTailscaleSecureAccessSystemTaskSpec({
            upstreamUrl: 'http://127.0.0.1:3005/',
            providerId: 'tailscaleServe',
        })).toEqual({
            protocolVersion: 1,
            kind: 'secureAccess.tailscale.v1',
            params: {
                upstreamUrl: 'http://127.0.0.1:3005/',
                providerId: 'tailscaleServe',
                servePath: '/',
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });

        expect(buildRelayAccessTailscaleSecureAccessSystemTaskSpec({
            upstreamUrl: 'http://127.0.0.1:3005/',
            providerId: 'tailscaleFunnel',
        })).toEqual({
            protocolVersion: 1,
            kind: 'secureAccess.tailscale.v1',
            params: {
                upstreamUrl: 'http://127.0.0.1:3005/',
                providerId: 'tailscaleFunnel',
                servePath: '/',
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });
    });
});
