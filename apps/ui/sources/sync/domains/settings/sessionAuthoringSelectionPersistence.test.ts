import { describe, expect, it } from 'vitest';

import { FavoriteModelSelectionV1Schema } from '@/sync/domains/models/favoriteModelSelections';
import { RememberedEngineSelectionsByScopeV1Schema } from '@/sync/domains/session/authoring/rememberedEngineSelections';

import {
    attachCurrentSessionAuthoringSelectionsRuntimeProjection,
    replayFavoriteModelSelectionReplacementIntent,
    replayRememberedEngineSelectionReplacementIntent,
} from './sessionAuthoringSelectionPersistence';

function favorite(modelId: string, updatedAt: number, modelLabel?: string) {
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
        ...(modelLabel ? { modelLabel } : {}),
        addedAtMs: updatedAt,
    });
}

describe('session authoring selection persistence', () => {
    it('replays typed edits on a version-conflict winner without dropping remote opaque additions', () => {
        const initialFavorite = {
            backendTargetKey: 'backend:codex',
            modelId: 'gpt-5.4',
            addedAtMs: 123,
        };
        const initialRemembered = {
            v: 1,
            modelId: 'gpt-5.4',
            updatedAt: 123,
        };
        const initial = attachCurrentSessionAuthoringSelectionsRuntimeProjection({
            favoriteModelSelectionsV1: [initialFavorite],
            lastEngineSelectionsByScopeV1: {
                'server-a:backend:codex': initialRemembered,
            },
        });
        const remoteOpaqueFavorite = { v: 2, futureWriterField: 'favorite' };
        const remoteOpaqueRemembered = { v: 2, futureWriterField: 'remembered' };
        const conflictWinner = {
            schemaVersion: 7,
            favoriteModelSelectionsV1: [initialFavorite, remoteOpaqueFavorite],
            lastEngineSelectionsByScopeV1: {
                'server-a:backend:codex': initialRemembered,
                'server-a:backend:future': remoteOpaqueRemembered,
            },
        };
        const localFavorite = FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1,
                updatedAt: 456,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5.5',
                },
            },
            addedAtMs: 456,
        });
        const localRemembered = {
            ...initial.currentRememberedEngineSelectionsByScopeV1,
            'server-a:backend:codex': {
                ...initial.currentRememberedEngineSelectionsByScopeV1['server-a:backend:codex']!,
                updatedAt: 456,
            },
        };

        const afterFavoriteReplay = replayFavoriteModelSelectionReplacementIntent({
            raw: conflictWinner,
            base: initial.currentFavoriteModelSelectionsV1,
            proposed: [...initial.currentFavoriteModelSelectionsV1, localFavorite],
        });
        const afterRememberedReplay = replayRememberedEngineSelectionReplacementIntent({
            raw: afterFavoriteReplay,
            base: initial.currentRememberedEngineSelectionsByScopeV1,
            proposed: localRemembered,
        });

        expect(afterRememberedReplay).toMatchObject({
            schemaVersion: 7,
            favoriteModelSelectionsV1: [
                initialFavorite,
                remoteOpaqueFavorite,
                localFavorite,
            ],
            lastEngineSelectionsByScopeV1: {
                'server-a:backend:codex': localRemembered['server-a:backend:codex'],
                'server-a:backend:future': remoteOpaqueRemembered,
            },
        });
        expect(conflictWinner).toEqual({
            schemaVersion: 7,
            favoriteModelSelectionsV1: [initialFavorite, remoteOpaqueFavorite],
            lastEngineSelectionsByScopeV1: {
                'server-a:backend:codex': initialRemembered,
                'server-a:backend:future': remoteOpaqueRemembered,
            },
        });
    });

    it('fails closed when a typed remembered edit is not valid for the bounded Settings carrier', () => {
        const base = {
            'server-a:backend:codex': {
                v: 1 as const,
                modelSelection: null,
                updatedAt: 1,
            },
        };
        const raw = {
            lastEngineSelectionsByScopeV1: base,
        };
        const proposed = {
            ...base,
            'server-a:backend:codex': {
                ...base['server-a:backend:codex'],
                sessionConfigOptionOverrides: {
                    v: 1 as const,
                    updatedAt: 2,
                    overrides: {},
                    nonPersistableFutureValue: () => undefined,
                },
                updatedAt: 2,
            },
        };

        expect(replayRememberedEngineSelectionReplacementIntent({
            raw,
            base,
            proposed,
        })).toEqual(raw);
    });

    it('keeps a concurrent opaque remembered value at a previously typed scope', () => {
        const scopeKey = 'server-a:backend:codex';
        const base = RememberedEngineSelectionsByScopeV1Schema.parse({
            [scopeKey]: {
                v: 1,
                modelSelection: {
                    v: 1,
                    updatedAt: 1,
                    ref: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: null,
                        modelId: 'gpt-5.4',
                    },
                },
                updatedAt: 1,
            },
        });
        const proposed = {
            ...base,
            [scopeKey]: {
                ...base[scopeKey]!,
                updatedAt: 2,
            },
        };
        const opaqueWinner = { v: 2, futureWriterField: 'opaque-winner' };

        expect(replayRememberedEngineSelectionReplacementIntent({
            raw: {
                lastEngineSelectionsByScopeV1: {
                    [scopeKey]: opaqueWinner,
                },
            },
            base,
            proposed,
        })).toMatchObject({
            lastEngineSelectionsByScopeV1: {
                [scopeKey]: opaqueWinner,
            },
        });
    });

    it('keeps a concurrent typed Favorite winner for the same model identity', () => {
        const baseFavorite = favorite('gpt-5.4', 1, 'Rendered label');
        const proposedFavorite = favorite('gpt-5.4', 2, 'Local label');
        const concurrentFavorite = favorite('gpt-5.4', 3, 'Remote label');

        expect(replayFavoriteModelSelectionReplacementIntent({
            raw: { favoriteModelSelectionsV1: [concurrentFavorite] },
            base: [baseFavorite],
            proposed: [proposedFavorite],
        })).toMatchObject({
            favoriteModelSelectionsV1: [concurrentFavorite],
        });
    });

    it('does not resurrect a locally replaced Favorite after the CAS winner deleted that identity', () => {
        const baseFavorite = favorite('gpt-5.4', 1, 'Rendered label');
        const proposedFavorite = favorite('gpt-5.4', 2, 'Local label');

        expect(replayFavoriteModelSelectionReplacementIntent({
            raw: { favoriteModelSelectionsV1: [] },
            base: [baseFavorite],
            proposed: [proposedFavorite],
        })).toMatchObject({
            favoriteModelSelectionsV1: [],
        });
    });

    it('fails closed instead of exceeding the bounded Favorite carrier', () => {
        const proposed = Array.from({ length: 257 }, (_, index) => favorite(`model-${index}`, index));

        expect(replayFavoriteModelSelectionReplacementIntent({
            raw: { favoriteModelSelectionsV1: [] },
            base: [],
            proposed,
        })).toEqual({
            favoriteModelSelectionsV1: [],
        });
    });

    it('keeps a concurrent typed remembered winner instead of replacing it with a stale local edit', () => {
        const scopeKey = 'server-a:backend:codex';
        const base = RememberedEngineSelectionsByScopeV1Schema.parse({
            [scopeKey]: {
                v: 1,
                modelSelection: favorite('gpt-5.4', 1).selection,
                updatedAt: 1,
            },
        });
        const proposed = {
            ...base,
            [scopeKey]: {
                ...base[scopeKey]!,
                modelSelection: favorite('gpt-5.5', 2).selection,
                updatedAt: 2,
            },
        };
        const concurrent = RememberedEngineSelectionsByScopeV1Schema.parse({
            [scopeKey]: {
                v: 1,
                modelSelection: favorite('gpt-5.6', 3).selection,
                updatedAt: 3,
            },
        });

        expect(replayRememberedEngineSelectionReplacementIntent({
            raw: { lastEngineSelectionsByScopeV1: concurrent },
            base,
            proposed,
        })).toMatchObject({
            lastEngineSelectionsByScopeV1: concurrent,
        });
    });

    it('does not resurrect a locally edited remembered scope after the CAS winner deleted it', () => {
        const scopeKey = 'server-a:backend:codex';
        const base = RememberedEngineSelectionsByScopeV1Schema.parse({
            [scopeKey]: {
                v: 1,
                modelSelection: favorite('gpt-5.4', 1).selection,
                updatedAt: 1,
            },
        });
        const proposed = {
            ...base,
            [scopeKey]: {
                ...base[scopeKey]!,
                updatedAt: 2,
            },
        };

        expect(replayRememberedEngineSelectionReplacementIntent({
            raw: { lastEngineSelectionsByScopeV1: {} },
            base,
            proposed,
        })).toEqual({
            lastEngineSelectionsByScopeV1: {},
        });
    });

    it('treats a padded equivalent scope key as the same opaque CAS winner', () => {
        const scopeKey = 'server-a:backend:codex';
        const paddedScopeKey = ` ${scopeKey} `;
        const base = RememberedEngineSelectionsByScopeV1Schema.parse({
            [scopeKey]: {
                v: 1,
                modelSelection: favorite('gpt-5.4', 1).selection,
                updatedAt: 1,
            },
        });
        const proposed = {
            ...base,
            [scopeKey]: {
                ...base[scopeKey]!,
                updatedAt: 2,
            },
        };
        const opaqueWinner = { v: 2, futureWriterField: 'opaque-winner' };

        const replayed = replayRememberedEngineSelectionReplacementIntent({
            raw: {
                lastEngineSelectionsByScopeV1: {
                    [paddedScopeKey]: opaqueWinner,
                },
            },
            base,
            proposed,
        });

        expect(replayed).toMatchObject({
            lastEngineSelectionsByScopeV1: {
                [paddedScopeKey]: opaqueWinner,
            },
        });
        expect(replayed.lastEngineSelectionsByScopeV1).not.toHaveProperty(scopeKey);
    });

    it('contracts a padded typed scope alias when its value still matches the rendered base', () => {
        const scopeKey = 'server-a:backend:codex';
        const paddedScopeKey = ` ${scopeKey} `;
        const base = RememberedEngineSelectionsByScopeV1Schema.parse({
            [scopeKey]: {
                v: 1,
                modelSelection: favorite('gpt-5.4', 1).selection,
                updatedAt: 1,
            },
        });
        const proposed = {
            ...base,
            [scopeKey]: {
                ...base[scopeKey]!,
                updatedAt: 2,
            },
        };

        const replayed = replayRememberedEngineSelectionReplacementIntent({
            raw: {
                lastEngineSelectionsByScopeV1: {
                    [paddedScopeKey]: base[scopeKey],
                },
            },
            base,
            proposed,
        });

        expect(replayed).toEqual({
            lastEngineSelectionsByScopeV1: {
                [scopeKey]: proposed[scopeKey],
            },
        });
    });
});
