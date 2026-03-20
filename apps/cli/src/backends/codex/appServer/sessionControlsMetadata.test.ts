import { describe, expect, it, vi } from 'vitest';

import {
    SESSION_CONFIG_OPTIONS_STATE_KEY,
    SESSION_MODELS_STATE_KEY,
    SESSION_MODES_STATE_KEY,
} from '@happier-dev/agents';

import { publishCodexAppServerSessionControlsMetadata } from './sessionControlsMetadata';

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
    it('publishes generic session modes, models, and an eligible Speed config option', async () => {
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
                            { id: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Latest default', isDefault: true },
                            { id: 'gpt-4.1', displayName: 'GPT-4.1' },
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
                    { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Latest default' },
                    { id: 'gpt-4.1', name: 'GPT-4.1' },
                ],
            },
            [SESSION_CONFIG_OPTIONS_STATE_KEY]: {
                v: 1,
                provider: 'codex',
                updatedAt: 123,
                configOptions: [
                    {
                        id: 'speed',
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
        });
    });

    it('publishes an empty config option list when Speed is ineligible', async () => {
        const client = {
            request: vi.fn(async (method: string) => {
                if (method === 'collaborationMode/list') {
                    return [{ name: 'Default', mode: 'default', reasoning_effort: null }];
                }
                if (method === 'model/list') {
                    return [{ id: 'gpt-5.4', displayName: 'GPT-5.4', isDefault: true }];
                }
                throw new Error(`Unexpected method: ${method}`);
            }),
        };
        const { session, getMetadata } = createSessionHarness({
            [SESSION_CONFIG_OPTIONS_STATE_KEY]: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                configOptions: [{ id: 'speed', name: 'Speed', type: 'select', currentValue: 'fast' }],
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
        const { session, getMetadata } = createSessionHarness({
            [SESSION_MODES_STATE_KEY]: { stale: true },
            [SESSION_MODELS_STATE_KEY]: { stale: true },
            [SESSION_CONFIG_OPTIONS_STATE_KEY]: { stale: true },
        });

        await publishCodexAppServerSessionControlsMetadata({
            client,
            session,
            provider: 'codex',
            updatedAt: 789,
            authMethod: 'oauth_cli',
        });

        expect(getMetadata()[SESSION_MODES_STATE_KEY]).toBeUndefined();
        expect(getMetadata()[SESSION_MODELS_STATE_KEY]).toBeUndefined();
        expect(getMetadata()[SESSION_CONFIG_OPTIONS_STATE_KEY]).toEqual({
            v: 1,
            provider: 'codex',
            updatedAt: 789,
            configOptions: [],
        });
    });
});
