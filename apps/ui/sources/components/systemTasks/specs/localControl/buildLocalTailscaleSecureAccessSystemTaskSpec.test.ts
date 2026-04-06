import { describe, expect, it } from 'vitest';

import { buildLocalTailscaleSecureAccessSystemTaskSpec } from './buildLocalTailscaleSecureAccessSystemTaskSpec';

describe('buildLocalTailscaleSecureAccessSystemTaskSpec', () => {
    it('defaults to tailscaleServe for the local secure-access shortcut', () => {
        expect(buildLocalTailscaleSecureAccessSystemTaskSpec({
            upstreamUrl: 'http://127.0.0.1:3005/',
        })).toEqual({
            protocolVersion: 1,
            kind: 'secureAccess.tailscale.v1',
            params: {
                target: { kind: 'local' },
                upstreamUrl: 'http://127.0.0.1:3005/',
                providerId: 'tailscaleServe',
                servePath: '/',
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });
    });

    it('can target tailscaleFunnel when requested explicitly', () => {
        expect(buildLocalTailscaleSecureAccessSystemTaskSpec({
            upstreamUrl: 'http://127.0.0.1:3005/',
            providerId: 'tailscaleFunnel',
        })).toEqual({
            protocolVersion: 1,
            kind: 'secureAccess.tailscale.v1',
            params: {
                target: { kind: 'local' },
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
