import { describe, expect, it } from 'vitest';

import { resolveConnectedServicesSelection } from './connectedServicesCollectionRoutes';

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
});
