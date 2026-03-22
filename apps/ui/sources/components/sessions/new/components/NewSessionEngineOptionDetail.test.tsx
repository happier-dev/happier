import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { NewSessionEngineOptionDetail } from './NewSessionEngineOptionDetail';
import { renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modelOptionsState = vi.hoisted(() => ({
    value: [
        { value: 'default', label: 'Preset default', description: 'Uses the backend default.' },
        { value: 'preset-fast', label: 'Preset Fast', description: 'Fast preset model.' },
    ],
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
    value: [] as Array<{
        id: string;
        name: string;
        type: string;
        currentValue: string;
        options?: Array<{ value: string; name: string }>;
    }>,
}));
let lastModelPickerOverlayProps: any = null;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            ActivityIndicator: 'ActivityIndicator',
                                            Pressable: 'Pressable',
                                            Platform: {
                                            OS: 'ios',
                                            select: (value: Record<string, unknown>) => value.ios ?? value.default,
                                        },
                                            View: 'View',
                                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
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
    });
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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

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

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: vi.fn(),
        },
    }).module;
});

vi.mock('@/components/model/ModelPickerOverlay', () => ({
    ModelPickerOverlay: (props: any) => {
        lastModelPickerOverlayProps = props;
        return React.createElement(
            'ModelPickerOverlay',
            props,
            props.options?.map((option: { value: string; label: string }) => React.createElement(
                'Pressable',
                {
                    key: option.value,
                    testID: `model-picker-overlay-option:${option.value}`,
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
        expect(lastModelPickerOverlayProps.canEnterCustomModel).toBe(true);
    });

    it('still renders the model section when only custom model entry is available', async () => {
        modelOptionsState.value = [];
        preflightModelsState.value = {
            availableModels: [],
            supportsFreeform: true,
        };

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
        expect(lastModelPickerOverlayProps.canEnterCustomModel).toBe(true);
    });

    it('keeps custom model entry available when the provider catalog supports freeform even if preflight does not', async () => {
        preflightModelsState.value = {
            availableModels: [
                { id: 'claude-opus-4-6', name: 'claude-opus-4-6' },
            ],
            supportsFreeform: false,
        };

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
        expect(lastModelPickerOverlayProps.canEnterCustomModel).toBe(true);
    });

    it('publishes inline custom model submissions through the shared model picker surface', async () => {
        preflightModelsState.value = {
            availableModels: [],
            supportsFreeform: true,
        };
        let latestSelection: { modelId: string; sessionModeId: string; configOverrides: Readonly<Record<string, string>> } | null = null;

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

        expect(typeof lastModelPickerOverlayProps?.onSubmitCustomModel).toBe('function');

        act(() => {
            lastModelPickerOverlayProps.onSubmitCustomModel('custom-model');
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
});
