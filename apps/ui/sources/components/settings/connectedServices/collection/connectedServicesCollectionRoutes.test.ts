import { describe, expect, it } from 'vitest';

import { resolveConnectedServicesChildRoute, resolveConnectedServicesSelection } from './connectedServicesCollectionRoutes';

describe('resolveConnectedServicesSelection', () => {
    it('selects the index, sign-in settings and each qualified entity from the route', () => {
        const root = '/settings/connected-services';
        const serviceParams = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const serviceKey = 'happier.agent.codex/openai-codex';

        expect(resolveConnectedServicesSelection(`${root}/`, serviceParams)).toEqual({ kind: 'index' });
        expect(resolveConnectedServicesSelection(`${root}/sign-in/`, {})).toEqual({ kind: 'agentSignIn' });
        // Saved Secrets live in the same collection (Credentials): a secret, the new-secret draft, or the page.
        expect(resolveConnectedServicesSelection(`${root}/secrets`, { secret: 'resource:abc' })).toEqual({ kind: 'secret', ref: 'resource:abc' });
        expect(resolveConnectedServicesSelection(`${root}/secrets`, { add: '1' })).toEqual({ kind: 'secretDraft' });
        expect(resolveConnectedServicesSelection(`${root}/secrets`, {})).toEqual({ kind: 'secrets' });
        expect(resolveConnectedServicesSelection(`${root}/account`, serviceParams)).toEqual({ kind: 'service', serviceKey });
        expect(resolveConnectedServicesSelection(`${root}/account`, {
            ...serviceParams, accountId: 'work',
        })).toEqual({ kind: 'account', serviceKey, accountId: 'work' });
        expect(resolveConnectedServicesSelection(`${root}/account`, {
            ...serviceParams, groupId: 'work-pool',
        })).toEqual({ kind: 'pool', serviceKey, groupId: 'work-pool' });
    });

    it('normalizes router arrays, gives an account focus precedence, and rejects incomplete identities', () => {
        const route = '/settings/connected-services/account';
        expect(resolveConnectedServicesSelection(route, {
            pluginId: [' happier.agent.codex ', 'ignored'], localId: [' openai-codex '],
            accountId: [' work '], groupId: 'pool',
        })).toEqual({ kind: 'account', serviceKey: 'happier.agent.codex/openai-codex', accountId: 'work' });
        expect(resolveConnectedServicesSelection(route, { pluginId: 'happier.agent.codex', localId: ' ' }))
            .toEqual({ kind: 'other' });
        expect(resolveConnectedServicesSelection('/settings/connected-services/provider-state-sharing', {}))
            .toEqual({ kind: 'other' });
    });

    it('selects account and pool drafts in their qualified service group, including incoming setup links', () => {
        const root = '/settings/connected-services';
        const service = { pluginId: 'external.service', localId: 'cloud' };
        const serviceKey = 'external.service/cloud';
        expect(resolveConnectedServicesSelection(`${root}/account`, { ...service, add: '1' }))
            .toEqual({ kind: 'accountDraft', serviceKey });
        expect(resolveConnectedServicesSelection(`${root}/account`, { ...service, newPool: '1' }))
            .toEqual({ kind: 'poolDraft', serviceKey });
        for (const pathname of [root, `${root}/connect`]) {
            expect(resolveConnectedServicesSelection(pathname, { connect: '1', service: serviceKey }))
                .toEqual({ kind: 'accountDraft', serviceKey });
        }
        expect(resolveConnectedServicesSelection(`${root}/connect`, { service: serviceKey }))
            .toEqual({ kind: 'accountDraft', serviceKey });
        expect(resolveConnectedServicesSelection(`${root}/connect`, { service: serviceKey, accountId: 'existing' }))
            .toEqual({ kind: 'account', serviceKey, accountId: 'existing' });
        expect(resolveConnectedServicesSelection(root, { connect: '1', service: 'cloud' })).toEqual({ kind: 'index' });
    });

    it('keeps gateway draft contribution identity distinct from a saved gateway', () => {
        const pathname = '/settings/connected-services/gateway';
        expect(resolveConnectedServicesChildRoute(pathname)).toBe('gateway');
        expect(resolveConnectedServicesSelection(pathname, { contributionKey: 'external.gateways/local' }))
            .toEqual({ kind: 'gatewayDraft', contributionKey: 'external.gateways/local' });
        expect(resolveConnectedServicesSelection(pathname, { connectionId: 'pc_work' }))
            .toEqual({ kind: 'gateway', connectionId: 'pc_work' });
        expect(resolveConnectedServicesSelection(pathname, { contributionKey: 'local' })).toEqual({ kind: 'other' });
    });
});

describe('resolveConnectedServicesIndexRoot', () => {
    it('makes the collection list the phone root and keeps All services one push away (lab s2svc:listP)', async () => {
        const { resolveConnectedServicesIndexRoot } = await import('./connectedServicesCollectionRoutes');
        expect(resolveConnectedServicesIndexRoot('list', {})).toBe('list');
        expect(resolveConnectedServicesIndexRoot('list', { view: 'all' })).toBe('overview');
        // Beside the rail the index is the designed overview; before the first measurement, nothing.
        expect(resolveConnectedServicesIndexRoot('land', {})).toBe('overview');
        expect(resolveConnectedServicesIndexRoot('pending', {})).toBe('pending');
        // A set-up link or a just-settled account still lands on the overview that owns those flows.
        expect(resolveConnectedServicesIndexRoot('list', { connect: '1' })).toBe('overview');
        expect(resolveConnectedServicesIndexRoot('list', { connectedService: 'openai-codex', connectedAccount: 'work' })).toBe('overview');
    });
});
