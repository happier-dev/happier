import { describe, expect, it } from 'vitest';
import type { RelayAccessConfig } from '../../types.js';
import { cloudflareNamedRelayAccessProvider } from './index.js';
import { parseRelayAccessConfig } from '../../catalog.js';
import * as relayAccess from '../../index.js';

const selection: RelayAccessConfig = {
    provider: { kind: 'builtin', id: 'cloudflareNamed' },
    config: { hostname: 'relay.example.test' },
    credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount',
        account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'account-1' } } }],
};
const ctx = { env: {}, upstreamUrl: 'http://127.0.0.1:3005' };

describe('cloudflareNamedRelayAccessProvider', () => {
    it.each([
        { kind: 'create', name: 'reviewed-tunnel' },
        { kind: 'adopt', tunnelId: '61bc2c65-9253-4917-8f74-05587547bfa2', name: 'reviewed-tunnel' },
    ])('admits complete non-secret controller coordinates without changing retained hostname-only selections: $kind', tunnel => {
        const selected = { ...selection, config: { hostname: 'relay.example.test', controller: {
            accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), tunnel, owned: [], dnsOwnership: [],
            connector: { imageRef: 'docker.io/cloudflare/cloudflared:2025.4.0', version: '2025.4.0' },
        } } };
        const admitted = parseRelayAccessConfig(selected);
        expect(admitted).toEqual(selected);
        if (!admitted) throw new Error('Missing admitted controller selection');
        expect(parseRelayAccessConfig(selection)).toEqual(selection);
        // Reflection keeps the missing public projection a runtime RED, rather
        // than a missing-import failure in this shared compiled package.
        const reader: unknown = Reflect.get(relayAccess, 'readCloudflareNamedControllerSelection');
        expect(typeof reader).toBe('function');
        if (typeof reader !== 'function') throw new Error('Missing canonical projection');
        expect(reader(selected)).toEqual({ selection: selected, controller: selected.config.controller });
        expect(reader(selection)).toBeNull();
        expect(reader({ ...selected, config: { ...selected.config, controller: {
            ...selected.config.controller, token: 'must-not-be-config',
        } } })).toBeNull();
        expect(cloudflareNamedRelayAccessProvider.status({ config: admitted, ctx }))
            .toEqual({ state: 'unknown', details: { reason: 'connector_verification_required' } });
        for (const extra of [{ token: 'must-not-be-config' }, { machineId: 'other' }, { installationPublicKey: 'caller-key' }]) {
            expect(parseRelayAccessConfig({ ...selected, config: { ...selected.config,
                controller: { ...selected.config.controller, ...extra } } })).toBeNull();
        }
        const { zoneId: _zoneId, ...incomplete } = selected.config.controller;
        expect(parseRelayAccessConfig({ ...selected, config: { ...selected.config, controller: incomplete } })).toBeNull();
        const { connector: _connector, ...withoutConnector } = selected.config.controller;
        expect(parseRelayAccessConfig({ ...selected, config: { ...selected.config, controller: withoutConnector } })).toBeNull();
        // The config boundary preserves the actor's exact reviewed selection;
        // native image grammar/version support remains the native owner's fact.
        for (const connector of [{ imageRef: '', version: '2025.4.0' },
            { imageRef: 'docker.io/cloudflare/cloudflared:2025.4.0', version: '' },
            { ...selected.config.controller.connector, token: 'must-not-be-config' }]) {
            expect(parseRelayAccessConfig({ ...selected, config: { ...selected.config,
                controller: { ...selected.config.controller, connector } } })).toBeNull();
        }
    });

    it('rejects invalid hostnames before reporting any route evidence', () => {
        for (const hostname of ['', 'relay.example.test/path', 'relay.example.test\ninvalid']) {
            expect(cloudflareNamedRelayAccessProvider.status({ config: { ...selection, config: { hostname } }, ctx }))
                .toEqual({ state: 'error', details: { reason: 'invalid_hostname' } });
        }
    });

    it('requires a Connected Account purpose instead of accepting token config', () => {
        expect(cloudflareNamedRelayAccessProvider.status({ config: { ...selection, credentialRefs: [] }, ctx }))
            .toEqual({ state: 'needs_auth', details: { reason: 'connected_account_required' } });
    });

    it('does not report metadata-only configured hostname as verified connector reachability', () => {
        expect(cloudflareNamedRelayAccessProvider.configure?.({ config: selection, ctx }))
            .toEqual({ state: 'unknown', details: { reason: 'connector_verification_required' } });
        expect(cloudflareNamedRelayAccessProvider.status({ config: selection, ctx }))
            .toEqual({ state: 'unknown', details: { reason: 'connector_verification_required' } });
    });

    it('surfaces unavailable admitted removal rather than reporting a successful no-op', () => {
        expect(() => cloudflareNamedRelayAccessProvider.disable?.({ config: selection, ctx }))
            .toThrowError('admitted_controller_required');
    });
});
