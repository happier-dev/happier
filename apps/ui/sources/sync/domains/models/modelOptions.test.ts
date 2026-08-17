import { describe, expect, it } from 'vitest';

import {
    getModelOptionsForAgentType,
    getModelOptionsForModes,
    getModelOptionsForSession,
    getSelectableModelIdsForSession,
    hasDynamicModelListForSession,
    isModelSelectableForSession,
    resolveCanonicalNativeModelSelectionRef,
} from './modelOptions';
import { findModelOptionForEffectiveModelId } from './modelOptions';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol';

function withMetadata(overrides: Partial<Metadata>): Metadata {
    return {
        path: '/tmp/project',
        host: 'localhost',
        ...overrides,
    };
}

describe('modelOptions', () => {
    it('builds generic options for unknown modes', () => {
        const out = getModelOptionsForModes(['gpt-5-low', 'default']);
        expect(out.map((o) => o.value)).toEqual(['gpt-5-low', 'default']);
        expect(out[0].label).toBe('gpt-5-low');
        expect(out[0].description).toBe('');
    });

    it('returns options for agents with configurable model selection', () => {
        const options = getModelOptionsForAgentType('gemini');
        expect(options.map((o) => o.value)).toEqual([
            'default',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-3-flash-preview',
            'gemini-3-pro-preview',
            'gemini-3.1-pro-preview',
        ]);
        expect(options.find((option) => option.value === 'gemini-3.1-pro-preview')).toMatchObject({
            value: 'gemini-3.1-pro-preview',
            label: 'Gemini 3.1 Pro Preview',
            description: expect.any(String),
        });
    });

    it('returns a default-only option for selection-capable agents without static lists', () => {
        expect(getModelOptionsForAgentType('qwen').map((o) => o.value)).toEqual(['default']);
        expect(getModelOptionsForAgentType('kimi').map((o) => o.value)).toEqual(['default']);
    });

    it('returns default-only static options for codex so preflight can provide account-specific models', () => {
        expect(getModelOptionsForAgentType('codex').map((o) => o.value)).toEqual(['default']);
    });

    it('includes a curated static list for Claude while still allowing freeform models', () => {
        const options = getModelOptionsForAgentType('claude');
        const values = options.map((o) => o.value);
        expect(values[0]).toBe('default');
        expect(values.length).toBeGreaterThan(1);
        expect(options.find((option) => option.value === 'claude-opus-4-8')).toMatchObject({
            value: 'claude-opus-4-8',
            label: 'Opus 4.8',
            description: expect.any(String),
            modelOptions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                    options: expect.arrayContaining([
                        expect.objectContaining({ value: 'xhigh' }),
                    ]),
                }),
            ]),
        });
        expect(options.find((option) => option.value === 'claude-opus-4-7')).toMatchObject({
            value: 'claude-opus-4-7',
            label: 'Opus 4.7',
            description: expect.any(String),
            modelOptions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'xhigh',
                    options: expect.arrayContaining([
                        expect.objectContaining({ value: 'xhigh' }),
                    ]),
                }),
            ]),
        });
        expect(options.find((option) => option.value === 'claude-sonnet-4-6')?.extendedContextModelId)
            .toBe('claude-sonnet-4-6[1m]');
    });

    it('prefers ACP session models when present', () => {
        const out = getModelOptionsForSession(
            'opencode',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    agentId: 'opencode',
                    updatedAt: 1,
                    currentModelId: 'model-a',
                    availableModels: [
                        { id: 'model-a', name: 'Model A' },
                        { id: 'model-b', name: 'Model B', description: 'Accurate' },
                    ],
                },
            }),
        );

        expect(out.map((o) => o.value)).toEqual(['default', 'model-a', 'model-b']);
        expect(out[1]?.label).toBe('Model A');
        expect(out[2]?.description).toBe('Accurate');
    });

    it('preserves dynamic session model ids, labels, and descriptions from metadata', () => {
        const out = getModelOptionsForSession(
            'codex',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    agentId: 'codex',
                    updatedAt: 1,
                    currentModelId: 'gpt-5.4',
                    availableModels: [
                        {
                            id: 'gpt-5.4',
                            name: 'GPT-5.4',
                            description: 'Latest frontier coding model.',
                        },
                    ],
                },
            }),
        );

        expect(out[1]).toEqual({
            value: 'gpt-5.4',
            label: 'GPT-5.4',
            description: 'Latest frontier coding model.',
        });
    });

    it('ignores stale dynamic session model rows for static-only providers and uses the static catalog', () => {
        const staticClaudeValues = getModelOptionsForAgentType('claude').map((option) => option.value);
        const out = getModelOptionsForSession(
            'claude',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    agentId: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-opus-4-6',
                    availableModels: [
                        { id: 'claude-opus-4-6', name: 'Opus 4.6 (From Session)' },
                        { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6 (From Session)' },
                    ],
                },
            }),
        );

        expect(out.map((option) => option.value)).toEqual(staticClaudeValues);
        expect(out.find((option) => option.value === 'claude-opus-4-6')).toMatchObject({
            label: 'Opus 4.6',
            modelOptions: expect.arrayContaining([
                expect.objectContaining({ id: 'reasoning_effort' }),
            ]),
        });
        expect(out.find((option) => option.value === 'claude-sonnet-4-6')).toMatchObject({
            label: 'Sonnet 4.6',
        });
    });

    it('names the model id on in-session rows a duplicate label would otherwise make indistinguishable', () => {
        const out = getModelOptionsForSession(
            'claude',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    agentId: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-opus-4-5-20251101',
                    availableModels: [
                        { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5' },
                        { id: 'claude-opus-4-6', name: 'Opus 4.6' },
                    ],
                },
            } as unknown as Partial<Metadata>),
        );

        const pinned = out.find((option) => option.value === 'claude-opus-4-5-20251101');
        const alias = out.find((option) => option.value === 'claude-opus-4-5');
        expect(pinned?.label).toBe('Opus 4.5');
        expect(alias?.label).toBe('Opus 4.5');
        expect(pinned?.description).toBe('claude-opus-4-5-20251101');
        expect(alias?.description).toBe('claude-opus-4-5');
        expect(out.find((option) => option.value === 'claude-opus-4-6')?.description)
            .not.toBe('claude-opus-4-6');
    });

    it('treats ACP session models as selectable', () => {
        const metadata = withMetadata({
            sessionModelsV1: {
                v: 1,
                agentId: 'opencode',
                updatedAt: 1,
                currentModelId: 'model-a',
                availableModels: [{ id: 'model-a', name: 'Model A' }],
            },
        });

        expect(isModelSelectableForSession('opencode', metadata, 'model-a')).toBe(true);
        expect(isModelSelectableForSession('opencode', metadata, 'default')).toBe(true);
        // Some providers accept custom model IDs even when a dynamic list is available.
        expect(isModelSelectableForSession('opencode', metadata, 'not-a-model')).toBe(true);
    });

    it('treats static and Gemini-prefixed Gemini models as selectable', () => {
        expect(isModelSelectableForSession('gemini', null, 'gemini-2.5-pro')).toBe(true);
        expect(isModelSelectableForSession('gemini', null, 'models/gemini-3.5-flash')).toBe(true);
        expect(isModelSelectableForSession('gemini', null, 'publishers/google/models/gemini-3.5-flash')).toBe(true);
        expect(isModelSelectableForSession('gemini', null, 'default')).toBe(true);
        expect(isModelSelectableForSession('gemini', null, 'model-a')).toBe(false);
        expect(isModelSelectableForSession('gemini', null, 'gpt-5.5')).toBe(false);
        expect(isModelSelectableForSession('gemini', null, '   ')).toBe(false);
    });

    it('treats Claude models as freeform-selectable when configured', () => {
        expect(isModelSelectableForSession('claude', null, 'claude-3.5-sonnet')).toBe(true);
        expect(isModelSelectableForSession('claude', null, 'default')).toBe(true);
        expect(isModelSelectableForSession('claude', null, '   ')).toBe(false);
    });

    it('adds metadata override model into options for freeform providers when not in static list', () => {
        const out = getModelOptionsForSession(
            'claude',
            withMetadata({
                modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'claude-custom-model' },
            }),
        );

        expect(out.some((option) => option.value === 'claude-custom-model')).toBe(true);
    });

    it('adds a canonical provider-bound selection into options without reading the legacy override field', () => {
        const out = getModelOptionsForSession(
            'claude',
            withMetadata({
                modelSelectionIntentV1: SessionModelSelectionIntentV1Schema.parse({
                    v: 1,
                    updatedAt: 101,
                    selection: {
                        agentTargetKey: 'backend:claude',
                        providerConnectionId: 'pc_01J00000000000000000000000',
                        modelId: 'provider-custom-model',
                    },
                }),
            }),
        );

        expect(out.some((option) => option.value === 'provider-custom-model')).toBe(true);
    });

    it('appends custom metadata override models after the static catalog for static-only providers', () => {
        const staticClaudeValues = getModelOptionsForAgentType('claude').map((option) => option.value);
        const out = getModelOptionsForSession(
            'claude',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    agentId: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-sonnet-4-6',
                    availableModels: [
                        { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6 (From Session)' },
                    ],
                },
                modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'claude-custom-model' },
            }),
        );

        expect(out.map((option) => option.value)).toEqual([
            ...staticClaudeValues,
            'claude-custom-model',
        ]);
    });

    it('derives selectable ids from the same static-only session model policy for freeform providers', () => {
        const staticClaudeValues = getModelOptionsForAgentType('claude').map((option) => option.value);
        const metadata = withMetadata({
            sessionModelsV1: {
                v: 1,
                agentId: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-sonnet-4-6',
                availableModels: [
                    { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6 (From Session)' },
                ],
            },
            modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'claude-custom-model' },
        });

        expect(getSelectableModelIdsForSession('claude', metadata)).toEqual([
            ...staticClaudeValues,
            'claude-custom-model',
        ]);
    });

    it('adds metadata override model into options for Gemini when freeform is enabled', () => {
        const out = getModelOptionsForSession(
            'gemini',
            withMetadata({
                modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'gemini-custom-model' },
            }),
        );

        expect(out.some((option) => option.value === 'gemini-custom-model')).toBe(true);
    });

    it('does not add stale cross-provider metadata override models for constrained freeform providers', () => {
        const out = getModelOptionsForSession(
            'gemini',
            withMetadata({
                modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'gpt-5.5' },
            }),
        );

        expect(out.some((option) => option.value === 'gpt-5.5')).toBe(false);
    });

    it('falls back to static options when dynamic list provider does not match agent', () => {
        const out = getModelOptionsForSession(
            'opencode',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    agentId: 'claude',
                    updatedAt: 1,
                    currentModelId: 'model-a',
                    availableModels: [{ id: 'model-a', name: 'Model A' }],
                },
            }),
        );

        expect(out.map((option) => option.value)).toEqual(['default']);
    });

    it('detects dynamic list support only for matching provider metadata', () => {
        expect(
            hasDynamicModelListForSession(
                'opencode',
                withMetadata({
                    sessionModelsV1: {
                        v: 1,
                        agentId: 'opencode',
                        updatedAt: 1,
                        currentModelId: 'model-a',
                        availableModels: [{ id: 'model-a', name: 'Model A' }],
                    },
                }),
            ),
        ).toBe(true);

        expect(
            hasDynamicModelListForSession(
                'opencode',
                withMetadata({
                    sessionModelsV1: {
                        v: 1,
                        agentId: 'gemini',
                        updatedAt: 1,
                        currentModelId: 'model-a',
                        availableModels: [{ id: 'model-a', name: 'Model A' }],
                    },
                }),
            ),
        ).toBe(false);
    });

    it('does not treat static-only provider metadata as dynamic list support', () => {
        expect(
            hasDynamicModelListForSession(
                'claude',
                withMetadata({
                    sessionModelsV1: {
                        v: 1,
                        agentId: 'claude',
                        updatedAt: 1,
                        currentModelId: 'claude-haiku-4-5',
                        availableModels: [{ id: 'haiku', name: 'Haiku' }],
                    },
                }),
            ),
        ).toBe(false);
    });

    it('falls back to legacy ACP session models when canonical key is absent', () => {
        const out = getModelOptionsForSession(
            'opencode',
            withMetadata({
                acpSessionModelsV1: {
                    v: 1,
                    agentId: 'opencode',
                    updatedAt: 1,
                    currentModelId: 'model-a',
                    availableModels: [{ id: 'model-a', name: 'Model A' }],
                },
            }),
        );

        expect(out.map((o) => o.value)).toEqual(['default', 'model-a']);
    });
});

describe('findModelOptionForEffectiveModelId', () => {
    const options = [
        { value: 'default', label: 'Default', description: '' },
        {
            value: 'claude-sonnet-4-6',
            label: 'Sonnet 4.6',
            description: 'Balanced',
            extendedContextModelId: 'claude-sonnet-4-6[1m]',
        },
        { value: 'claude-fable-5', label: 'Fable 5', description: 'Newest' },
    ] as any;

    it('matches an exact model id', () => {
        expect(findModelOptionForEffectiveModelId(options, 'claude-fable-5')?.value).toBe('claude-fable-5');
    });

    it('matches an explicitly declared extended-context id to its base model option', () => {
        expect(findModelOptionForEffectiveModelId(options, 'claude-sonnet-4-6[1m]')?.value).toBe('claude-sonnet-4-6');
    });

    it('does not infer undeclared bracket variants', () => {
        expect(findModelOptionForEffectiveModelId(options, 'claude-fable-5[preview]')).toBeNull();
    });

    it('matches an unqualified model id only when one provider-qualified option owns it', () => {
        const qualifiedOptions = [
            ...options,
            { value: 'openai-codex/gpt-5.6-luna', label: 'Luna', description: 'Codex' },
        ];

        expect(findModelOptionForEffectiveModelId(qualifiedOptions, 'gpt-5.6-luna')?.value)
            .toBe('openai-codex/gpt-5.6-luna');

        const ambiguous = [
            ...qualifiedOptions,
            { value: 'openai/gpt-5.6-luna', label: 'Luna', description: 'OpenAI' },
        ];
        expect(findModelOptionForEffectiveModelId(ambiguous, 'gpt-5.6-luna')).toBeNull();
    });

    it('returns null when nothing matches', () => {
        expect(findModelOptionForEffectiveModelId(options, 'gpt-5')).toBeNull();
        expect(findModelOptionForEffectiveModelId(options, 'private-custom-model')).toBeNull();
        expect(findModelOptionForEffectiveModelId(options, '')).toBeNull();
    });
});

describe('resolveCanonicalNativeModelSelectionRef', () => {
    it('projects only a unique native alias and preserves ambiguous and Provider-bound identities', () => {
        const options = [
            { value: 'openai-codex/gpt-5.6-luna' },
            { value: 'openai/gpt-shared' },
            { value: 'openai-codex/gpt-shared' },
        ];
        const nativeAlias = {
            agentTargetKey: 'backend:pi',
            providerConnectionId: null,
            modelId: 'gpt-5.6-luna',
        };
        expect(resolveCanonicalNativeModelSelectionRef(options, nativeAlias)).toEqual({
            ...nativeAlias,
            modelId: 'openai-codex/gpt-5.6-luna',
        });

        const ambiguous = { ...nativeAlias, modelId: 'gpt-shared' };
        expect(resolveCanonicalNativeModelSelectionRef(options, ambiguous)).toBe(ambiguous);

        const providerBound = {
            ...nativeAlias,
            providerConnectionId: 'pc_openai',
        };
        expect(resolveCanonicalNativeModelSelectionRef(options, providerBound)).toBe(providerBound);
    });
});
