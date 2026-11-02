import { describe, expect, it } from 'vitest';
import { createBuiltinRelayAccessSelection } from '@happier-dev/cli-common/relayAccess/catalog';

import {
    buildRelayAccessConfigureSystemTaskSpec,
    buildRelayAccessExecutionSystemTaskSpec,
    buildRelayAccessDisableSystemTaskSpec,
    buildRelayAccessStatusSystemTaskSpec,
} from './buildRelayAccessSystemTaskSpec';
import { buildRelayAccessTailscaleSecureAccessSystemTaskSpec } from './buildRelayAccessTailscaleSecureAccessSystemTaskSpec';

describe('buildRelayAccessSystemTaskSpec', () => {
    it('builds relay access tasks for an explicit SSH target', () => {
        const target = {
            kind: 'ssh' as const,
            ssh: {
                target: 'dev@example.test',
                auth: 'agent' as const,
            },
        };

        expect(buildRelayAccessStatusSystemTaskSpec({ target })).toEqual({
            protocolVersion: 1,
            kind: 'relay.access.status.v1',
            params: { target },
        });

        expect(buildRelayAccessDisableSystemTaskSpec({ target })).toEqual({
            protocolVersion: 1,
            kind: 'relay.access.disable.v1',
            params: { target },
        });

        expect(buildRelayAccessConfigureSystemTaskSpec({
            target,
            config: createBuiltinRelayAccessSelection('tailscaleServe'),
            upstreamUrl: 'http://127.0.0.1:3005/',
        })).toEqual({
            protocolVersion: 1,
            kind: 'relay.access.configure.v1',
            params: {
                target,
                config: createBuiltinRelayAccessSelection('tailscaleServe'),
                upstreamUrl: 'http://127.0.0.1:3005/',
            },
        });

        expect(buildRelayAccessTailscaleSecureAccessSystemTaskSpec({
            upstreamUrl: 'http://127.0.0.1:3005/',
            providerId: 'tailscaleFunnel',
            target,
        })).toEqual({
            protocolVersion: 1,
            kind: 'secureAccess.tailscale.v1',
            params: {
                target,
                upstreamUrl: 'http://127.0.0.1:3005/',
                providerId: 'tailscaleFunnel',
                servePath: '/',
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });

        expect(buildRelayAccessExecutionSystemTaskSpec({
            target: { kind: 'local' },
            config: createBuiltinRelayAccessSelection('tailscaleServe'),
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

        expect(buildRelayAccessExecutionSystemTaskSpec({
            target,
            config: createBuiltinRelayAccessSelection('tailscaleServe'),
            upstreamUrl: 'http://127.0.0.1:3005/',
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
                target,
            },
        });
    });
});
