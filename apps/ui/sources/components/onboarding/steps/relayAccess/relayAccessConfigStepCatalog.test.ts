import { describe, expect, it } from 'vitest';
import { relayAccessConfigStepCatalog } from './relayAccessConfigStepCatalog';

describe('relay setup descriptor config', () => {
    it('reads editable configuration from the selection, not the resulting share URL', () => {
        expect(relayAccessConfigStepCatalog.lan.readConfiguredDraft({ configured: true, providerId: 'lan',
            selection: { provider: { kind: 'builtin', id: 'lan' }, config: { url: 'http://192.168.1.20:3005' }, credentialRefs: [] },
            status: { state: 'enabled', shareUrl: 'https://result.example.test', details: null },
        })).toEqual({ url: 'http://192.168.1.20:3005' });
    });

    it('offers only nonsecret fields and requires the declared credential reference', async () => {
        const definition = relayAccessConfigStepCatalog.cloudflareNamed;
        expect(definition.fields.map(field => field.id)).toEqual(['hostname']);
        const normalizedDraft = definition.normalizeDraft({ hostname: 'relay.example.test' });
        expect(await definition.createConfig({ normalizedDraft })).toBeNull();
        const credentialRefs = [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount' as const,
            account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'work' } } }];
        const input = { normalizedDraft, credentialRefs };
        expect(await definition.createConfig(input)).toEqual({ provider: { kind: 'builtin', id: 'cloudflareNamed' },
            config: { hostname: 'relay.example.test' }, credentialRefs });
    });
});
