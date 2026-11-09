import { describe, expect, it } from 'vitest';

import { FavoriteModelSelectionV1Schema } from '@/sync/domains/models/favoriteModelSelections';
import { RememberedEngineSelectionsByScopeV1Schema } from '@/sync/domains/session/authoring/rememberedEngineSelections';

import {
    attachCurrentSessionAuthoringSelectionsRuntimeProjection as attachFavoriteProjection,
    replayFavoriteModelSelectionReplacementIntent,
    mergeCurrentRememberedEngineSelectionsIntoRaw,
} from './sessionAuthoringSelectionPersistence';
import { authoringMemoryDefaults, projectAuthoringMemory } from '@/sync/store/domains/authoringMemory';
import { LegacyRememberedEngineSelectionsByScopeV1Schema } from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';

function attachCurrentSessionAuthoringSelectionsRuntimeProjection<T extends object>(value: T) {
    const raw = value as Record<string, unknown>;
    const favorites = attachFavoriteProjection(value);
    const authoring = projectAuthoringMemory({ ...authoringMemoryDefaults,
        lastEngineSelectionsByScopeV1: LegacyRememberedEngineSelectionsByScopeV1Schema.parse(raw.lastEngineSelectionsByScopeV1 ?? {}),
    });
    return { ...value, currentFavoriteModelSelectionsV1: favorites.currentFavoriteModelSelectionsV1,
        currentRememberedEngineSelectionsByScopeV1: authoring.currentRememberedEngineSelectionsByScopeV1 };
}

function replayRememberedEngineSelectionReplacementIntent(params: {
    raw: Readonly<Record<string, unknown>>;
    base: import('@/sync/domains/session/authoring/rememberedEngineSelections').RememberedEngineSelectionsByScopeV1;
    proposed: import('@/sync/domains/session/authoring/rememberedEngineSelections').RememberedEngineSelectionsByScopeV1;
}) {
    return { ...params.raw, lastEngineSelectionsByScopeV1: mergeCurrentRememberedEngineSelectionsIntoRaw({
        rawSelections: LegacyRememberedEngineSelectionsByScopeV1Schema.parse(params.raw.lastEngineSelectionsByScopeV1 ?? {}),
        currentSelections: params.base, nextSelections: params.proposed,
    }) };
}

function favorite(modelId: string, updatedAt: number, modelLabel?: string) {
    return FavoriteModelSelectionV1Schema.parse({
        selection: {
            v: 1,
            updatedAt,
            ref: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: null,
                modelId,
            },
        },
        ...(modelLabel ? { modelLabel } : {}),
        addedAtMs: updatedAt,
    });
}

describe('session authoring selection persistence', () => {
    it('projects current and predecessor favorites with extras and removes only the edited retained identity', () => {
        const canonical = favorite('gpt-5.4', 123);
        const rawCurrent = { ...canonical, retired: true, selection: {
            ...canonical.selection, retired: true, ref: { ...canonical.selection.ref, retired: true },
        } };
        const rawLegacy = { backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5.5', addedAtMs: 456, retired: true };
        const raw = { favoriteModelSelectionsV1: [rawCurrent, rawLegacy] };
        const projected = attachFavoriteProjection(raw);
        expect(projected.currentFavoriteModelSelectionsV1).toEqual([canonical, favorite('gpt-5.5', 456)]);
        expect(replayFavoriteModelSelectionReplacementIntent({ raw, base: projected.currentFavoriteModelSelectionsV1, proposed: [canonical] }))
            .toEqual({ favoriteModelSelectionsV1: [rawCurrent] });
        expect(raw.favoriteModelSelectionsV1).toEqual([rawCurrent, rawLegacy]);
    });

    it('replays typed edits on a version-conflict winner without dropping remote opaque additions', () => {
        const initialFavorite = {
            backendTargetKey: 'agent:happier.agent.codex/codex',
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
                'server-a:agent:happier.agent.codex/codex': initialRemembered,
            },
        });
        const remoteOpaqueFavorite = { v: 2, futureWriterField: 'favorite' };
        const remoteOpaqueRemembered = { v: 2, futureWriterField: 'remembered' };
        const conflictWinner = {
            schemaVersion: 7,
            favoriteModelSelectionsV1: [initialFavorite, remoteOpaqueFavorite],
            lastEngineSelectionsByScopeV1: {
                'server-a:agent:happier.agent.codex/codex': initialRemembered,
                'server-a:backend:future': remoteOpaqueRemembered,
            },
        };
        const localFavorite = FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1,
                updatedAt: 456,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5.5',
                },
            },
            addedAtMs: 456,
        });
        const localRemembered = {
            ...initial.currentRememberedEngineSelectionsByScopeV1,
            'server-a:agent:happier.agent.codex/codex': {
                ...initial.currentRememberedEngineSelectionsByScopeV1['server-a:agent:happier.agent.codex/codex']!,
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
                'server-a:agent:happier.agent.codex/codex': localRemembered['server-a:agent:happier.agent.codex/codex'],
                'server-a:backend:future': remoteOpaqueRemembered,
            },
        });
        expect(conflictWinner).toEqual({
            schemaVersion: 7,
            favoriteModelSelectionsV1: [initialFavorite, remoteOpaqueFavorite],
            lastEngineSelectionsByScopeV1: {
                'server-a:agent:happier.agent.codex/codex': initialRemembered,
                'server-a:backend:future': remoteOpaqueRemembered,
            },
        });
    });

    it('fails closed when a typed remembered edit is not valid for the bounded Settings carrier', () => {
        const base = {
            'server-a:agent:happier.agent.codex/codex': {
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
            'server-a:agent:happier.agent.codex/codex': {
                ...base['server-a:agent:happier.agent.codex/codex'],
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
        const scopeKey = 'server-a:agent:happier.agent.codex/codex';
        const base = RememberedEngineSelectionsByScopeV1Schema.parse({
            [scopeKey]: {
                v: 1,
                modelSelection: {
                    v: 1,
                    updatedAt: 1,
                    ref: {
                        agentTargetKey: 'agent:happier.agent.codex/codex',
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
        const scopeKey = 'server-a:agent:happier.agent.codex/codex';
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
        const scopeKey = 'server-a:agent:happier.agent.codex/codex';
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
        const scopeKey = 'server-a:agent:happier.agent.codex/codex';
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
        const scopeKey = 'server-a:agent:happier.agent.codex/codex';
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
