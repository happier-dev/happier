import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AgentInputSelectOption = Readonly<{ value: string; name: string }>;

type AgentInputOptionControl = Readonly<{
    id: string;
    name: string;
    type: string;
    currentValue: string;
    options?: ReadonlyArray<AgentInputSelectOption>;
}>;

type ModelOptionEntry = Readonly<{
    value: string;
    label: string;
    description: string;
    modelOptions?: ReadonlyArray<AgentInputOptionControl>;
}>;

const modelOptionsState = vi.hoisted(() => ({
    value: [
        { value: 'default', label: 'Preset default', description: 'Uses the backend default.' },
        { value: 'preset-fast', label: 'Preset Fast', description: 'Fast preset model.' },
    ] as ReadonlyArray<ModelOptionEntry>,
}));
const preflightModelsState = vi.hoisted(() => ({
    value: { availableModels: [] as Array<{ id: string; name: string }>, supportsFreeform: false },
}));
const agentCoreState = vi.hoisted(() => ({
    supportsFreeform: true,
}));

const modeOptionsState = vi.hoisted(() => ({
    value: [
        { id: 'default', name: 'Build', description: 'Default build mode.' },
        { id: 'review', name: 'Review', description: 'Review and critique mode.' },
    ],
}));

const configOptionsState = vi.hoisted(() => ({
    value: [] as ReadonlyArray<AgentInputOptionControl>,
}));
let lastModelPickerOverlayProps: any = null;

installNewSessionComponentsCommonModuleMocks({
    modal: () => createModalModuleMock({
        spies: {
            prompt: vi.fn(),
        },
    }).module,
    reactNative: () => createReactNativeWebMock({
        ActivityIndicator: 'ActivityIndicator',
        Pressable: 'Pressable',
        Platform: {
            OS: 'ios',
            select: (value: Record<string, unknown>) => value.ios ?? value.default,
        },
        View: 'View',
    }),
    text: () => createTextModuleMock({ translate: (key) => key }),
    unistyles: () => createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                divider: '#ddd',
                text: '#000',
                textSecondary: '#666',
                button: { primary: { background: '#06f', text: '#fff' } },
                warningCritical: '#c00',
                success: '#0a0',
            },
        },
    }),
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: () => ({
        model: {
            supportsFreeform: agentCoreState.supportsFreeform,
        },
    }),
}));

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
    resolveProviderAgentIdForBackendTarget: () => 'claude',
}));

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: (props: any) => {
        if (props.title === 'agentInput.model.title') {
            lastModelPickerOverlayProps = props;
        }
        const optionTestIDPrefix = props.optionTestIDPrefix ?? 'model-picker-overlay-option';
        return React.createElement(
            'OptionPickerOverlay',
            props,
            props.title,
            props.summary ?? null,
            props.headerAccessory ?? null,
            props.options?.map((option: { value: string; label: string }) => React.createElement(
                'Pressable',
                {
                    key: option.value,
                    testID: `${optionTestIDPrefix}:${option.value}`,
                    onPress: () => props.onSelect(option.value),
                },
                option.label,
            )) ?? null,
        );
    },
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        modelOptions: modelOptionsState.value,
        preflightModels: preflightModelsState.value,
        probe: { phase: 'idle', refresh: () => {} },
    }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState', () => ({
    useNewSessionPreflightSessionModesState: () => ({
        modeOptions: modeOptionsState.value,
        probe: { phase: 'idle', refresh: () => {} },
    }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState', () => ({
    useNewSessionPreflightConfigOptionsState: () => ({
        configOptions: configOptionsState.value,
        probe: { phase: 'idle', refresh: () => {} },
    }),
}));

describe('NewSessionEngineOptionDetail', () => {
    const backendTarget: BackendTargetRefV1 = {
        kind: 'configuredAcpBackend',
        backendId: 'custom-preset',
    };

    beforeEach(() => {
        modelOptionsState.value = [
            { value: 'default', label: 'Preset default', description: 'Uses the backend default.' },
            { value: 'preset-fast', label: 'Preset Fast', description: 'Fast preset model.' },
        ];
        preflightModelsState.value = { availableModels: [], supportsFreeform: false };
        agentCoreState.supportsFreeform = true;
        modeOptionsState.value = [
            { id: 'default', name: 'Build', description: 'Default build mode.' },
            { id: 'review', name: 'Review', description: 'Review and critique mode.' },
        ];
        configOptionsState.value = [];
        lastModelPickerOverlayProps = null;
    });

    it('publishes the selected mode synchronously so a following model click preserves it', async () => {
        type SelectionChange = {
            modelId: string;
            sessionModeId: string;
            configOverrides: Readonly<Record<string, string>>;
        };
        let latestSelection: SelectionChange | null = null;
        let latestSessionModeId: string | null = null;
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            onSelectionChange={(selection) => {
                latestSelection = selection as SelectionChange;
                latestSessionModeId = (selection as SelectionChange).sessionModeId;
            }}
        />);

        await screen.pressByTestIdAsync('agent-input-session-mode-option:review');
        expect(latestSessionModeId).toBe('review');

        await screen.pressByTestIdAsync('model-picker-overlay-option:preset-fast');
        expect(latestSelection).toEqual({
            modelId: 'preset-fast',
            sessionModeId: 'review',
            configOverrides: {},
        });
    });

    it('passes the full model list and custom-model capability through to ModelPickerOverlay', async () => {
        modelOptionsState.value = Array.from({ length: 12 }, (_, index) => ({
            value: `model-${index + 1}`,
            label: `Model ${index + 1}`,
            description: `Description ${index + 1}`,
        }));
        preflightModelsState.value = {
            availableModels: modelOptionsState.value.map((option) => ({ id: option.value, name: option.label })),
            supportsFreeform: true,
        };

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="model-1"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
        />);

        expect(lastModelPickerOverlayProps).toBeTruthy();
        expect(lastModelPickerOverlayProps.options).toHaveLength(12);
        expect(lastModelPickerOverlayProps.canEnterCustomValue).toBe(true);
    });

    it('adds a description to the CLI settings option when other models include descriptions', async () => {
        modelOptionsState.value = [
            { value: 'default', label: 'Use CLI settings', description: '' },
            { value: 'model-1', label: 'Model 1', description: 'A described model' },
        ];

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
        />);

        const defaultOption = (lastModelPickerOverlayProps?.options ?? []).find((o: any) => o.value === 'default');
        expect(defaultOption).toBeTruthy();
        expect(typeof defaultOption.description).toBe('string');
        expect(String(defaultOption.description).trim().length).toBeGreaterThan(0);
    });

    it('still renders the model section when only custom model entry is available', async () => {
        modelOptionsState.value = [];
        preflightModelsState.value = {
            availableModels: [],
            supportsFreeform: true,
        };

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
        />);

        expect(lastModelPickerOverlayProps).toBeTruthy();
        expect(lastModelPickerOverlayProps.options).toEqual([]);
        expect(lastModelPickerOverlayProps.canEnterCustomValue).toBe(true);
    });

    it('keeps custom model entry available when the provider catalog supports freeform even if preflight does not', async () => {
        preflightModelsState.value = {
            availableModels: [
                { id: 'claude-opus-4-6', name: 'claude-opus-4-6' },
            ],
            supportsFreeform: false,
        };

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
        />);

        expect(lastModelPickerOverlayProps).toBeTruthy();
        expect(lastModelPickerOverlayProps.canEnterCustomValue).toBe(true);
    });

    it('publishes inline custom model submissions through the shared model picker surface', async () => {
        preflightModelsState.value = {
            availableModels: [],
            supportsFreeform: true,
        };
        let latestSelection: { modelId: string; sessionModeId: string; configOverrides: Readonly<Record<string, string>> } | null = null;

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
                    backendTarget={backendTarget}
                    selectedMachineId="machine-1"
                    capabilityServerId="server-1"
                    cwd="/repo"
                    selectedModelId="default"
                    selectedSessionModeId="default"
                    selectedConfigOverrides={{}}
                    onSelectionChange={(selection) => {
                        latestSelection = selection;
                    }}
                />);

        expect(typeof lastModelPickerOverlayProps?.onSubmitCustomValue).toBe('function');

        act(() => {
            lastModelPickerOverlayProps.onSubmitCustomValue('custom-model');
        });

        expect(latestSelection).toEqual({
            modelId: 'custom-model',
            sessionModeId: 'default',
            configOverrides: {},
        });
    });

    it('renders ACP config options with the shared current-value summary and publishes overrides', async () => {
        configOptionsState.value = [
            {
                id: 'thinking',
                name: 'Thinking',
                type: 'select',
                currentValue: 'medium',
                options: [
                    { value: 'low', name: 'Low' },
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High' },
                ],
            },
        ];

        let latestSelection: { modelId: string; sessionModeId: string; configOverrides: Readonly<Record<string, string>> } | null = null;
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            onSelectionChange={(selection) => {
                latestSelection = selection;
            }}
        />);

        expect(screen.findByTestId('agent-input-config-option:thinking')).toBeTruthy();
        expect(screen.findByTestId('agent-input-config-option-summary:thinking')).toBeTruthy();
        expect(screen.findByTestId('agent-input-config-option-summary:thinking')?.props.children).toContain(
            'agentInput.acp.currentValue',
        );

        await screen.pressByTestIdAsync('agent-input-config-option-option:thinking:high');

        expect(latestSelection).toEqual({
            modelId: 'default',
            sessionModeId: 'default',
            configOverrides: {
                thinking: 'high',
            },
        });
    });

    it('merges multiple model option overrides (e.g. Thinking + Speed) instead of replacing prior selections', async () => {
        modelOptionsState.value = [
            {
                value: 'gpt-5.4',
                label: 'GPT 5.4',
                description: 'Frontier agentic coding model.',
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
        ];

        let latestSelection: { modelId: string; sessionModeId: string; configOverrides: Readonly<Record<string, string>> } | null = null;
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');

        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="gpt-5.4"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            onSelectionChange={(selection) => {
                latestSelection = selection;
            }}
        />);

        expect(typeof lastModelPickerOverlayProps?.onSelectOptionControlValue).toBe('function');

	        act(() => {
	            lastModelPickerOverlayProps.onSelectOptionControlValue('service_tier', 'fast');
	        });

	        expect(latestSelection).toEqual(expect.objectContaining({
	            configOverrides: {
	                service_tier: 'fast',
	            },
	        }));

	        // Simulate the parent re-rendering the detail pane with the new overrides.
	        await renderScreen(<NewSessionEngineOptionDetail
	            backendTarget={backendTarget}
	            selectedMachineId="machine-1"
	            capabilityServerId="server-1"
	            cwd="/repo"
	            selectedModelId="gpt-5.4"
	            selectedSessionModeId="default"
	            selectedConfigOverrides={{ service_tier: 'fast' }}
	            onSelectionChange={(selection) => {
	                latestSelection = selection;
	            }}
	        />);

        expect(typeof lastModelPickerOverlayProps?.onSelectOptionControlValue).toBe('function');

	        act(() => {
	            lastModelPickerOverlayProps.onSelectOptionControlValue('reasoning_effort', 'high');
	        });

	        expect(latestSelection).toEqual(expect.objectContaining({
	            configOverrides: {
	                reasoning_effort: 'high',
	                service_tier: 'fast',
	            },
	        }));
	    });
});
