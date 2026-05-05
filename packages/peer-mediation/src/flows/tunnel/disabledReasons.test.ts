import { describe, expect, it } from 'vitest';

type DisabledReasonsModule = typeof import('./disabledReasons');

async function loadDisabledReasonsModule(): Promise<DisabledReasonsModule | null> {
    const modulePath = './disabledReasons.js';
    return import(modulePath).catch(() => null) as Promise<DisabledReasonsModule | null>;
}

describe('TCP tunnel disabled reasons', () => {
    it('includes stable policy, grant, destination, and cap reason codes', async () => {
        const mod = await loadDisabledReasonsModule();

        expect(mod?.PEER_TCP_TUNNEL_DISABLED_REASONS).toEqual(expect.arrayContaining([
            'blocked_by_server_policy',
            'blocked_by_daemon_policy',
            'blocked_by_account_policy',
            'relay_disabled_by_server_policy',
            'relay_cap_exceeded',
            'destination_port_not_allowed',
            'grant_missing',
            'grant_expired',
            'grant_revoked',
            'grant_scope_mismatch',
            'probe_binding_mismatch',
            'route_unavailable',
        ]));
    });
});
