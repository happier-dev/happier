import { describe, expect, it } from 'vitest';
import { buildRelayAccessEndpoints } from './relayAccessSource';

describe('relay access descriptor endpoint projection', () => {
    it.each([
        ['localOnly', {}, 'loopback'],
        ['lan', { url: 'http://192.168.1.10:3000' }, 'lan'],
        ['tailscaleServe', {}, 'private-network'],
        ['tailscaleFunnel', {}, 'public'],
    ] as const)('projects the canonical %s selection scope', (id, config, reachability) => {
        const endpoints = buildRelayAccessEndpoints({ relayAccess: [{
            config: { provider: { kind: 'builtin', id }, config, credentialRefs: [] },
            status: { state: 'enabled', shareUrl: 'https://relay.example.test' },
        }], clientContext: 'web' });
        expect(endpoints).toMatchObject([{ providerId: id, reachability, status: 'available' }]);
    });

    it('does not invent public availability for an unknown contribution', () => {
        const endpoints = buildRelayAccessEndpoints({ relayAccess: [{
            config: { provider: { pluginId: 'unavailable-access', localId: 'ingress' }, config: {}, credentialRefs: [] },
            status: { state: 'enabled', shareUrl: 'https://relay.example.test' },
        }], clientContext: 'web' });
        expect(endpoints).toEqual([]);
    });
});
