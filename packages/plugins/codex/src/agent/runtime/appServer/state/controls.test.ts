import { describe, expect, it, vi } from 'vitest';

import {
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';

import {
    buildCodexAppServerSessionControlsMetadataStates,
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
        const states = buildCodexAppServerSessionControlsMetadataStates({
            snapshot,
            provider: 'codex',
            updatedAt: 123,
            currentModeId: 'plan',
            currentModelId: 'gpt-5.5',
        });

        expect(client.request).toHaveBeenCalledWith('collaborationMode/list', {});
        expect(client.request).toHaveBeenCalledWith('model/list', {});
        expect(states.sessionModesState).toEqual({
            v: 1,
            provider: 'codex',
            updatedAt: 123,
            currentModeId: 'plan',
            availableModes: [
                { id: 'plan', name: 'Plan', description: 'Think first' },
                { id: 'default', name: 'Default' },
            ],
        });
        expect(states.sessionModelsState).toEqual({
            v: 1,
            provider: 'codex',
            updatedAt: 123,
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
        });
        expect(states.sessionConfigOptionsState).toEqual({
            v: 1,
            provider: 'codex',
            updatedAt: 123,
            configOptions: [],
        });
    });

    it('preserves last-known-good controls when list endpoints return no usable items', () => {
        const metadataSnapshot = {
            [SESSION_MODES_STATE_KEY]: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                currentModeId: 'default',
                availableModes: [{ id: 'default', name: 'Default' }],
            },
            [SESSION_MODELS_STATE_KEY]: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                currentModelId: 'gpt-5.5',
                availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
            },
            [SESSION_CONFIG_OPTIONS_STATE_KEY]: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                configOptions: [{ id: 'service_tier', name: 'Speed', type: 'select', currentValue: 'fast' }],
            },
        };

        const states = buildCodexAppServerSessionControlsMetadataStates({
            metadataSnapshot,
            snapshot: {
                availableModes: [],
                currentModeId: null,
                availableModels: [],
                currentModelId: null,
                configOptions: [],
            },
            provider: 'codex',
            updatedAt: 456,
        });

        expect(states).toEqual({
            sessionModesState: metadataSnapshot[SESSION_MODES_STATE_KEY],
            sessionModelsState: metadataSnapshot[SESSION_MODELS_STATE_KEY],
            sessionConfigOptionsState: metadataSnapshot[SESSION_CONFIG_OPTIONS_STATE_KEY],
        });
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
