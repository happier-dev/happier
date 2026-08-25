import { describe, expect, it } from 'vitest';

import { resolveEffectivePeerDirectRoutePolicy } from './effectiveDirectRoutePolicy';

const baseInput = {
    flowKind: 'bounded_transfer',
    routeKind: 'loopback_direct',
    serverGateEnabled: true,
    daemonPolicy: null,
    accountMachinePreference: 'inherit',
    accountDefaultPreference: 'inherit',
    productDefaultPreference: 'disabled',
    grant: { status: 'valid' },
} as const;

describe('resolveEffectivePeerDirectRoutePolicy', () => {
    it('allows account per-machine direct preference after server and grant checks pass', () => {
        expect(resolveEffectivePeerDirectRoutePolicy({
            ...baseInput,
            accountMachinePreference: 'enabled',
        })).toEqual({
            allowed: true,
            source: 'account_machine',
            reasonCode: 'direct_route_allowed',
        });
    });

    it('fails closed by product default when no account or daemon preference enables direct routes', () => {
        expect(resolveEffectivePeerDirectRoutePolicy(baseInput)).toEqual({
            allowed: false,
            source: 'product_default',
            reasonCode: 'disabled_by_product_default',
        });
    });

    it('does not let daemon hard allow bypass a disabled server gate', () => {
        expect(resolveEffectivePeerDirectRoutePolicy({
            ...baseInput,
            serverGateEnabled: false,
            daemonPolicy: true,
            productDefaultPreference: 'disabled',
        })).toEqual({
            allowed: false,
            source: 'server_gate',
            reasonCode: 'blocked_by_server_policy',
        });
    });

    it('does not let account preference bypass grant validity', () => {
        expect(resolveEffectivePeerDirectRoutePolicy({
            ...baseInput,
            accountMachinePreference: 'enabled',
            grant: { status: 'expired' },
        })).toEqual({
            allowed: false,
            source: 'grant',
            reasonCode: 'grant_expired',
        });
    });

    it('uses daemon hard deny before account preferences', () => {
        expect(resolveEffectivePeerDirectRoutePolicy({
            ...baseInput,
            daemonPolicy: false,
            accountMachinePreference: 'enabled',
        })).toEqual({
            allowed: false,
            source: 'daemon_hard_deny',
            reasonCode: 'blocked_by_daemon_policy',
        });
    });
});
