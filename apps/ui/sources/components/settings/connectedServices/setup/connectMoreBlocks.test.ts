import { describe, expect, it } from 'vitest';

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

    it('offers, on the page, the agents’ services nobody connected and nobody set aside, and browses the rest', () => {
        const offer = selectConnectMoreOffer({
            layout: 'section',
            catalog: [claude, gemini, keyed, github],
            connectableKeys: new Set(['claude', 'gemini']),
            hidden: new Set(['connect:gemini']),
        });
        expect(offer.offered.map((candidate) => candidate.serviceKey)).toEqual(['claude']);
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
            connectableKeys: new Set(['claude', 'chatgpt', 'gemini', 'openai', 'anthropic']),
            hidden: new Set(),
        });
        expect(offer.offered.map((candidate) => candidate.serviceKey)).toEqual(['claude', 'chatgpt', 'gemini']);
        expect(offer.browse).toBe(true);
    });

    it('does not browse when every addable service is already a block', () => {
        const offer = selectConnectMoreOffer({
            layout: 'section',
            catalog: [claude],
            connectableKeys: new Set(['claude']),
            hidden: new Set(),
        });
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
