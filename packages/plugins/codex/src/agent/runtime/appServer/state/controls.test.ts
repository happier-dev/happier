import { describe, expect, it, vi } from 'vitest';

import {
    readCodexAppServerSessionControls,
    resolveCodexAppServerCollaborationModeSelection,
} from './controls';

describe('Codex app-server session controls', () => {
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
            availableModes: [
                { id: 'plan', name: 'Plan', description: 'Think first' },
                { id: 'default', name: 'Default' },
            ],
            currentModeId: 'plan',
            currentModelId: 'gpt-5.5',
            availableModels: [
                {
                    id: 'gpt-5.5',
                    name: 'GPT 5.5',
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
                        {
                            id: 'service_tier',
                            name: 'Speed',
                            type: 'select',
                            currentValue: 'fast',
                            options: [
                                { value: 'standard', name: 'Standard' },
                                { value: 'fast', name: 'Fast' },
                            ],
                        },
                    ],
                },
            ],
            configOptions: [],
        });
    });

    it('uses provider-declared service-tier metadata instead of only auth/model hardcoding', async () => {
        const client = {
            request: vi.fn(async (method: string) => {
                if (method === 'collaborationMode/list') {
                    return { data: [{ id: 'default', name: 'Default', mode: 'default' }] };
                }
                if (method === 'model/list') {
                    return {
                        data: [
                            {
                                id: 'gpt-5.4',
                                displayName: 'GPT-5.4',
                                isDefault: true,
                                supportedReasoningEfforts: [
                                    { reasoningEffort: 'low', description: 'Fast responses' },
                                    { reasoningEffort: 'medium', description: 'Balanced' },
                                    { reasoningEffort: 'high', description: 'Deep' },
                                    { reasoningEffort: 'xhigh', description: 'Extra deep' },
                                ],
                                defaultReasoningEffort: 'medium',
                                additionalSpeedTiers: ['fast'],
                                serviceTiers: [
                                    { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' },
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
            currentModelId: 'gpt-5.4',
            currentServiceTier: 'fast',
        });

        expect(snapshot.availableModels).toEqual([
            {
                id: 'gpt-5.4',
                name: 'GPT 5.4',
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
                        ],
                    },
                    {
                        id: 'service_tier',
                        name: 'Speed',
                        type: 'select',
                        currentValue: 'fast',
                        options: [
                            { value: 'standard', name: 'Standard' },
                            { value: 'fast', name: 'Fast', description: '1.5x speed, increased usage' },
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
});
