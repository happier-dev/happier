import { describe, expect, it } from 'vitest';
import { parsePreflightModelListFromProbeModelsResult } from './parsePreflightModelListFromProbeModelsResult';

import {
    findModelOptionForEffectiveModelId,
    getModelOptionsForAgentType,
    getModelOptionsForModes,
    getModelOptionsForPreflightModelList,
    getModelOptionsForSession,
    getSelectableModelIdsForSession,
    hasDynamicModelListForSession,
    isModelSelectableForSession,
    supportsFreeformModelSelectionForSession,
} from './modelOptions';
import { MetadataSchema, type Metadata } from '@/sync/domains/state/storageTypes';

function withMetadata(overrides: Partial<Metadata>): Metadata {
    return {
        path: '/tmp/project',
        host: 'localhost',
        ...overrides,
    };
}

describe('modelOptions', () => {
    it('keeps all discovered MiniMax models selectable across preflight and session refreshes', () => {
        const modelIds = ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M3', 'MiniMax-M3.1-Flash', 'speech-02-hd'];
        const availableModels = modelIds.map(id => ({ id, name: id }));
        // Obsolete presentation metadata must not override the discovered catalog.
        const miniMaxModelChoices = { provider: 'minimax', configuredModelIds: ['MiniMax-M2.5'] };
        const preflight = parsePreflightModelListFromProbeModelsResult({ availableModels, miniMaxModelChoices, supportsFreeform: true })!;
        const expectedChoices = ['default', ...modelIds];
        expect(getModelOptionsForPreflightModelList(preflight).map(row => row.value)).toEqual(expectedChoices);

        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            sessionModelsV1: {
                v: 1, provider: 'claude', updatedAt: 2, currentModelId: 'MiniMax-M2.7', availableModels, miniMaxModelChoices,
            },
        });
        expect(getModelOptionsForSession('claude', metadata).map(row => row.value)).toEqual(expectedChoices);
        expect(getModelOptionsForSession('claude', metadata, {
            preflight,
            preflightUpdatedAt: 3,
        }).map(row => row.value)).toEqual(expectedChoices);
        expect(availableModels.map(row => row.id)).toEqual(modelIds);
    });
    it('uses refreshed models for both session choices and non-freeform validation', () => {
        const metadata = withMetadata({
            sessionModelsV1: { v: 1, provider: 'grok', updatedAt: 1, currentModelId: 'old', availableModels: [{ id: 'old', name: 'Old' }] },
        });
        const preflight = { availableModels: [{ id: 'new', name: 'New' }], supportsFreeform: false };
        expect(getModelOptionsForSession('grok', metadata, { preflight, preflightUpdatedAt: 2 }).map((row) => row.value)).toEqual(['default', 'new']);
        expect(getSelectableModelIdsForSession('grok', metadata, { preflight, preflightUpdatedAt: 2 })).toEqual(['default', 'new']);
        expect(isModelSelectableForSession('grok', metadata, 'new', { preflight, preflightUpdatedAt: 2 })).toBe(true);
        expect(isModelSelectableForSession('grok', metadata, 'old', { preflight, preflightUpdatedAt: 2 })).toBe(false);
    });

    it('retains an explicit freeform selection without restoring unadvertised static rows', () => {
        const metadata = withMetadata({ modelOverrideV1: { v: 1, modelId: 'my-model', updatedAt: 1 } });
        const preflight = { availableModels: [{ id: 'discovered', name: 'Discovered' }], supportsFreeform: true };
        expect(getModelOptionsForSession('claude', metadata, { preflight }).map((row) => row.value)).toEqual(['default', 'discovered', 'my-model']);
    });

    it('matches configured ACP model metadata to its exact backend', () => {
        const metadata = withMetadata({
            flavor: 'acp:custom-one',
            acpConfiguredBackendV1: { v: 1, backendId: 'custom-one', title: 'Custom', updatedAt: 1 },
            sessionModelsV1: { v: 1, provider: 'acp:custom-one', updatedAt: 1, currentModelId: 'custom-model', availableModels: [{ id: 'custom-model', name: 'Custom Model' }] },
        });
        expect(getModelOptionsForSession('customAcp', metadata).map((row) => row.value)).toEqual(['default', 'custom-model']);
        expect(hasDynamicModelListForSession('customAcp', metadata)).toBe(true);
        const otherBackend = withMetadata({ ...metadata, acpConfiguredBackendV1: { v: 1, backendId: 'custom-two', title: 'Other', updatedAt: 2 } });
        expect(getModelOptionsForSession('customAcp', otherBackend).map((row) => row.value)).toEqual(['default']);
        expect(hasDynamicModelListForSession('customAcp', otherBackend)).toBe(false);
    });

    it('resolves discovery and session freshness once for choices and validation', () => {
        const metadata = withMetadata({
            sessionModelsV1: { v: 1, provider: 'grok', updatedAt: 20, currentModelId: 'runtime', availableModels: [{ id: 'runtime', name: 'Runtime' }] },
        });
        const preflight = { availableModels: [{ id: 'discovered', name: 'Discovered' }], supportsFreeform: false };
        const stale = { preflight, preflightUpdatedAt: 10 };
        const fresh = { preflight, preflightUpdatedAt: 30 };
        expect(getModelOptionsForSession('grok', metadata, { preflight, preflightUpdatedAt: null }).map((row) => row.value)).toEqual(['default', 'runtime']);
        expect(getModelOptionsForSession('grok', null, { preflight, preflightUpdatedAt: null }).map((row) => row.value)).toEqual(['default', 'discovered']);
        expect(getModelOptionsForSession('grok', metadata, stale).map((row) => row.value)).toEqual(['default', 'runtime']);
        expect(isModelSelectableForSession('grok', metadata, 'discovered', stale)).toBe(false);
        expect(getModelOptionsForSession('grok', metadata, fresh).map((row) => row.value)).toEqual(['default', 'discovered']);
        expect(isModelSelectableForSession('grok', metadata, 'discovered', fresh)).toBe(true);
    });

    it('keeps the requested model visible without marking the applied model as requested', () => {
        const metadata = withMetadata({
            sessionAppliedModelV1: { v: 1, provider: 'grok', updatedAt: 1, modelId: 'applied' },
            modelOverrideV1: { v: 1, updatedAt: 2, modelId: 'requested' },
        });
        const preflight = { availableModels: [], supportsFreeform: false };
        expect(getModelOptionsForSession('grok', metadata, { preflight }).map((row) => row.value)).toEqual(['default', 'requested']);
        expect(getModelOptionsForSession('grok', metadata, { preflight, selectedModelId: 'local-choice' }).map((row) => row.value)).toEqual(['default', 'local-choice']);
        expect(isModelSelectableForSession('grok', metadata, 'unrequested', { preflight })).toBe(false);
    });

    it('keeps a newer empty session catalog authoritative over stale discovery', () => {
        const metadata = withMetadata({ sessionModelsV1: {
            v: 1, provider: 'claude', updatedAt: 20, currentModelId: 'old', availableModels: [],
        } });
        const context = { preflight: { availableModels: [{ id: 'old', name: 'Old' }], supportsFreeform: true }, preflightUpdatedAt: 10 };
        expect(getModelOptionsForSession('claude', metadata, context).map((row) => row.value)).toEqual(['default']);
        expect(hasDynamicModelListForSession('claude', metadata)).toBe(true);
        metadata.sessionModelsV1 = { ...metadata.sessionModelsV1!, updatedAt: 0 };
        expect(getModelOptionsForSession('claude', metadata).length).toBeGreaterThan(1);
    });

    it('uses the selected discovery freeform policy for both entry and validation', () => {
        const context = { preflight: { availableModels: [{ id: 'discovered', name: 'Discovered' }], supportsFreeform: false } };
        expect(supportsFreeformModelSelectionForSession('pi', null, context)).toBe(false);
        expect(isModelSelectableForSession('pi', null, 'custom', context)).toBe(false);
        expect(isModelSelectableForSession('pi', null, 'discovered', context)).toBe(true);
    });

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
            'auto',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-3-flash-preview',
            'gemini-3-pro-preview',
            'gemini-3.1-pro-preview',
        ]);
        expect(options.find((option) => option.value === 'auto')).toMatchObject({
            value: 'auto',
            label: 'Auto',
            description: expect.any(String),
        });
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
        expect(options.find((option) => option.value === 'claude-fable-5')).toMatchObject({
            value: 'claude-fable-5',
            label: 'Fable 5',
            description: expect.any(String),
            modelOptions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'reasoning_effort',
                    currentValue: 'high',
                    options: expect.arrayContaining([
                        expect.objectContaining({ value: 'xhigh' }),
                        expect.objectContaining({ value: 'max' }),
                    ]),
                }),
            ]),
        });
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
    });

    it('prefers ACP session models when present', () => {
        const out = getModelOptionsForSession(
            'opencode',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'opencode',
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

    it('names the model id on in-session rows a duplicate label would otherwise make indistinguishable', () => {
        const out = getModelOptionsForSession(
            'claude',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-opus-4-5-20251101',
                    availableModels: [
                        { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5' },
                        { id: 'claude-opus-4-5', name: 'Opus 4.5' },
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

    it('preserves dynamic session model ids, labels, and descriptions from metadata', () => {
        const out = getModelOptionsForSession(
            'codex',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'codex',
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
        const staticKiroValues = getModelOptionsForAgentType('kiro').map((option) => option.value);
        const out = getModelOptionsForSession(
            'kiro',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'kiro',
                    updatedAt: 1,
                    currentModelId: 'kiro-from-session',
                    availableModels: [
                        { id: 'kiro-from-session', name: 'Kiro (From Session)' },
                    ],
                },
            }),
        );

        expect(out.map((option) => option.value)).toEqual(staticKiroValues);
        expect(out.some((option) => option.value === 'kiro-from-session')).toBe(false);
    });

    it('does not restore an unadvertised extended-context capability from the static catalog', () => {
        const out = getModelOptionsForSession(
            'claude',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-sonnet-4-6',
                    availableModels: [{ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6 (From Session)' }],
                },
            }),
        );

        const staticSonnet = getModelOptionsForAgentType('claude')
            .find((option) => option.value === 'claude-sonnet-4-6') ?? null;
        expect(staticSonnet?.extendedContextModelId).toBeTruthy();
        expect(out.find((option) => option.value === 'claude-sonnet-4-6')?.extendedContextModelId)
            .toBeUndefined();
    });

    it('carries an extended-context variant declared by the dynamic source itself', () => {
        const out = getModelOptionsForPreflightModelList({
            availableModels: [
                { id: 'claude-opus-9', name: 'Opus 9', extendedContextModelId: 'claude-opus-9[1m]' },
            ],
            supportsFreeform: true,
        });

        expect(out.find((option) => option.value === 'claude-opus-9')?.extendedContextModelId)
            .toBe('claude-opus-9[1m]');
    });

    it('uses the published session model list for Claude and keeps the static catalog as the fallback', () => {
        const withSession = getModelOptionsForSession(
            'claude',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'claude',
                    updatedAt: 1,
                    currentModelId: 'claude-opus-4-6',
                    availableModels: [
                        { id: 'claude-opus-4-6', name: 'Opus 4.6 (From Session)' },
                        { id: 'claude-opus-9', name: 'Opus 9 (Discovered)' },
                    ],
                },
            }),
        );

        // Published membership is authoritative; the static catalog enriches matching rows.
        const values = withSession.map((option) => option.value);
        expect(values).toEqual(['default', 'claude-opus-4-6', 'claude-opus-9']);
        expect(withSession.find((option) => option.value === 'claude-opus-9')?.label)
            .toBe('Opus 9 (Discovered)');

        const staticOnly = getModelOptionsForSession('claude', withMetadata({}));
        expect(staticOnly.map((option) => option.value))
            .toEqual(getModelOptionsForAgentType('claude').map((option) => option.value));
        expect(staticOnly.find((option) => option.value === 'claude-opus-4-6')).toMatchObject({
            label: 'Opus 4.6',
            modelOptions: expect.arrayContaining([
                expect.objectContaining({ id: 'reasoning_effort' }),
            ]),
        });
    });

    it('treats ACP session models as selectable', () => {
        const metadata = withMetadata({
            sessionModelsV1: {
                v: 1,
                provider: 'opencode',
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

    it('treats static Gemini models as selectable', () => {
        expect(isModelSelectableForSession('gemini', null, 'gemini-2.5-pro')).toBe(true);
        expect(isModelSelectableForSession('gemini', null, 'default')).toBe(true);
        expect(isModelSelectableForSession('gemini', null, 'model-a')).toBe(true);
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

    it('appends custom metadata override models after the static catalog for static-only providers', () => {
        const staticKiroValues = getModelOptionsForAgentType('kiro').map((option) => option.value);
        const out = getModelOptionsForSession(
            'kiro',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'kiro',
                    updatedAt: 1,
                    currentModelId: 'kiro-from-session',
                    availableModels: [
                        { id: 'kiro-from-session', name: 'Kiro (From Session)' },
                    ],
                },
                modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'kiro-custom-model' },
            }),
        );

        expect(out.map((option) => option.value)).toEqual([
            ...staticKiroValues,
            'kiro-custom-model',
        ]);
    });

    it('derives selectable ids from the same static-only session model policy for freeform providers', () => {
        const staticKiroValues = getModelOptionsForAgentType('kiro').map((option) => option.value);
        const metadata = withMetadata({
            sessionModelsV1: {
                v: 1,
                provider: 'kiro',
                updatedAt: 1,
                currentModelId: 'kiro-from-session',
                availableModels: [
                    { id: 'kiro-from-session', name: 'Kiro (From Session)' },
                ],
            },
            modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'kiro-custom-model' },
        });

        expect(getSelectableModelIdsForSession('kiro', metadata)).toEqual([
            ...staticKiroValues,
            'kiro-custom-model',
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

    it('falls back to static options when dynamic list provider does not match agent', () => {
        const out = getModelOptionsForSession(
            'opencode',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'claude',
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
                        provider: 'opencode',
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
                        provider: 'gemini',
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
                'kiro',
                withMetadata({
                    sessionModelsV1: {
                        v: 1,
                        provider: 'kiro',
                        updatedAt: 1,
                        currentModelId: 'kiro-from-session',
                        availableModels: [{ id: 'kiro-from-session', name: 'Kiro (From Session)' }],
                    },
                }),
            ),
        ).toBe(false);
    });

    it('treats a published Claude session model list as dynamic list support', () => {
        expect(
            hasDynamicModelListForSession(
                'claude',
                withMetadata({
                    sessionModelsV1: {
                        v: 1,
                        provider: 'claude',
                        updatedAt: 1,
                        currentModelId: 'claude-haiku-4-5',
                        availableModels: [{ id: 'claude-haiku-4-5', name: 'Haiku' }],
                    },
                }),
            ),
        ).toBe(true);
    });

    it('falls back to legacy ACP session models when canonical key is absent', () => {
        const out = getModelOptionsForSession(
            'opencode',
            withMetadata({
                acpSessionModelsV1: {
                    v: 1,
                    provider: 'opencode',
                    updatedAt: 1,
                    currentModelId: 'model-a',
                    availableModels: [{ id: 'model-a', name: 'Model A' }],
                },
            }),
        );

        expect(out.map((o) => o.value)).toEqual(['default', 'model-a']);
    });

    it('uses the newest valid model-state alias when canonical and legacy values diverge', () => {
        const out = getModelOptionsForSession(
            'grok',
            withMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'grok',
                    updatedAt: 10,
                    currentModelId: 'stale-model',
                    availableModels: [{ id: 'stale-model', name: 'Stale model' }],
                },
                acpSessionModelsV1: {
                    v: 1,
                    provider: 'grok',
                    updatedAt: 20,
                    currentModelId: 'grok-4.5',
                    availableModels: [{ id: 'grok-4.5', name: 'Grok 4.5' }],
                },
            }),
        );

        expect(out.map((option) => option.value)).toEqual(['default', 'grok-4.5']);
    });

    it('reuses a uniquely matching provider-qualified model for an unqualified persisted selection', () => {
        const out = getModelOptionsForSession(
            'pi',
            withMetadata({
                modelOverrideV1: {
                    v: 1,
                    modelId: 'gpt-5.6-luna',
                    updatedAt: 20,
                },
                sessionModelsV1: {
                    v: 1,
                    provider: 'pi',
                    updatedAt: 10,
                    currentModelId: 'openai-codex/gpt-5.6-luna',
                    availableModels: [{
                        id: 'openai-codex/gpt-5.6-luna',
                        name: 'GPT-5.6 Luna',
                        modelOptions: [{
                            id: 'reasoning_effort',
                            name: 'Thinking',
                            type: 'select',
                            currentValue: 'medium',
                            options: [
                                { value: 'low', name: 'Low' },
                                { value: 'medium', name: 'Medium' },
                            ],
                        }],
                    }],
                },
            }),
        );

        expect(out.map((option) => option.value)).toEqual([
            'default',
            'openai-codex/gpt-5.6-luna',
        ]);
        expect(findModelOptionForEffectiveModelId(out, 'gpt-5.6-luna')).toMatchObject({
            value: 'openai-codex/gpt-5.6-luna',
            modelOptions: [expect.objectContaining({ id: 'reasoning_effort' })],
        });
    });

    it('does not treat ambiguous or nonmatching unqualified custom ids as canonical options', () => {
        const options = getModelOptionsForPreflightModelList({
            supportsFreeform: true,
            availableModels: [
                { id: 'openai/gpt-shared', name: 'OpenAI shared' },
                { id: 'openai-codex/gpt-shared', name: 'Codex shared' },
                { id: 'openai-codex/gpt-known', name: 'Codex known' },
            ],
        });

        expect(findModelOptionForEffectiveModelId(options, 'gpt-shared')).toBeNull();
        expect(findModelOptionForEffectiveModelId(options, 'private-custom-model')).toBeNull();
    });
});

describe('modelOptions — ultracode and extended context (Claude)', () => {
    it('surfaces the ultracode boolean model option from the catalog for xhigh-capable models', () => {
        const options = getModelOptionsForAgentType('claude');
        const fable = options.find((option) => option.value === 'claude-fable-5');
        expect(fable?.modelOptions?.some((opt) => opt.id === 'ultracode' && opt.type === 'boolean')).toBe(true);
        const sonnet = options.find((option) => option.value === 'claude-sonnet-4-6');
        expect(sonnet?.modelOptions?.some((opt) => opt.id === 'ultracode')).toBe(false);
    });

    it('passes the extended-context variant id through for 1M opt-in models only', () => {
        const options = getModelOptionsForAgentType('claude');
        expect(options.find((option) => option.value === 'claude-sonnet-4-6')?.extendedContextModelId).toBe('claude-sonnet-4-6[1m]');
        expect(options.find((option) => option.value === 'claude-opus-4-6')?.extendedContextModelId).toBe('claude-opus-4-6[1m]');
        expect(options.find((option) => option.value === 'claude-fable-5')?.extendedContextModelId).toBeUndefined();
    });

    it('matches an effective extended-context model id back to its base option', () => {
        const options = getModelOptionsForAgentType('claude');
        const match = findModelOptionForEffectiveModelId(options, 'claude-sonnet-4-6[1m]');
        expect(match?.value).toBe('claude-sonnet-4-6');
        expect(findModelOptionForEffectiveModelId(options, 'claude-sonnet-4-6')?.value).toBe('claude-sonnet-4-6');
        expect(findModelOptionForEffectiveModelId(options, 'missing-model')).toBeNull();
    });
});
