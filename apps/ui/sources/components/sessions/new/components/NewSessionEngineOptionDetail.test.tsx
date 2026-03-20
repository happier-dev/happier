import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { NewSessionEngineOptionDetail } from './NewSessionEngineOptionDetail';

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

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    View: 'View',
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => {
            const theme = {
                colors: {
                    divider: '#ddd',
                    surface: '#fff',
                    text: '#000',
                    textSecondary: '#666',
                    radio: {
                        active: '#06f',
                    },
                },
            };
            return typeof styles === 'function' ? styles(theme) : styles;
        },
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
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

vi.mock('@/modal', () => ({
    Modal: {
        prompt: vi.fn(),
    },
}));

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

    it('publishes the selected mode synchronously so a following model click preserves it', () => {
        let latestSelection: { modelId: string; sessionModeId: string; configOverrides: Readonly<Record<string, string>> } | null = null;
        let tree: ReactTestRenderer | undefined;

        act(() => {
            tree = renderer.create(
                <NewSessionEngineOptionDetail
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
                />,
            );
        });

        act(() => {
            tree!.root.findByProps({ testID: 'agent-input-session-mode-option:review' }).props.onPress();
            expect(latestSelection?.sessionModeId).toBe('review');
        });

        act(() => {
            tree!.root.findByProps({ testID: 'model-picker-overlay-option:preset-fast' }).props.onPress();
            expect(latestSelection).toEqual({
                modelId: 'preset-fast',
                sessionModeId: 'review',
                configOverrides: {},
            });
        });
    });

    it('passes the full model list and custom-model capability through to ModelPickerOverlay', () => {
        modelOptionsState.value = Array.from({ length: 12 }, (_, index) => ({
            value: `model-${index + 1}`,
            label: `Model ${index + 1}`,
            description: `Description ${index + 1}`,
        }));
        preflightModelsState.value = {
            availableModels: modelOptionsState.value.map((option) => ({ id: option.value, name: option.label })),
            supportsFreeform: true,
        };

        act(() => {
            renderer.create(
                <NewSessionEngineOptionDetail
                    backendTarget={backendTarget}
                    selectedMachineId="machine-1"
                    capabilityServerId="server-1"
                    cwd="/repo"
                    selectedModelId="model-1"
                    selectedSessionModeId="default"
                    selectedConfigOverrides={{}}
                />,
            );
        });

        expect(lastModelPickerOverlayProps).toBeTruthy();
        expect(lastModelPickerOverlayProps.options).toHaveLength(12);
        expect(lastModelPickerOverlayProps.canEnterCustomModel).toBe(true);
    });

    it('still renders the model section when only custom model entry is available', () => {
        modelOptionsState.value = [];
        preflightModelsState.value = {
            availableModels: [],
            supportsFreeform: true,
        };

        act(() => {
            renderer.create(
                <NewSessionEngineOptionDetail
                    backendTarget={backendTarget}
                    selectedMachineId="machine-1"
                    capabilityServerId="server-1"
                    cwd="/repo"
                    selectedModelId="default"
                    selectedSessionModeId="default"
                    selectedConfigOverrides={{}}
                />,
            );
        });

        expect(lastModelPickerOverlayProps).toBeTruthy();
        expect(lastModelPickerOverlayProps.options).toEqual([]);
        expect(lastModelPickerOverlayProps.canEnterCustomModel).toBe(true);
    });

    it('keeps custom model entry available when the provider catalog supports freeform even if preflight does not', () => {
        preflightModelsState.value = {
            availableModels: [
                { id: 'claude-opus-4-6', name: 'claude-opus-4-6' },
            ],
            supportsFreeform: false,
        };

        act(() => {
            renderer.create(
                <NewSessionEngineOptionDetail
                    backendTarget={backendTarget}
                    selectedMachineId="machine-1"
                    capabilityServerId="server-1"
                    cwd="/repo"
                    selectedModelId="default"
                    selectedSessionModeId="default"
                    selectedConfigOverrides={{}}
                />,
            );
        });

        expect(lastModelPickerOverlayProps).toBeTruthy();
        expect(lastModelPickerOverlayProps.canEnterCustomModel).toBe(true);
    });

    it('renders ACP config options with the shared current-value summary and publishes overrides', () => {
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
        let tree: ReactTestRenderer;

        act(() => {
            tree = renderer.create(
                <NewSessionEngineOptionDetail
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
                />,
            );
        });

        expect(() => tree!.root.findByProps({ testID: 'agent-input-config-option:thinking' })).not.toThrow();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-config-option-summary:thinking' })).not.toThrow();
        expect(tree!.root.findAllByProps({ children: 'agentInput.acp.currentValue' }).length).toBeGreaterThan(0);

        act(() => {
            tree!.root.findByProps({ testID: 'agent-input-config-option-option:thinking:high' }).props.onPress();
        });

        expect(latestSelection).toEqual({
            modelId: 'default',
            sessionModeId: 'default',
            configOverrides: {
                thinking: 'high',
            },
        });
    });
});
