import { describe, expect, it, vi } from 'vitest';

import {
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';

import {
    publishCodexAppServerSessionControlsMetadata,
    resolveCodexAppServerCollaborationModeSelection,
} from './sessionControlsMetadata';

type MutableMetadata = Record<string, unknown>;

function createSessionHarness(initialMetadata: MutableMetadata = {}): Readonly<{
    session: { updateMetadata: ReturnType<typeof vi.fn> };
    getMetadata: () => MutableMetadata;
}> {
    let metadata: MutableMetadata = { ...initialMetadata };
    return {
        session: {
            updateMetadata: vi.fn((updater: (current: MutableMetadata) => MutableMetadata) => {
                metadata = updater(metadata);
            }),
        },
        getMetadata: () => metadata,
    };
}

describe('publishCodexAppServerSessionControlsMetadata', () => {
    it('accepts snake_case reasoning effort fields from model/list', async () => {
        const client = {
            request: vi.fn(async (method: string) => {
                if (method === 'collaborationMode/list') {
                    return {
                        data: [{ name: 'Default', mode: 'default', reasoning_effort: null }],
                    };
                }
                if (method === 'model/list') {
                    return {
                        data: [
                            {
                                id: 'gpt-5.4',
                                displayName: 'GPT-5.4',
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
        const { session, getMetadata } = createSessionHarness();

        await publishCodexAppServerSessionControlsMetadata({
            client,
            session,
            provider: 'codex',
            updatedAt: 777,
            authMethod: 'oauth_cli',
            currentModelId: 'gpt-5.4',
        });

        expect(getMetadata()[SESSION_MODELS_STATE_KEY]).toEqual({
            v: 1,
            provider: 'codex',
            updatedAt: 777,
            currentModelId: 'gpt-5.4',
            availableModels: [
                {
                    id: 'gpt-5.4',
                    name: 'GPT 5.4',
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
                            currentValue: 'standard',
                            options: [
                                { value: 'standard', name: 'Standard' },
                                { value: 'fast', name: 'Fast' },
                            ],
                        },
                    ],
                },
            ],
        });
    });

    it('publishes generic session modes and rich model metadata with model-scoped options', async () => {
        const client = {
            request: vi.fn(async (method: string) => {
                if (method === 'collaborationMode/list') {
                    return {
                        data: [
                            { name: 'Default', mode: 'default', reasoning_effort: null },
                            { name: 'Plan', mode: 'plan', reasoning_effort: 'medium' },
                        ],
                    };
                }
                if (method === 'model/list') {
                    return {
                        data: [
                            {
                                id: 'gpt-5.4',
                                displayName: 'GPT-5.4',
                                description: 'Latest default',
                                isDefault: true,
                                supportedReasoningEfforts: [
                                    { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
                                    { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
                                    { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
                                    { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
                                ],
                                defaultReasoningEffort: 'medium',
                            },
                            {
                                id: 'gpt-4.1',
                                displayName: 'GPT-4.1',
                                supportedReasoningEfforts: [
                                    { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
                                    { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
                                ],
                                defaultReasoningEffort: 'low',
                            },
                        ],
                    };
                }
                throw new Error(`Unexpected method: ${method}`);
            }),
        };
        const { session, getMetadata } = createSessionHarness();

        await publishCodexAppServerSessionControlsMetadata({
            client,
            session,
            provider: 'codex',
            updatedAt: 123,
            authMethod: 'oauth_cli',
            currentModeId: 'plan',
            currentModelId: 'gpt-5.4',
            currentServiceTier: 'fast',
        });

        expect(client.request).toHaveBeenCalledTimes(2);
        expect(client.request).toHaveBeenCalledWith('collaborationMode/list', {});
        expect(client.request).toHaveBeenCalledWith('model/list', {});
        expect(getMetadata()).toMatchObject({
            [SESSION_MODES_STATE_KEY]: {
                v: 1,
                provider: 'codex',
                updatedAt: 123,
                currentModeId: 'plan',
                availableModes: [
                    { id: 'default', name: 'Default' },
                    { id: 'plan', name: 'Plan', description: 'Reasoning effort: medium' },
                ],
            },
            [SESSION_MODELS_STATE_KEY]: {
                v: 1,
                provider: 'codex',
                updatedAt: 123,
                currentModelId: 'gpt-5.4',
                availableModels: [
                    {
                        id: 'gpt-5.4',
                        name: 'GPT 5.4',
                        description: 'Latest default',
                        modelOptions: [
                            {
                                id: 'reasoning_effort',
                                name: 'Thinking',
                                type: 'select',
                                currentValue: 'medium',
                                options: [
                                    { value: 'low', name: 'Low' },
                                    { value: 'medium', name: 'Medium' },
                                    { value: 'high', name: 'High' },
                                    { value: 'xhigh', name: 'Max' },
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
                    {
                        id: 'gpt-4.1',
                        name: 'GPT 4.1',
                        modelOptions: [
                            {
                                id: 'reasoning_effort',
                                name: 'Thinking',
                                type: 'select',
                                currentValue: 'low',
                                options: [
                                    { value: 'low', name: 'Low' },
                                    { value: 'medium', name: 'Medium' },
                                ],
                            },
                        ],
                    },
                ],
            },
            [SESSION_CONFIG_OPTIONS_STATE_KEY]: {
                v: 1,
                provider: 'codex',
                updatedAt: 123,
                configOptions: [],
            },
        });
    });

    it('omits Fast model options when the current auth is ineligible', async () => {
        const client = {
            request: vi.fn(async (method: string) => {
                if (method === 'collaborationMode/list') {
                    return [{ name: 'Default', mode: 'default', reasoning_effort: null }];
                }
                if (method === 'model/list') {
                    return [{
                        id: 'gpt-5.4',
                        displayName: 'GPT-5.4',
                        isDefault: true,
                        supportedReasoningEfforts: [
                            { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
                            { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
                            { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
                        ],
                        defaultReasoningEffort: 'medium',
                    }];
                }
                throw new Error(`Unexpected method: ${method}`);
            }),
        };
        const { session, getMetadata } = createSessionHarness({
            [SESSION_CONFIG_OPTIONS_STATE_KEY]: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                configOptions: [{ id: 'service_tier', name: 'Speed', type: 'select', currentValue: 'fast' }],
            },
        });

        await publishCodexAppServerSessionControlsMetadata({
            client,
            session,
            provider: 'codex',
            updatedAt: 456,
            authMethod: 'api_key_env',
            currentModelId: 'gpt-5.4',
            currentServiceTier: 'fast',
        });

        expect(getMetadata()[SESSION_MODELS_STATE_KEY]).toEqual({
            v: 1,
            provider: 'codex',
            updatedAt: 456,
            currentModelId: 'gpt-5.4',
            availableModels: [{
                id: 'gpt-5.4',
                name: 'GPT 5.4',
                modelOptions: [{
                    id: 'reasoning_effort',
                    name: 'Thinking',
                    type: 'select',
                    currentValue: 'medium',
                    options: [
                        { value: 'low', name: 'Low', description: 'Fast responses with lighter reasoning' },
                        { value: 'medium', name: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks' },
                        { value: 'high', name: 'High', description: 'Greater reasoning depth for complex problems' },
                    ],
                }],
            }],
        });
        expect(getMetadata()[SESSION_CONFIG_OPTIONS_STATE_KEY]).toEqual({
            v: 1,
            provider: 'codex',
            updatedAt: 456,
            configOptions: [],
        });
    });

    it('clears stale generic session control metadata when list endpoints return no usable items', async () => {
        const client = {
            request: vi.fn(async (method: string) => {
                if (method === 'collaborationMode/list') {
                    return { items: [{ name: 'Missing mode' }] };
                }
                if (method === 'model/list') {
                    return { data: [] };
                }
                throw new Error(`Unexpected method: ${method}`);
            }),
        };
        const seedMetadata = {
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
                currentModelId: 'gpt-5.4',
                availableModels: [{ id: 'gpt-5.4', name: 'GPT 5.4' }],
            },
            [SESSION_CONFIG_OPTIONS_STATE_KEY]: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                configOptions: [{ id: 'some', name: 'Some', type: 'string', currentValue: 'x' }],
            },
        };
        const { session, getMetadata } = createSessionHarness(seedMetadata);

        await publishCodexAppServerSessionControlsMetadata({
            client,
            session,
            provider: 'codex',
            updatedAt: 789,
            authMethod: 'oauth_cli',
        });

        // If the list endpoints fail or return no usable items, keep the last known-good
        // session controls metadata sticky so the UI does not lose dynamic controls.
        expect(getMetadata()[SESSION_MODES_STATE_KEY]).toEqual(seedMetadata[SESSION_MODES_STATE_KEY]);
        expect(getMetadata()[SESSION_MODELS_STATE_KEY]).toEqual(seedMetadata[SESSION_MODELS_STATE_KEY]);
        expect(getMetadata()[SESSION_CONFIG_OPTIONS_STATE_KEY]).toEqual(seedMetadata[SESSION_CONFIG_OPTIONS_STATE_KEY]);
    });

    it('prefers the provider default mode id when the collaboration mode list omits explicit current markers', async () => {
        const client = {
            request: vi.fn(async (method: string) => {
                if (method === 'collaborationMode/list') {
                    return {
                        data: [
                            { id: 'plan', name: 'Plan', mode: 'plan' },
                            { id: 'default', name: 'Default', mode: 'default' },
                        ],
                    };
                }
                if (method === 'model/list') {
                    return {
                        data: [
                            { id: 'gpt-5.4', displayName: 'GPT-5.4', isDefault: true },
                        ],
                    };
                }
                throw new Error(`Unexpected method: ${method}`);
            }),
        };
        const { session, getMetadata } = createSessionHarness();

        await publishCodexAppServerSessionControlsMetadata({
            client,
            session,
            provider: 'codex',
            updatedAt: 900,
            authMethod: 'oauth_cli',
            currentModeId: null,
            currentModelId: 'gpt-5.4',
        });

        expect(getMetadata()[SESSION_MODES_STATE_KEY]).toEqual({
            v: 1,
            provider: 'codex',
            updatedAt: 900,
            currentModeId: 'default',
            availableModes: [
                { id: 'plan', name: 'Plan' },
                { id: 'default', name: 'Default' },
            ],
        });
        expect(getMetadata()[SESSION_MODELS_STATE_KEY]).toEqual({
            v: 1,
            provider: 'codex',
            updatedAt: 900,
            currentModelId: 'gpt-5.4',
            availableModels: [
                {
                    id: 'gpt-5.4',
                    name: 'GPT 5.4',
                    modelOptions: [
                        {
                            id: 'service_tier',
                            name: 'Speed',
                            type: 'select',
                            currentValue: 'standard',
                            options: [
                                { value: 'standard', name: 'Standard' },
                                { value: 'fast', name: 'Fast' },
                            ],
                        },
                    ],
                },
            ],
        });
    });

    it('normalizes Codex app-server model display names into user-facing labels', async () => {
        const client = {
            request: vi.fn(async (method: string) => {
                if (method === 'collaborationMode/list') {
                    return {
                        data: [
                            { id: 'default', name: 'Default', mode: 'default' },
                        ],
                    };
                }
                if (method === 'model/list') {
                    return {
                        data: [
                            { id: 'gpt-5.4', displayName: 'gpt-5.4', isDefault: true },
                            { id: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini' },
                            { id: 'gpt-5.3-codex', displayName: 'gpt-5.3-codex' },
                        ],
                    };
                }
                throw new Error(`Unexpected method: ${method}`);
            }),
        };
        const { session, getMetadata } = createSessionHarness();

        await publishCodexAppServerSessionControlsMetadata({
            client,
            session,
            provider: 'codex',
            updatedAt: 901,
            authMethod: 'oauth_cli',
            currentModeId: null,
            currentModelId: 'gpt-5.4',
        });

        expect(getMetadata()[SESSION_MODELS_STATE_KEY]).toEqual({
            v: 1,
            provider: 'codex',
            updatedAt: 901,
            currentModelId: 'gpt-5.4',
            availableModels: [
                {
                    id: 'gpt-5.4',
                    name: 'GPT 5.4',
                    modelOptions: [
                        {
                            id: 'service_tier',
                            name: 'Speed',
                            type: 'select',
                            currentValue: 'standard',
                            options: [
                                { value: 'standard', name: 'Standard' },
                                { value: 'fast', name: 'Fast' },
                            ],
                        },
                    ],
                },
                {
                    id: 'gpt-5.4-mini',
                    name: 'GPT 5.4 Mini',
                },
                {
                    id: 'gpt-5.3-codex',
                    name: 'GPT 5.3 Codex',
                },
            ],
        });
    });

    it('resolves collaboration mode selection with the provider default model when currentModelId is missing', () => {
        const selection = resolveCodexAppServerCollaborationModeSelection({
            modesResponse: {
                data: [
                    { name: 'Plan', mode: 'plan', reasoning_effort: 'medium', model: null },
                    { name: 'Default', mode: 'default', reasoning_effort: null, model: null },
                ],
            },
            modelsResponse: {
                data: [
                    { id: 'gpt-5.4', displayName: 'GPT-5.4', isDefault: true },
                    { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini' },
                ],
            },
            modeId: 'plan',
            currentModelId: null,
            currentReasoningEffort: null,
        });

        expect(selection).toEqual({
            modeId: 'plan',
            payload: {
                mode: 'plan',
                settings: {
                    model: 'gpt-5.4',
                    reasoning_effort: 'medium',
                    developer_instructions: null,
                },
            },
        });
    });
});
