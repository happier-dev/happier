import { describe, expect, it } from 'vitest';

import { setModelFavoriteV1 } from './modelFavoritesV1.js';

describe('Account favorite model effort', () => {
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
