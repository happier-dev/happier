import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AgentId } from '@/agents/catalog/catalog';
import { renderScreen } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import type { OptionPickerOverlayProps } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { ModelOption, PreflightModelList } from '@/sync/domains/models/modelOptions';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let optionPickerOverlayProps: OptionPickerOverlayProps[] = [];

function getOptionIconAgentId(icon: React.ReactNode): string | null {
    return React.isValidElement<{ agentId?: string }>(icon)
        ? icon.props.agentId ?? null
        : null;
}

function getOptionIconSize(icon: React.ReactNode): number | null {
    return React.isValidElement<{ size?: number }>(icon)
        ? icon.props.size ?? null
        : null;
}

installNewSessionComponentsCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
    }),
    text: () => createTextModuleMock({ translate: (key) => key }),
    unistyles: () => createUnistylesMock(),
});

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: (props: OptionPickerOverlayProps) => {
        optionPickerOverlayProps.push(props);
        return React.createElement('OptionPickerOverlay', props);
    },
}));

const settings = settingsParse({});

function createBuiltInEntry(agentId: AgentId, title: string): ResolvedBackendCatalogEntry {
    const backendTarget: BackendTargetRefV2 = { kind: 'backend', backendId: agentId, sourceKind: 'built_in' };
    return {
        backendTarget,
        backendTargetKey: `agent:${agentId}`,
        kind: 'builtInAgent',
        backendId: agentId,
        providerId: agentId,
        providerAgentId: agentId,
        builtInAgentId: agentId,
        iconAgentId: agentId,
        title,
        subtitle: agentId,
    };
}

const agentCoreById: Partial<Record<AgentId, { dynamicProbe: 'dynamic' | 'static-only' }>> = {
    claude: { dynamicProbe: 'dynamic' },
    codex: { dynamicProbe: 'dynamic' },
};

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: (agentId: AgentId | null) => ({
        model: {
            dynamicProbe: agentId ? (agentCoreById[agentId]?.dynamicProbe ?? 'dynamic') : 'dynamic',
        },
    }),
    isAgentId: (value: unknown): value is string => typeof value === 'string' && ['claude', 'codex', 'customAcp'].includes(value),
}));

const preflightModelsByTargetKey: Record<string, {
    modelOptions: ModelOption[];
    preflightModels: PreflightModelList | null;
    probePhase?: 'idle' | 'loading' | 'refreshing';
}> = {};

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: ({ backendTarget }: { backendTarget: BackendTargetRefV2 }) => {
        const targetKey = `agent:${backendTarget.backendId}`;
        return {
            modelOptions: preflightModelsByTargetKey[targetKey]?.modelOptions ?? [],
            preflightModels: preflightModelsByTargetKey[targetKey]?.preflightModels ?? {
                availableModels: [],
                supportsFreeform: false,
            },
            probe: { phase: preflightModelsByTargetKey[targetKey]?.probePhase ?? 'idle' },
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
                createBuiltInEntry('claude', 'Claude'),
                createBuiltInEntry('codex', 'Codex'),
            ]}
            selectedBackendTargetKey="agent:claude"
            selectedModelId="claude-opus-4-6"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={settings}
            onSelectFavoriteModel={vi.fn()}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        const latestPickerProps = optionPickerOverlayProps.at(-1);
        expect(latestPickerProps?.title).toBe('profiles.groups.favorites');
        expect(latestPickerProps?.options.map((option) => ({
            label: option.label,
            description: option.description,
        }))).toEqual([
            { label: 'Opus 4.6', description: 'Claude' },
            { label: 'GPT 5.5', description: 'Codex' },
        ]);
        expect(latestPickerProps?.options.map((option) => getOptionIconAgentId(option.icon))).toEqual([
            'claude',
            'codex',
        ]);
        expect(latestPickerProps?.options.map((option) => getOptionIconSize(option.icon))).toEqual([
            20,
            20,
        ]);
    });

    it('updates favorite selectability when availability changes without changing rendered option text', async () => {
        const onSelectFavoriteModel = vi.fn();
        preflightModelsByTargetKey['agent:codex'] = {
            modelOptions: [],
            preflightModels: {
                availableModels: [],
                supportsFreeform: false,
            },
        };
        const codexEntry = createBuiltInEntry('codex', 'Codex');
        const favorite = {
            backendTargetKey: 'agent:codex',
            providerAgentId: 'codex',
            builtInAgentId: 'codex',
            backendLabel: 'Codex',
            modelId: 'gpt-5.5',
            modelLabel: 'GPT 5.5',
        };
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        const screen = await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[favorite]}
            resolvedBackendEntries={[codexEntry]}
            selectedBackendTargetKey="agent:claude"
            selectedModelId="claude-opus-4-7"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={settings}
            onSelectFavoriteModel={onSelectFavoriteModel}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        const stalePickerProps = optionPickerOverlayProps.at(-1);
        stalePickerProps?.onSelect?.('agent:codex\x1fgpt-5.5');
        expect(onSelectFavoriteModel).not.toHaveBeenCalled();

        preflightModelsByTargetKey['agent:codex'] = {
            modelOptions: [
                { value: 'gpt-5.5', label: 'GPT 5.5', description: 'Catalog model.' },
            ],
            preflightModels: {
                availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5', description: 'Catalog model.' }],
                supportsFreeform: false,
            },
        };

        await screen.update(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[favorite]}
            resolvedBackendEntries={[codexEntry]}
            selectedBackendTargetKey="agent:claude"
            selectedModelId="claude-opus-4-7"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={settings}
            onSelectFavoriteModel={onSelectFavoriteModel}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        const availablePickerProps = optionPickerOverlayProps.at(-1);
        availablePickerProps?.onSelect?.('agent:codex\x1fgpt-5.5');

        expect(onSelectFavoriteModel).toHaveBeenCalledWith(codexEntry, 'gpt-5.5', {});
    });

    it('selects favorite from merged model options when preflight omits it', async () => {
        const onSelectFavoriteModel = vi.fn();
        preflightModelsByTargetKey['agent:codex'] = {
            modelOptions: [
                { value: 'gpt-5.4', label: 'GPT 5.4', description: 'Preflight model.' },
                { value: 'gpt-5.5', label: 'GPT 5.5', description: 'Merged catalog model.' },
            ],
            preflightModels: {
                availableModels: [{ id: 'gpt-5.4', name: 'GPT 5.4', description: 'Preflight model.' }],
                supportsFreeform: false,
            },
        };
        const codexEntry = createBuiltInEntry('codex', 'Codex');
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
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={settings}
            onSelectFavoriteModel={onSelectFavoriteModel}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        const latestPickerProps = optionPickerOverlayProps.at(-1);
        latestPickerProps?.onSelect?.('agent:codex\x1fgpt-5.5');

        expect(onSelectFavoriteModel).toHaveBeenCalledWith(codexEntry, 'gpt-5.5', {});
    });

    it('selects dynamic favorite while model availability is loading', async () => {
        const onSelectFavoriteModel = vi.fn();
        preflightModelsByTargetKey['agent:codex'] = {
            modelOptions: [],
            preflightModels: {
                availableModels: [],
                supportsFreeform: false,
            },
            probePhase: 'loading',
        };
        const codexEntry = createBuiltInEntry('codex', 'Codex');
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
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={settings}
            onSelectFavoriteModel={onSelectFavoriteModel}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        const latestPickerProps = optionPickerOverlayProps.at(-1);
        latestPickerProps?.onSelect?.('agent:codex\x1fgpt-5.5');

        expect(onSelectFavoriteModel).toHaveBeenCalledWith(codexEntry, 'gpt-5.5', {});
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
        const codexEntry = createBuiltInEntry('codex', 'Codex');
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
            settings={settings}
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

    it('drops incompatible model option overrides when selecting a favorite model', async () => {
        const onSelectFavoriteModel = vi.fn();
        preflightModelsByTargetKey['agent:codex'] = {
            modelOptions: [
                {
                    value: 'gpt-5.4',
                    label: 'GPT 5.4',
                    description: 'Previous model.',
                    modelOptions: [{
                        id: 'reasoning_effort',
                        name: 'Thinking',
                        type: 'select',
                        currentValue: 'xhigh',
                        options: [
                            { value: 'high', name: 'High' },
                            { value: 'xhigh', name: 'Extra high' },
                        ],
                    }],
                },
                {
                    value: 'gpt-5.5',
                    label: 'GPT 5.5',
                    description: 'Codex model.',
                    modelOptions: [{
                        id: 'reasoning_effort',
                        name: 'Thinking',
                        type: 'select',
                        currentValue: 'medium',
                        options: [
                            { value: 'medium', name: 'Medium' },
                            { value: 'high', name: 'High' },
                        ],
                    }],
                },
            ],
            preflightModels: {
                availableModels: [
                    { id: 'gpt-5.4', name: 'GPT 5.4', description: 'Previous model.' },
                    { id: 'gpt-5.5', name: 'GPT 5.5', description: 'Codex model.' },
                ],
                supportsFreeform: false,
            },
        };
        const codexEntry = createBuiltInEntry('codex', 'Codex');
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
            selectedModelId="gpt-5.4"
            selectedConfigOverrides={{
                reasoning_effort: 'xhigh',
                service_tier: 'fast',
            }}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={settings}
            onSelectFavoriteModel={onSelectFavoriteModel}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        const latestPickerProps = optionPickerOverlayProps.at(-1);
        latestPickerProps?.onSelect?.('agent:codex\x1fgpt-5.5');

        expect(onSelectFavoriteModel).toHaveBeenCalledWith(codexEntry, 'gpt-5.5', {
            service_tier: 'fast',
        });
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
                createBuiltInEntry('claude', 'Claude'),
            ]}
            selectedBackendTargetKey="agent:claude"
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            settings={settings}
            onSelectFavoriteModel={vi.fn()}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={onRemoveFavoriteModelSelection}
        />);

        const latestPickerProps = optionPickerOverlayProps.at(-1);
        expect(latestPickerProps?.options.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description,
            iconAgentId: getOptionIconAgentId(option.icon),
            iconSize: getOptionIconSize(option.icon),
        }))).toEqual([
            {
                value: 'agent:claude\x1fretired-model',
                label: 'Retired model',
                description: 'Claude',
                iconAgentId: 'claude',
                iconSize: 20,
            },
        ]);
        expect(latestPickerProps?.favoriteOptions?.values.has('agent:claude\x1fretired-model')).toBe(true);

        latestPickerProps?.favoriteOptions?.onToggle(latestPickerProps.options[0]);

        expect(onRemoveFavoriteModelSelection).toHaveBeenCalledWith(favorite);
    });
});
