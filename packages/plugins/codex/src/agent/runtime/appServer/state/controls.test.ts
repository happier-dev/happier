import { describe, expect, it, vi } from 'vitest';

import {
    hasCodexAppServerCollaborationMode,
    readCodexAppServerSessionControls,
    resolveCodexAppServerCollaborationModeSelection,
} from './controls';

describe('Codex app-server session controls', () => {
    it('preserves the observed native model display name and never invents one from an unknown id', async () => {
        const snapshot = await readCodexAppServerSessionControls({ client: { request: async method => method === 'model/list'
            ? { data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna' }, { id: 'unknown-native-model' }] }
            : [] } });
        expect(snapshot.availableModels).toEqual([
            { id: 'gpt-6-luna', name: 'GPT-6-Luna', costTier: 'low' }, { id: 'unknown-native-model', name: 'unknown-native-model' },
        ]);
    });
    it('tags the live model list with Codex-owned cost tiers by model family, leaving unknown ids untiered', async () => {
        const snapshot = await readCodexAppServerSessionControls({ client: { request: async method => method === 'model/list'
            ? { data: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-reserve', 'gpt-5.4-mini', 'unknown-native-model']
                .map(id => ({ id, displayName: id })).concat([{ id: 'gpt-7-luna', displayName: 'gpt-7-luna', costTier: 'premium' } as never]) }
            : [] } });
        expect(Object.fromEntries(snapshot.availableModels.map(model => [model.id, (model as { costTier?: string }).costTier ?? null]))).toEqual({
            'gpt-6-luna': 'low', 'gpt-6.1-terra': 'standard', 'gpt-6.1-sol': 'standard', 'gpt-6-astra': 'premium',
            'gpt-reserve': 'low', 'gpt-5.4-mini': 'low', 'unknown-native-model': null, 'gpt-7-luna': 'premium',
        });
    });
    it.each(['rejected', 'malformed', 'empty'] as const)('distinguishes %s model discovery from an unavailable observation', async (outcome) => {
        const snapshot = await readCodexAppServerSessionControls({
            client: { request: async (method) => {
                if (method !== 'model/list') return [];
                if (outcome === 'rejected') throw new Error('provider unavailable');
                return outcome === 'malformed' ? { unexpected: [] } : [];
            } },
        });
        expect(snapshot).toMatchObject({ availableModels: [], modelsObserved: outcome === 'empty' });
    });

    it('normalizes Codex modes and model-scoped options into canonical session-control states', async () => {
        const client = {
            request: vi.fn(async (method: string) => {
                if (method === 'collaborationMode/list') {
                    return {
                        data: [
                            { id: 'plan', name: 'Plan', mode: 'plan', reasoning_effort: 'medium' },
                            { id: 'default', name: 'Default', mode: 'default' },
                        ],
                    };
                }
                if (method === 'model/list') {
                    return {
                        data: [
                            {
                                id: 'gpt-5.5',
                                displayName: 'GPT-5.5',
                                isDefault: true,
                                supported_reasoning_efforts: [
                                    { reasoning_effort: 'medium', description: 'Balanced' },
                                    { reasoning_effort: 'high', description: 'Deep' },
                                ],
                                default_reasoning_effort: 'high',
                            },
                        ],
                    };
                }
                throw new Error(`Unexpected method: ${method}`);
            }),
        };

        const snapshot = await readCodexAppServerSessionControls({
            client,
            authMethod: 'oauth_cli',
            currentModeId: 'plan',
            currentModelId: 'gpt-5.5',
            currentServiceTier: 'fast',
        });
        expect(client.request).toHaveBeenCalledWith('collaborationMode/list', {});
        expect(client.request).toHaveBeenCalledWith('model/list', {});
        expect(snapshot).toEqual({
            modelsObserved: true,
            availableModes: [
                { id: 'plan', name: 'Plan', description: 'Think first' },
                { id: 'default', name: 'Default' },
            ],
            currentModeId: 'plan',
            currentModelId: 'gpt-5.5',
            availableModels: [
                {
                    id: 'gpt-5.5',
                    name: 'GPT-5.5',
                    modelOptions: [
                        {
                            id: 'reasoning_effort',
                            name: 'Thinking',
                            type: 'select',
                            currentValue: 'high',
                            options: [
                                { value: 'medium', name: 'Medium', description: 'Balanced' },
                                { value: 'high', name: 'High', description: 'Deep' },
                            ],
                        },
                    ],
                },
            ],
            configOptions: [],
        });
    });

    it('uses a provider-declared priority service tier instead of auth or model hardcoding', async () => {
        const client = {
            request: vi.fn(async (method: string) => {
                if (method === 'collaborationMode/list') {
                    return { data: [{ id: 'default', name: 'Default', mode: 'default' }] };
                }
                if (method === 'model/list') {
                    return {
                        data: [
                            {
                                id: 'gpt-5.6-sol',
                                displayName: 'GPT-5.6-Sol',
                                isDefault: true,
                                supportedReasoningEfforts: [
                                    { reasoningEffort: 'low', description: 'Fast responses' },
                                    { reasoningEffort: 'medium', description: 'Balanced' },
                                    { reasoningEffort: 'high', description: 'Deep' },
                                    { reasoningEffort: 'xhigh', description: 'Extra deep' },
                                    // A level this build has no word for still reads as a name, not a raw enum value.
                                    { reasoningEffort: 'ultra', description: 'Longest thinking' },
                                ],
                                defaultReasoningEffort: 'medium',
                                serviceTiers: [
                                    { id: 'priority', name: 'Priority', description: '1.5x speed, increased usage' },
                                ],
                            },
                        ],
                    };
                }
                throw new Error(`Unexpected method: ${method}`);
            }),
        };

        const snapshot = await readCodexAppServerSessionControls({
            client,
            authMethod: null,
            currentModelId: 'gpt-5.6-sol',
            currentServiceTier: 'priority',
        });

        expect(snapshot.availableModels).toEqual([
            {
                id: 'gpt-5.6-sol',
                name: 'GPT-5.6-Sol',
                costTier: 'standard',
                modelOptions: [
                    {
                        id: 'reasoning_effort',
                        name: 'Thinking',
                        type: 'select',
                        currentValue: 'medium',
                        options: [
                            { value: 'low', name: 'Low', description: 'Fast responses' },
                            { value: 'medium', name: 'Medium', description: 'Balanced' },
                            { value: 'high', name: 'High', description: 'Deep' },
                            { value: 'xhigh', name: 'XHigh', description: 'Extra deep' },
                            { value: 'ultra', name: 'Ultra', description: 'Longest thinking' },
                        ],
                    },
                    {
                        id: 'service_tier',
                        name: 'Speed',
                        type: 'select',
                        currentValue: 'fast',
                        options: [
                            { value: 'standard', name: 'Standard' },
                            { value: 'fast', name: 'Priority', description: '1.5x speed, increased usage' },
                        ],
                    },
                ],
            },
        ]);
    });

    it('resolves collaboration-mode selection with the provider default model when the current model is missing', () => {
        expect(resolveCodexAppServerCollaborationModeSelection({
            modesResponse: {
                data: [
                    { name: 'Plan', mode: 'plan', reasoning_effort: 'medium', model: null },
                    { name: 'Default', mode: 'default', reasoning_effort: null, model: null },
                ],
            },
            modelsResponse: {
                data: [
                    { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true },
                    { id: 'gpt-5.5-mini', displayName: 'GPT-5.5 Mini' },
                ],
            },
            modeId: 'plan',
            currentModelId: null,
            currentReasoningEffort: null,
        })).toEqual({
            modeId: 'plan',
            payload: {
                mode: 'plan',
                settings: {
                    model: 'gpt-5.5',
                    reasoning_effort: 'medium',
                    developer_instructions: null,
                },
            },
        });
    });

    it('distinguishes a missing mode from a mode that only needs model fallback data', () => {
        const modesResponse = {
            data: [{ id: 'plan', name: 'Plan', mode: 'plan', model: null }],
        };

        expect(hasCodexAppServerCollaborationMode(modesResponse, 'plan')).toBe(true);
        expect(hasCodexAppServerCollaborationMode(modesResponse, 'missing')).toBe(false);
        expect(resolveCodexAppServerCollaborationModeSelection({
            modesResponse,
            modeId: 'plan',
            currentModelId: null,
        })).toBeNull();
    });
});
