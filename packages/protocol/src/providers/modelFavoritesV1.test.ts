import { describe, expect, it } from 'vitest';

import { setModelFavoriteV1 } from './modelFavoritesV1.js';

describe('Account favorite model effort', () => {
    it('keeps a connected-account favorite distinct from its native tuple', () => {
        const ref = { agentTargetKey: 'agent:happier.agent.muse/muse', modelId: 'meta/muse-spark-1.3-contributor' };
        const native = { selection: { v: 1, updatedAt: 5, ref: { ...ref, providerConnectionId: null } } };
        const connected = { selection: { v: 2, updatedAt: 6, ref: { ...ref, source: 'connected_account',
            endpointTemplateId: 'meta-responses',
            purpose: { consumer: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }, purpose: 'meta-upstream' },
        } } };
        const both = setModelFavoriteV1({ favoriteModelSelectionsV1: [native] }, { favorite: true, selection: connected });
        expect(both.favoriteModelSelectionsV1).toEqual([native, connected]);
        expect(setModelFavoriteV1(both, { favorite: false, selection: connected }).favoriteModelSelectionsV1).toEqual([native]);
    });

    it('updates only the exact favorite in place and retains its effort on membership-only writes', () => {
        const favorite = { selection: { v: 1 as const, updatedAt: 5,
            ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_one', modelId: 'same-model' } },
            modelLabel: 'Original label' };
        const other = { ...favorite, selection: { ...favorite.selection,
            ref: { ...favorite.selection.ref, providerConnectionId: 'pc_two' } } };
        const opaque = { selection: { v: 99, ref: { future: true } } };
        const retainedFavorite = { ...favorite, futurePresentationMetadata: { revision: 2 } };
        const raw = { favoriteModelSelectionsV1: [retainedFavorite, opaque, other] };
        const updated = setModelFavoriteV1(raw, {
            favorite: true,
            selection: { selection: favorite.selection, reasoningEffort: 'high' },
        });

        expect(updated.favoriteModelSelectionsV1).toEqual([
            { ...retainedFavorite, reasoningEffort: 'high' }, opaque, other,
        ]);
        expect(setModelFavoriteV1(updated, { favorite: true, selection: favorite })).toEqual(updated);
    });
});
