import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';


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
const preflightModelsState = vi.hoisted<{
    value: {
        availableModels: Array<{ id: string; name: string; description?: string }>;
        supportsFreeform: boolean;
        unavailable?: boolean;
    } | null;
}>(() => ({
    value: { availableModels: [] as Array<{ id: string; name: string }>, supportsFreeform: false },
}));
const agentCoreState = vi.hoisted<{
    supportsFreeform: boolean;
    dynamicProbe: 'dynamic' | 'static-only';
}>(() => ({
    supportsFreeform: true,
    dynamicProbe: 'dynamic',
}));

const modeOptionsState = vi.hoisted(() => ({
    value: [
        { id: 'default', name: 'Build', description: 'Default build mode.' },
        { id: 'review', name: 'Review', description: 'Review and critique mode.' },
    ],
}));

const configOptionsState = vi.hoisted(() => ({
    value: [] as ReadonlyArray<AgentInputOptionControl>,
    unavailable: false,
}));
const probeEnabledState = vi.hoisted(() => ({
    models: true,
    config: true,
}));
const probePhaseState = vi.hoisted(() => ({
    models: 'idle' as 'idle' | 'loading' | 'refreshing',
    config: 'idle' as 'idle' | 'loading' | 'refreshing',
}));
let lastModelPickerOverlayProps: any = null;
const probeRefreshSpies = {
    cli: vi.fn(),
    models: vi.fn(),
    modes: vi.fn(),
    config: vi.fn(),
};

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
    isAgentId: (value: string) => ['claude', 'codex', 'custom-preset'].includes(value),
    getAgentCore: () => ({
        model: {
            supportsFreeform: agentCoreState.supportsFreeform,
            dynamicProbe: agentCoreState.dynamicProbe,
        },
    }),
}));

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: (props: any) => {
        if (props.title === 'agentInput.model.title') {
            lastModelPickerOverlayProps = props;
        }
        const optionTestIDPrefix = props.optionTestIDPrefix ?? 'model-picker-overlay-option';
        const refreshTestID = props.refreshTestID ?? 'model-picker-overlay-refresh';
        const probe = props.probe;
        return React.createElement(
            'OptionPickerOverlay',
            props,
            props.title,
            props.summary ?? null,
            props.headerAccessory ?? null,
            typeof probe?.onRefresh === 'function' ? React.createElement(
                'Pressable',
                {
                    testID: refreshTestID,
                    onPress: probe.phase === 'idle' ? probe.onRefresh : undefined,
                },
                null,
            ) : null,
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
        probe: {
            phase: probePhaseState.models,
            ...(probeEnabledState.models ? { onRefresh: probeRefreshSpies.models } : {}),
        },
    }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState', () => ({
    useNewSessionPreflightSessionModesState: () => ({
        modeOptions: modeOptionsState.value,
        probe: { phase: 'idle', onRefresh: probeRefreshSpies.modes },
    }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState', () => ({
    useNewSessionPreflightConfigOptionsState: () => ({
        configOptions: configOptionsState.value,
        unavailable: configOptionsState.unavailable,
        probe: {
            phase: probePhaseState.config,
            ...(probeEnabledState.config ? { onRefresh: probeRefreshSpies.config } : {}),
        },
    }),
}));

describe('NewSessionEngineOptionDetail', () => {
    const backendTarget: BackendTargetRefV2 = {
        kind: 'backend',
        backendId: 'custom-preset',
        configuredBackendId: 'custom-preset',
        sourceKind: 'configured',
    };

    beforeEach(() => {
        modelOptionsState.value = [
            { value: 'default', label: 'Preset default', description: 'Uses the backend default.' },
            { value: 'preset-fast', label: 'Preset Fast', description: 'Fast preset model.' },
        ];
        preflightModelsState.value = { availableModels: [], supportsFreeform: false };
        agentCoreState.supportsFreeform = true;
        agentCoreState.dynamicProbe = 'dynamic';
        modeOptionsState.value = [
            { id: 'default', name: 'Build', description: 'Default build mode.' },
            { id: 'review', name: 'Review', description: 'Review and critique mode.' },
        ];
        configOptionsState.value = [];
        configOptionsState.unavailable = false;
        lastModelPickerOverlayProps = null;
        probeEnabledState.models = true;
        probeEnabledState.config = true;
        probePhaseState.models = 'idle';
        probePhaseState.config = 'idle';
        probeRefreshSpies.cli.mockClear();
        probeRefreshSpies.models.mockClear();
        probeRefreshSpies.modes.mockClear();
        probeRefreshSpies.config.mockClear();
    });

    it('renders an engine favorite action in the model header and toggles it without refreshing models', async () => {
        const onToggleFavoriteEngine = vi.fn();
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            favoriteEngine={{
                favorite: true,
                onToggle: onToggleFavoriteEngine,
            }}
        />);

        expect(lastModelPickerOverlayProps?.headerAccessory).toBeTruthy();

        await screen.pressByTestIdAsync('new-session-engine-favorite-toggle');

        expect(onToggleFavoriteEngine).toHaveBeenCalledTimes(1);
        expect(probeRefreshSpies.models).not.toHaveBeenCalled();
    });

    it('does not render session mode selection in the engine popover (mode is controlled by the dedicated chip) and preserves the incoming sessionModeId on model changes', async () => {
        type SelectionChange = {
            modelId: string;
            sessionModeId: string;
            configOverrides: Readonly<Record<string, string>>;
        };
        let latestSelection: SelectionChange | null = null;
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="review"
            selectedConfigOverrides={{}}
            onSelectionChange={(selection) => {
                latestSelection = selection as SelectionChange;
            }}
        />);

        expect(() => screen.findByProps({ testID: 'agent-input-session-mode-option:review' })).toThrow();

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

    it('marks dynamically probed and catalog fallback models as favoritable for dynamic backends', async () => {
        modelOptionsState.value = [
            { value: 'default', label: 'Use CLI settings', description: '' },
            { value: 'preset-fast', label: 'Preset Fast', description: 'Fast preset model.' },
            { value: 'catalog-only', label: 'Catalog Only', description: 'Catalog fallback.' },
        ];
        preflightModelsState.value = {
            availableModels: [{ id: 'preset-fast', name: 'Preset Fast' }],
            supportsFreeform: false,
        };
        agentCoreState.dynamicProbe = 'dynamic';

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="preset-fast"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            favoriteModelSelections={[
                { backendTargetKey: formatBackendTargetKeyV2(backendTarget), configuredBackendId: 'custom-preset', modelId: 'preset-fast' },
                { backendTargetKey: formatBackendTargetKeyV2(backendTarget), configuredBackendId: 'custom-preset', modelId: 'catalog-only' },
            ]}
            onToggleFavoriteModel={vi.fn()}
        />);

        expect(lastModelPickerOverlayProps?.favoriteOptions?.values.has('preset-fast')).toBe(true);
        expect(lastModelPickerOverlayProps?.favoriteOptions?.values.has('catalog-only')).toBe(true);
        expect(lastModelPickerOverlayProps?.favoriteOptions?.isFavoritable({ value: 'preset-fast' })).toBe(true);
        expect(lastModelPickerOverlayProps?.favoriteOptions?.isFavoritable({ value: 'catalog-only' })).toBe(true);
        expect((lastModelPickerOverlayProps?.options ?? []).map((option: ModelOptionEntry) => option.value)).toEqual([
            'preset-fast',
            'catalog-only',
            'default',
        ]);
    });

    it('marks static catalog models as favoritable for static-only backends', async () => {
        const staticBackendTarget: BackendTargetRefV2 = {
            kind: 'backend',
            backendId: 'claude',
        };
        modelOptionsState.value = [
            { value: 'default', label: 'Use CLI settings', description: '' },
            { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'Static model.' },
        ];
        preflightModelsState.value = null;
        agentCoreState.dynamicProbe = 'static-only';

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={staticBackendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="claude-sonnet-4-5"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            favoriteModelSelections={[
                { backendTargetKey: 'agent:claude', builtInAgentId: 'claude', modelId: 'claude-sonnet-4-5' },
            ]}
            onToggleFavoriteModel={vi.fn()}
        />);

        expect(lastModelPickerOverlayProps?.favoriteOptions?.values.has('claude-sonnet-4-5')).toBe(true);
        expect(lastModelPickerOverlayProps?.favoriteOptions?.isFavoritable({ value: 'claude-sonnet-4-5' })).toBe(true);
        expect(lastModelPickerOverlayProps?.favoriteOptions?.isFavoritable({ value: 'default' })).toBe(false);
    });

    it('renders a single refresh control (in the model section) that refreshes CLI detection even when model/config probes have no refresh callback', async () => {
        configOptionsState.value = [];
        probeEnabledState.models = false;
        probeEnabledState.config = false;

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            refreshProbe={{ phase: 'idle', onRefresh: probeRefreshSpies.cli }}
        />);

        expect(screen.findByTestId('agent-input-config-options-refresh')).toBeNull();
        expect(screen.findByTestId('model-picker-overlay-refresh')).toBeTruthy();

        await screen.pressByTestIdAsync('model-picker-overlay-refresh');
        expect(probeRefreshSpies.cli).toHaveBeenCalledTimes(1);
        expect(probeRefreshSpies.models).toHaveBeenCalledTimes(0);
        expect(probeRefreshSpies.config).toHaveBeenCalledTimes(0);
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

    it('shows a shared unavailable note when dynamic model discovery is unavailable', async () => {
        const builtInBackendTarget: BackendTargetRefV2 = {
            kind: 'backend',
            backendId: 'codex',
        };
        modelOptionsState.value = [];
        preflightModelsState.value = {
            availableModels: [],
            supportsFreeform: false,
            unavailable: true,
        };
        agentCoreState.supportsFreeform = true;

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={builtInBackendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
        />);

        expect(lastModelPickerOverlayProps).toBeTruthy();
        expect(lastModelPickerOverlayProps.options).toEqual([]);
        expect(lastModelPickerOverlayProps.canEnterCustomValue).toBe(false);
        expect(lastModelPickerOverlayProps.notes).toContain('agentInput.model.unavailable');
    });

    it('suppresses the unavailable model note while an unavailable probe is retrying', async () => {
        const builtInBackendTarget: BackendTargetRefV2 = {
            kind: 'backend',
            backendId: 'codex',
        };
        modelOptionsState.value = [];
        preflightModelsState.value = {
            availableModels: [],
            supportsFreeform: false,
            unavailable: true,
        };
        probePhaseState.models = 'loading';

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={builtInBackendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
        />);

        expect(lastModelPickerOverlayProps).toBeTruthy();
        expect(lastModelPickerOverlayProps.notes).not.toContain('agentInput.model.unavailable');
        expect(lastModelPickerOverlayProps.probe?.phase).toBe('loading');
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

    it('does not render a session-mode picker inside the engine popover (mode is configured via the separate chip)', async () => {
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            onSelectionChange={() => {}}
        />);

        expect(screen.findByTestId('agent-input-session-mode-option:review')).toBeNull();
        expect(screen.findByTestId('agent-input-session-mode-option:default')).toBeNull();
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

    it('renders a shared unavailable note when dynamic config option discovery is unavailable', async () => {
        configOptionsState.value = [];
        configOptionsState.unavailable = true;

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
        />);

        expect(screen.findByTestId('agent-input-config-options-unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('agentInput.acp.optionsUnavailable');
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

    it('shows base model scoped controls when the selected model is an effective bracket variant', async () => {
        modelOptionsState.value = [
            {
                value: 'claude-sonnet-4-6',
                label: 'Claude Sonnet 4.6',
                description: 'Base model with a 1M context variant.',
                modelOptions: [{
                    id: 'reasoning_effort',
                    name: 'Reasoning effort',
                    type: 'select',
                    currentValue: 'medium',
                    options: [
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                    ],
                }],
            },
        ];

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="claude-sonnet-4-6[1m]"
            selectedSessionModeId="default"
            selectedConfigOverrides={{ reasoning_effort: 'high' }}
        />);

        expect(lastModelPickerOverlayProps?.selectedOptionControls).toEqual(expect.arrayContaining([
            expect.objectContaining({
                option: expect.objectContaining({ id: 'reasoning_effort' }),
                effectiveValue: 'high',
            }),
        ]));
    });

    it('drops incompatible model option overrides when another model is selected', async () => {
        modelOptionsState.value = [
            {
                value: 'anthropic/claude-opus-4-1',
                label: 'Claude Opus 4.1',
                description: 'Previous model.',
                modelOptions: [{
                    id: 'reasoning_effort',
                    name: 'Reasoning effort',
                    type: 'select',
                    currentValue: 'xhigh',
                    options: [
                        { value: 'high', name: 'High' },
                        { value: 'xhigh', name: 'Extra high' },
                    ],
                }],
            },
            {
                value: 'anthropic/claude-sonnet-4-6',
                label: 'Claude Sonnet 4.6',
                description: 'Selected model.',
                modelOptions: [{
                    id: 'reasoning_effort',
                    name: 'Reasoning effort',
                    type: 'select',
                    currentValue: 'medium',
                    options: [
                        { value: 'low', name: 'Low' },
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                    ],
                }],
            },
        ];
        configOptionsState.value = [{
            id: 'service_tier',
            name: 'Speed',
            type: 'select',
            currentValue: 'standard',
            options: [
                { value: 'standard', name: 'Standard' },
                { value: 'fast', name: 'Fast' },
            ],
        }];

        let latestSelection: { modelId: string; sessionModeId: string; configOverrides: Readonly<Record<string, string>> } | null = null;
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="anthropic/claude-opus-4-1"
            selectedSessionModeId="default"
            selectedConfigOverrides={{
                reasoning_effort: 'xhigh',
                service_tier: 'fast',
            }}
            onSelectionChange={(selection) => {
                latestSelection = selection;
            }}
        />);

        act(() => {
            lastModelPickerOverlayProps.onSelect('anthropic/claude-sonnet-4-6');
        });

        expect(latestSelection).toEqual({
            modelId: 'anthropic/claude-sonnet-4-6',
            sessionModeId: 'default',
            configOverrides: {
                service_tier: 'fast',
            },
        });
    });
});
