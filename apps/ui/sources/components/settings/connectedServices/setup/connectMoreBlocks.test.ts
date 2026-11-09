import { describe, expect, it } from 'vitest';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectConnectedServiceRegistryEntries } from '@/sync/domains/connectedServices/connectedServiceRegistry';

import { resolveConnectMoreBlockForRequest, selectConnectMoreOffer, CONNECT_MORE_BROWSE_ID, readConnectedServiceSetupResult } from './connectMoreBlocks';

type Entry = Parameters<typeof selectConnectMoreOffer>[0]['catalog'][number];

function entry(serviceKey: string, fields: Partial<Entry> & Readonly<{ oauth?: boolean }> = {}): Entry {
    return {
        serviceKey,
        service: { pluginId: 'p', localId: serviceKey },
        entry: { authenticationModes: [{ id: 'm', kind: fields.oauth ? 'oauthAuthorizationCode' : 'manual' }] } as never,
        legacyServiceId: null,
        label: serviceKey,
        usedBy: ['Codex'],
        usedByAgentIds: ['codex'],
        connectedCount: 0,
        section: 'agents',
        canAdd: true,
        ...fields,
    };
}

describe('selectConnectMoreOffer', () => {
    it('reads only an exact qualified account result for the index to settle after the phone journey', () => {
        expect(readConnectedServiceSetupResult({ connectedService: 'happier.agent.codex/openai-codex', connectedAccount: 'work' })).toEqual({
            serviceKey: 'happier.agent.codex/openai-codex', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
        });
        expect(readConnectedServiceSetupResult({ connectedService: 'not-qualified', connectedAccount: 'work' })).toBeNull();
        expect(readConnectedServiceSetupResult({ connectedService: 'happier.agent.codex/openai-codex', connectedAccount: '' })).toBeNull();
        expect(readConnectedServiceSetupResult({ connectedService: ['happier.agent.codex/openai-codex'], connectedAccount: ['work'] })).toBeNull();
    });
    const claude = entry('claude', { oauth: true });
    const gemini = entry('gemini');
    const keyed = entry('anthropic', { connectedCount: 1 });
    const github = entry('github', { section: 'tools', usedBy: [], usedByAgentIds: [] });

    it('keeps connected agent services available for another account with their count, respecting dismissals and availability', () => {
        const unavailable = entry('unavailable', { canAdd: false, connectedCount: 2 });
        const offer = selectConnectMoreOffer({
            layout: 'section',
            catalog: [claude, gemini, keyed, github, unavailable],
            hidden: new Set(['connect:gemini']),
        });
        expect(offer.offered.map(({ serviceKey, connectedCount }) => ({ serviceKey, connectedCount }))).toEqual([
            { serviceKey: 'claude', connectedCount: 0 },
            { serviceKey: 'anthropic', connectedCount: 1 },
        ]);
        expect(offer.browse).toBe(true);
    });

    it('features the curated Claude, ChatGPT and Gemini services on first run, browsing other keys', () => {
        const featured = [
            entry('claude', { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, oauth: true }),
            entry('chatgpt', { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, oauth: true }),
            entry('gemini', { service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' } }),
        ];
        const openai = entry('openai', { service: { pluginId: 'happier.provider.openai', localId: 'openai' } });
        const anthropic = entry('anthropic', { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' } });
        const offer = selectConnectMoreOffer({
            layout: 'firstRun',
            catalog: [...featured, openai, anthropic, github],
            hidden: new Set(),
        });
        expect(offer.offered.map((candidate) => candidate.serviceKey)).toEqual(['claude', 'chatgpt', 'gemini']);
        expect(offer.browse).toBe(true);
    });

    it('features a dynamic service from its declared setup facts without a built-in alias', () => {
        const service = { pluginId: 'acme.portable-auth', localId: 'acme' };
        const descriptor = projectConnectedAccountDescriptorV1({
            descriptor: {
                id: service.localId,
                title: 'Acme account',
                authentication: {
                    defaultModeId: 'device',
                    account: { artifactId: 'account-auth', exportName: 'activate' },
                    modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }],
                },
                ui: { setup: { order: 2, firstRun: true, catalogDescription: 'Acme account' } },
            },
            serviceId: service.localId,
            pluginId: service.pluginId,
            provenance: 'external',
            sourceKind: 'account_release',
            availability: { state: 'available', reason: 'account_declaration' },
            diagnostics: [],
        });
        const registryEntry = projectConnectedServiceRegistryEntries({
            scopeKey: 'account-cloud', status: 'ready', descriptors: [descriptor], conflicts: [], errorReason: null,
        }).find((candidate) => candidate.service?.pluginId === service.pluginId && candidate.service.localId === service.localId);
        if (!registryEntry) throw new Error('Expected the projected Acme service');
        const dynamic = entry(buildQualifiedPluginContributionKey(service), { service, entry: registryEntry });
        expect(selectConnectMoreOffer({ layout: 'firstRun', catalog: [github, dynamic], hidden: new Set() }).offered).toEqual([dynamic]);
    });

    it('does not browse when every addable service is already a block', () => {
        const offer = selectConnectMoreOffer({
            layout: 'section',
            catalog: [claude],
            hidden: new Set(),
        });
        expect(offer.offered).toEqual([claude]);
        expect(offer.browse).toBe(false);
    });
});

describe('resolveConnectMoreBlockForRequest', () => {
    const offered = [entry('gemini')];

    it('opens a requested service from its own block when it has one, else from browse', () => {
        expect(resolveConnectMoreBlockForRequest({ request: { kind: 'service', serviceKey: 'gemini' }, offered, browse: true, openId: null })).toBe('gemini');
        expect(resolveConnectMoreBlockForRequest({ request: { kind: 'service', serviceKey: 'claude' }, offered, browse: true, openId: null })).toBe(CONNECT_MORE_BROWSE_ID);
        expect(resolveConnectMoreBlockForRequest({ request: { kind: 'reconnect', serviceKey: 'gemini', accountId: 'a' }, offered, browse: true, openId: null })).toBe(CONNECT_MORE_BROWSE_ID);
        expect(resolveConnectMoreBlockForRequest({ request: { kind: 'catalog' }, offered, browse: true, openId: null })).toBe(CONNECT_MORE_BROWSE_ID);
    });

    it('keeps an open panel where it is (the panel follows the new target)', () => {
        expect(resolveConnectMoreBlockForRequest({ request: { kind: 'catalog' }, offered, browse: true, openId: 'gemini' })).toBe('gemini');
    });
});
