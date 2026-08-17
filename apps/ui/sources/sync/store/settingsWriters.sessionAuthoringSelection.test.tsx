import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { FavoriteModelSelectionV1Schema } from '@/sync/domains/models/favoriteModelSelections';
import { RememberedEngineSelectionsByScopeV1Schema } from '@/sync/domains/session/authoring/rememberedEngineSelections';

const mutateAccountSettings = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ mutateAccountSettings }),
}));

import {
    useApplyFavoriteModelSelectionReplacementIntent,
    useApplyRememberedEngineSelectionReplacementIntent,
} from './settingsWriters';

function favorite(modelId: string, updatedAt: number) {
    return FavoriteModelSelectionV1Schema.parse({
        selection: {
            v: 1,
            updatedAt,
            ref: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: null,
                modelId,
            },
        },
        addedAtMs: updatedAt,
    });
}

describe('session-authoring Settings writers', () => {
    afterEach(() => {
        standardCleanup();
        vi.clearAllMocks();
    });

    it('replays a Favorite replacement against the current CAS winner and retains a concurrent opaque entry', async () => {
        const base = [favorite('gpt-5.4', 1)];
        const proposed = [...base, favorite('gpt-5.5', 2)];
        const hook = await renderHook(() => useApplyFavoriteModelSelectionReplacementIntent());

        await hook.getCurrent()({ base, proposed });

        expect(mutateAccountSettings).toHaveBeenCalledOnce();
        const mutation = mutateAccountSettings.mock.calls[0]?.[0];
        expect(mutation).toBeTypeOf('function');
        const result = mutation?.({
            favoriteModelSelectionsV1: [
                base[0],
                { v: 2, futureWriterField: 'opaque-favorite' },
            ],
        });

        expect(result).toMatchObject({
            favoriteModelSelectionsV1: [
                base[0],
                { v: 2, futureWriterField: 'opaque-favorite' },
                proposed[1],
            ],
        });
    });

    it('replays a remembered replacement against the current CAS winner and retains a concurrent opaque scope', async () => {
        const base = RememberedEngineSelectionsByScopeV1Schema.parse({
            'server-a:backend:codex': {
                v: 1,
                modelSelection: favorite('gpt-5.4', 1).selection,
                updatedAt: 1,
            },
        });
        const proposed = {
            ...base,
            'server-a:backend:codex': {
                ...base['server-a:backend:codex']!,
                updatedAt: 2,
            },
        };
        const hook = await renderHook(() => useApplyRememberedEngineSelectionReplacementIntent());

        await hook.getCurrent()({ base, proposed });

        expect(mutateAccountSettings).toHaveBeenCalledOnce();
        const mutation = mutateAccountSettings.mock.calls[0]?.[0];
        expect(mutation).toBeTypeOf('function');
        const result = mutation?.({
            lastEngineSelectionsByScopeV1: {
                'server-a:backend:codex': base['server-a:backend:codex'],
                'server-a:backend:future': { v: 2, futureWriterField: 'opaque-remembered' },
            },
        });

        expect(result).toMatchObject({
            lastEngineSelectionsByScopeV1: {
                'server-a:backend:codex': proposed['server-a:backend:codex'],
                'server-a:backend:future': { v: 2, futureWriterField: 'opaque-remembered' },
            },
        });
    });
});
