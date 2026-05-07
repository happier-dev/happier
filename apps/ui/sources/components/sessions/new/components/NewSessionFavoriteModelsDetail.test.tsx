import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { renderScreen } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let optionPickerOverlayProps: any[] = [];

installNewSessionComponentsCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
    }),
    text: () => createTextModuleMock({ translate: (key) => key }),
    unistyles: () => createUnistylesMock(),
});

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: (props: any) => {
        optionPickerOverlayProps.push(props);
        return React.createElement('OptionPickerOverlay', props);
    },
}));

const agentCoreById: Record<string, { dynamicProbe: 'dynamic' | 'static-only' }> = {
    claude: { dynamicProbe: 'dynamic' },
    codex: { dynamicProbe: 'dynamic' },
};

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        getAgentCore: (agentId: string) => ({
            model: agentCoreById[agentId] ?? { dynamicProbe: 'dynamic' },
        }),
    };
});

const preflightModelsByTargetKey: Record<string, {
    modelOptions: Array<{
        value: string;
        label: string;
        description: string;
        modelOptions?: Array<{
            id: string;
            name: string;
            type: string;
            currentValue: string;
            options?: Array<{ value: string; name: string }>;
        }>;
    }>;
    preflightModels: {
        availableModels: Array<{
            id: string;
            name: string;
            description?: string;
            modelOptions?: Array<{
                id: string;
                name: string;
                type: string;
                currentValue: string;
                options?: Array<{ value: string; name: string }>;
            }>;
        }>;
        supportsFreeform: boolean;
    } | null;
}> = {};

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: ({ backendTarget }: any) => {
        const targetKey = backendTarget.kind === 'builtInAgent'
            ? `agent:${backendTarget.agentId}`
            : `acpBackend:${backendTarget.backendId}`;
        return {
            modelOptions: preflightModelsByTargetKey[targetKey]?.modelOptions ?? [],
            preflightModels: preflightModelsByTargetKey[targetKey]?.preflightModels ?? {
                availableModels: [],
                supportsFreeform: false,
            },
            probe: { phase: 'idle' },
        };
    },
}));

describe('NewSessionFavoriteModelsDetail', () => {
    beforeEach(() => {
        optionPickerOverlayProps = [];
        for (const key of Object.keys(preflightModelsByTargetKey)) {
            delete preflightModelsByTargetKey[key];
        }
        agentCoreById.claude = { dynamicProbe: 'dynamic' };
        agentCoreById.codex = { dynamicProbe: 'dynamic' };
    });

    it('renders all available favorite models in one shared favorites group', async () => {
        agentCoreById.claude = { dynamicProbe: 'static-only' };
        preflightModelsByTargetKey['agent:claude'] = {
            modelOptions: [
                { value: 'claude-opus-4-6', label: 'Opus 4.6', description: 'Claude model.' },
            ],
            preflightModels: null,
        };
        preflightModelsByTargetKey['agent:codex'] = {
            modelOptions: [],
            preflightModels: {
                availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5', description: 'Codex model.' }],
                supportsFreeform: false,
            },
        };
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[
                {
                    backendTargetKey: 'agent:claude',
                    providerAgentId: 'claude',
                    builtInAgentId: 'claude',
                    backendLabel: 'Claude',
                    modelId: 'claude-opus-4-6',
                    modelLabel: 'Opus 4.6',
                },
                {
                    backendTargetKey: 'agent:codex',
                    providerAgentId: 'codex',
                    builtInAgentId: 'codex',
                    backendLabel: 'Codex',
                    modelId: 'gpt-5.5',
                    modelLabel: 'GPT 5.5',
                },
            ]}
            resolvedBackendEntries={[
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    providerAgentId: 'claude',
                    builtInAgentId: 'claude',
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    providerAgentId: 'codex',
                    builtInAgentId: 'codex',
                } as any,
            ]}
            selectedBackendTargetKey="agent:claude"
            selectedModelId="claude-opus-4-6"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={{} as any}
            onSelectFavoriteModel={vi.fn()}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        const latestPickerProps = optionPickerOverlayProps.at(-1);
        expect(latestPickerProps?.title).toBe('profiles.groups.favorites');
        expect(latestPickerProps?.options.map((option: any) => ({
            label: option.label,
            description: option.description,
        }))).toEqual([
            { label: 'Opus 4.6', description: 'Claude model.' },
            { label: 'GPT 5.5', description: 'Codex model.' },
        ]);
    });

    it('renders selected favorite model controls and routes control changes through the selected favorite backend', async () => {
        const onSelectFavoriteModelOptionValue = vi.fn();
        preflightModelsByTargetKey['agent:codex'] = {
            modelOptions: [
                {
                    value: 'gpt-5.5',
                    label: 'GPT 5.5',
                    description: 'Codex model.',
                    modelOptions: [
                        {
                            id: 'reasoning_effort',
                            name: 'Thinking',
                            type: 'select',
                            currentValue: 'medium',
                            options: [
                                { value: 'medium', name: 'Medium' },
                                { value: 'high', name: 'High' },
                            ],
                        },
                    ],
                },
            ],
            preflightModels: {
                availableModels: [{
                    id: 'gpt-5.5',
                    name: 'GPT 5.5',
                    description: 'Codex model.',
                    modelOptions: [
                        {
                            id: 'reasoning_effort',
                            name: 'Thinking',
                            type: 'select',
                            currentValue: 'medium',
                            options: [
                                { value: 'medium', name: 'Medium' },
                                { value: 'high', name: 'High' },
                            ],
                        },
                    ],
                }],
                supportsFreeform: false,
            },
        };
        const codexEntry = {
            target: { kind: 'builtInAgent', agentId: 'codex' },
            targetKey: 'agent:codex',
            title: 'Codex',
            providerAgentId: 'codex',
            builtInAgentId: 'codex',
        } as any;
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[
                {
                    backendTargetKey: 'agent:codex',
                    providerAgentId: 'codex',
                    builtInAgentId: 'codex',
                    backendLabel: 'Codex',
                    modelId: 'gpt-5.5',
                    modelLabel: 'GPT 5.5',
                },
            ]}
            resolvedBackendEntries={[codexEntry]}
            selectedBackendTargetKey="agent:codex"
            selectedModelId="gpt-5.5"
            selectedConfigOverrides={{ reasoning_effort: 'high' }}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={{} as any}
            onSelectFavoriteModel={vi.fn()}
            onSelectFavoriteModelOptionValue={onSelectFavoriteModelOptionValue}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        const latestPickerProps = optionPickerOverlayProps.at(-1);

        expect(latestPickerProps?.selectedOptionControls).toEqual([
            expect.objectContaining({
                effectiveValue: 'high',
                option: expect.objectContaining({ id: 'reasoning_effort' }),
            }),
        ]);

        latestPickerProps?.onSelectOptionControlValue?.('reasoning_effort', 'medium');

        expect(onSelectFavoriteModelOptionValue).toHaveBeenCalledWith(codexEntry, 'gpt-5.5', 'reasoning_effort', 'medium');
    });

    it('renders stale favorite models with a remove affordance instead of dropping the pane', async () => {
        const onRemoveFavoriteModelSelection = vi.fn();
        const favorite = {
            backendTargetKey: 'agent:claude',
            providerAgentId: 'claude',
            builtInAgentId: 'claude',
            backendLabel: 'Claude',
            modelId: 'retired-model',
            modelLabel: 'Retired model',
        };
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[favorite]}
            resolvedBackendEntries={[
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    providerAgentId: 'claude',
                    builtInAgentId: 'claude',
                } as any,
            ]}
            selectedBackendTargetKey="agent:claude"
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={{} as any}
            onSelectFavoriteModel={vi.fn()}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={onRemoveFavoriteModelSelection}
        />);

        const latestPickerProps = optionPickerOverlayProps.at(-1);
        expect(latestPickerProps?.options).toEqual([
            {
                value: 'agent:claude\x1fretired-model',
                label: 'Retired model',
                description: 'agentInput.model.configureInCli',
            },
        ]);
        expect(latestPickerProps?.favoriteOptions?.values.has('agent:claude\x1fretired-model')).toBe(true);

        latestPickerProps?.favoriteOptions?.onToggle(latestPickerProps.options[0]);

        expect(onRemoveFavoriteModelSelection).toHaveBeenCalledWith(favorite);
    });
});
