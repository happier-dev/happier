import { describe, expect, it } from 'vitest';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/selection/v1';

import {
    buildFavoriteModelAvailabilityById,
    FavoriteModelSelectionV1Schema,
    StoredFavoriteModelSelectionV1Schema,
    favoriteModelSelectionMatchesBackend,
    resolveAvailableFavoriteModelsForBackend,
    toggleFavoriteModelSelection,
} from './favoriteModelSelections';

describe('favorite model selections', () => {
    it('round trips the chosen effort through the Account favorite and availability projection', () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const backend = { backendTargetKey: agentTargetKey };
        const modelRef = { agentTargetKey, providerConnectionId: null, modelId: 'gpt-5' };
        const [favorite] = toggleFavoriteModelSelection({
            favorites: [], backend, modelRef, reasoningEffort: 'high',
        });
        const stored = StoredFavoriteModelSelectionV1Schema.parse(JSON.parse(JSON.stringify(favorite)));
        expect(stored.reasoningEffort).toBe('high');
        const available = resolveAvailableFavoriteModelsForBackend({
            favorites: [stored], backend,
            availabilityById: buildFavoriteModelAvailabilityById({
                mode: 'static-only', modelOptions: [{ value: 'gpt-5', label: 'GPT-5' }], preflightModels: null,
            }),
        });
        expect(available[0]?.reasoningEffort).toBe('high');
        const previous = FavoriteModelSelectionV1Schema.parse({ selection: favorite.selection });
        expect(previous.reasoningEffort).toBeUndefined();
    });

    it('fails closed when a current favorite carries an unknown field', () => {
        const raw = {
            selection: {
                v: 1,
                updatedAt: 42,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5.5',
                },
            },
            addedAtMs: 42,
            futureWriterField: true,
        };

        expect(FavoriteModelSelectionV1Schema.safeParse(raw).success).toBe(false);
        expect(raw).toHaveProperty('futureWriterField', true);
    });

    it('fails closed rather than stripping an unknown legacy favorite field', () => {
        const raw = {
            backendTargetKey: 'agent:happier.agent.codex/codex',
            modelId: 'gpt-5.5',
            addedAtMs: 42,
            futureWriterField: true,
        };

        expect(FavoriteModelSelectionV1Schema.safeParse(raw).success).toBe(false);
        expect(raw).toHaveProperty('futureWriterField', true);
    });

    it('normalizes a legacy bare favorite into a native structured selection on read', () => {
        const parsed = FavoriteModelSelectionV1Schema.parse({
            backendTargetKey: 'agent:happier.agent.codex/codex',
            modelId: 'gpt-5.5',
            modelLabel: 'GPT 5.5',
            addedAtMs: 42,
        });

        expect(parsed).toEqual({
            selection: {
                v: 1,
                updatedAt: 42,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5.5',
                },
            },
            modelLabel: 'GPT 5.5',
            addedAtMs: 42,
        });
    });

    it('writes a provider-bound structured selection without legacy identity fields', () => {
        const favorites = toggleFavoriteModelSelection({
            favorites: [],
            backend: { backendTargetKey: 'agent:happier.agent.codex/codex', catalogAgentId: 'codex' },
            modelRef: ProviderBoundModelRefSchema.parse({
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: 'pc_work',
                modelId: 'openai/gpt-5.5',
            }),
            modelLabel: 'GPT 5.5',
            addedAtMs: 50,
        });

        expect(favorites).toEqual([{
            selection: {
                v: 1,
                updatedAt: 50,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: 'pc_work',
                    modelId: 'openai/gpt-5.5',
                },
            },
            catalogAgentId: 'codex',
            modelLabel: 'GPT 5.5',
            addedAtMs: 50,
        }]);
        expect(favorites[0]).not.toHaveProperty('backendTargetKey');
        expect(favorites[0]).not.toHaveProperty('modelId');
    });

    it('persists a minimal Provider display snapshot while keeping older favorites readable', () => {
        const providerDisplaySnapshot = {
            providerName: 'Gateway',
            connectionName: 'Work',
            connectionRole: 'named' as const,
            connectionDisplayNameMode: 'custom' as const,
        };
        const favorites = toggleFavoriteModelSelection({
            favorites: [],
            backend: { backendTargetKey: 'agent:happier.agent.codex/codex' },
            modelRef: ProviderBoundModelRefSchema.parse({
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: 'pc_work',
                modelId: 'shared-model',
            }),
            modelLabel: 'Shared model',
            providerDisplaySnapshot,
            addedAtMs: 50,
        });

        expect(favorites[0]).toMatchObject({ providerDisplaySnapshot });
        expect(FavoriteModelSelectionV1Schema.parse({
            selection: favorites[0]!.selection,
            modelLabel: 'Legacy favorite',
        })).not.toHaveProperty('providerDisplaySnapshot');
    });

    it('allows a provider-bound model literally named default while rejecting the native Automatic sentinel', () => {
        const providerFavorites = toggleFavoriteModelSelection({
            favorites: [],
            backend: { backendTargetKey: 'agent:happier.agent.opencode/opencode' },
            modelRef: ProviderBoundModelRefSchema.parse({
                agentTargetKey: 'agent:happier.agent.opencode/opencode',
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'default',
            }),
            addedAtMs: 50,
        });
        const nativeFavorites = toggleFavoriteModelSelection({
            favorites: [],
            backend: { backendTargetKey: 'agent:happier.agent.opencode/opencode' },
            modelRef: {
                agentTargetKey: 'agent:happier.agent.opencode/opencode',
                providerConnectionId: null,
                modelId: 'default',
            },
            addedAtMs: 50,
        });

        expect(providerFavorites).toHaveLength(1);
        expect(providerFavorites[0]?.selection.ref.providerConnectionId).toBe('pc_01J00000000000000000000000');
        expect(nativeFavorites).toEqual([]);
        expect(() => FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1,
                updatedAt: 50,
                ref: {
                    agentTargetKey: 'agent:happier.agent.opencode/opencode',
                    providerConnectionId: null,
                    modelId: 'default',
                },
            },
        })).toThrow();
        expect(FavoriteModelSelectionV1Schema.parse(providerFavorites[0])).toEqual(providerFavorites[0]);
    });

    it('does not treat a native same-id catalog row as availability for a provider favorite', () => {
        const providerFavorite = FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1,
                updatedAt: 50,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: 'pc_01J00000000000000000000000',
                    modelId: 'shared-id',
                },
            },
        });
        const availabilityById = buildFavoriteModelAvailabilityById({
            mode: 'static-only',
            modelOptions: [{ value: 'shared-id', label: 'Native shared id', description: '' }],
            preflightModels: null,
        });

        expect(resolveAvailableFavoriteModelsForBackend({
            favorites: [providerFavorite],
            backend: { backendTargetKey: 'agent:happier.agent.codex/codex' },
            availabilityById,
        })).toEqual([]);
    });

    it('resolves a native extended-context favorite through its descriptor-owned base option', () => {
        const favorite = FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1,
                updatedAt: 50,
                ref: {
                    agentTargetKey: 'agent:happier.agent.claude/claude',
                    providerConnectionId: null,
                    modelId: 'claude-sonnet-4-6[1m]',
                },
            },
        });
        const availabilityById = buildFavoriteModelAvailabilityById({
            mode: 'static-only',
            modelOptions: [{
                value: 'claude-sonnet-4-6',
                label: 'Sonnet 4.6',
                description: 'Balanced',
                extendedContextModelId: 'claude-sonnet-4-6[1m]',
            }],
            preflightModels: null,
        });

        expect(resolveAvailableFavoriteModelsForBackend({
            favorites: [favorite],
            backend: { backendTargetKey: 'agent:happier.agent.claude/claude' },
            availabilityById,
        })).toEqual([expect.objectContaining({
            modelId: 'claude-sonnet-4-6[1m]',
            modelLabel: 'Sonnet 4.6',
        })]);
    });

    it('requires the favorite model ref to match the selected agent target', () => {
        expect(() => toggleFavoriteModelSelection({
            favorites: [],
            backend: { backendTargetKey: 'agent:happier.agent.codex/codex' },
            modelRef: {
                agentTargetKey: 'agent:happier.agent.claude/claude',
                providerConnectionId: null,
                modelId: 'claude-sonnet',
            },
            addedAtMs: 50,
        })).toThrow();
    });

    it('matches canonical favorites by their structured target identity', () => {
        const favorite = FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1,
                updatedAt: 50,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: 'pc_work',
                    modelId: 'openai/gpt-5.5',
                },
            },
        });

        expect(favoriteModelSelectionMatchesBackend(favorite, { backendTargetKey: 'agent:happier.agent.codex/codex' })).toBe(true);
        expect(favoriteModelSelectionMatchesBackend(favorite, { backendTargetKey: 'agent:happier.agent.claude/claude' })).toBe(false);
    });

    it('does not fall back to a shared agent id after canonical target keys differ', () => {
        const favorite = FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1,
                updatedAt: 50,
                ref: {
                    agentTargetKey: 'backend:acp:configured:work',
                    providerConnectionId: null,
                    modelId: 'model-a',
                },
            },
            builtInAgentId: 'acp',
        });

        expect(favoriteModelSelectionMatchesBackend(favorite, {
            backendTargetKey: 'backend:acp:configured:personal',
            builtInAgentId: 'acp',
        })).toBe(false);
    });
});
