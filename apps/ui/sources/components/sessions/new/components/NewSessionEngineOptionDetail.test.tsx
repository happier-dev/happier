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
    category?: string;
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
const providerAgentIdState = vi.hoisted(() => ({ value: 'claude' }));

const modeOptionsState = vi.hoisted(() => ({
    value: [
        { id: 'default', name: 'Build', description: 'Default build mode.' },
        { id: 'review', name: 'Review', description: 'Review and critique mode.' },
    ],
}));

const configOptionsState = vi.hoisted(() => ({
    value: [] as ReadonlyArray<AgentInputOptionControl>,
}));
const probeEnabledState = vi.hoisted(() => ({
    models: true,
    config: true,
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
    getAgentCore: () => ({
        model: {
            supportsFreeform: agentCoreState.supportsFreeform,
            dynamicProbe: agentCoreState.dynamicProbe,
        },
    }),
}));

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
    resolveProviderAgentIdForBackendTarget: () => providerAgentIdState.value,
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
            phase: 'idle',
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
        probe: {
            phase: 'idle',
            ...(probeEnabledState.config ? { onRefresh: probeRefreshSpies.config } : {}),
        },
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
        agentCoreState.dynamicProbe = 'dynamic';
        providerAgentIdState.value = 'claude';
        modeOptionsState.value = [
            { id: 'default', name: 'Build', description: 'Default build mode.' },
            { id: 'review', name: 'Review', description: 'Review and critique mode.' },
        ];
        configOptionsState.value = [];
        lastModelPickerOverlayProps = null;
        probeEnabledState.models = true;
        probeEnabledState.config = true;
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
                { backendTargetKey: 'acpBackend:custom-preset', modelId: 'preset-fast' },
                { backendTargetKey: 'acpBackend:custom-preset', modelId: 'catalog-only' },
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
        modelOptionsState.value = [
            { value: 'default', label: 'Use CLI settings', description: '' },
            { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'Static model.' },
        ];
        preflightModelsState.value = null;
        agentCoreState.dynamicProbe = 'static-only';

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="claude-sonnet-4-5"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            favoriteModelSelections={[
                { backendTargetKey: 'acpBackend:custom-preset', modelId: 'claude-sonnet-4-5' },
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

    it('renders Cursor model-scoped ACP options only as selected-model controls', async () => {
        const modelScopedOptions: ReadonlyArray<AgentInputOptionControl> = [
            {
                id: 'reasoning_effort',
                name: 'Reasoning',
                type: 'select',
                currentValue: 'medium',
                options: [
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High' },
                ],
            },
            {
                id: 'effort',
                name: 'Effort',
                type: 'select',
                currentValue: 'high',
                options: [
                    { value: 'medium', name: 'Medium' },
                    { value: 'high', name: 'High' },
                ],
            },
            {
                id: 'context',
                name: 'Context',
                type: 'select',
                currentValue: '200k',
                options: [
                    { value: '200k', name: '200k' },
                    { value: '272k', name: '272k' },
                ],
            },
            {
                id: 'fast',
                name: 'Fast',
                type: 'select',
                currentValue: 'false',
                options: [
                    { value: 'false', name: 'Off' },
                    { value: 'true', name: 'On' },
                ],
            },
            {
                id: 'thinking',
                name: 'Thinking',
                type: 'select',
                currentValue: 'enabled',
                options: [
                    { value: 'disabled', name: 'Disabled' },
                    { value: 'enabled', name: 'Enabled' },
                ],
            },
        ];
        modelOptionsState.value = [
            {
                value: 'composer-2.5',
                label: 'Composer 2.5',
                description: 'Cursor default.',
                modelOptions: modelScopedOptions,
            },
        ];
        configOptionsState.value = [
            ...modelScopedOptions,
            {
                id: 'telemetry',
                name: 'Telemetry',
                type: 'select',
                currentValue: 'false',
                options: [
                    { value: 'false', name: 'Off' },
                    { value: 'true', name: 'On' },
                ],
            },
        ];

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="composer-2.5"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
        />);

        for (const option of modelScopedOptions) {
            expect(screen.findByTestId(`agent-input-config-option:${option.id}`)).toBeNull();
        }
        expect(screen.findByTestId('agent-input-config-option:telemetry')).toBeTruthy();
        expect(lastModelPickerOverlayProps?.selectedOptionControls?.map((control: any) => control.option.id)).toEqual([
            'reasoning_effort',
            'effort',
            'context',
            'fast',
            'thinking',
        ]);
    });

    it('does not render model or mode ACP config options as generic engine controls while model probing is pending', async () => {
        modelOptionsState.value = [];
        configOptionsState.value = [
            {
                id: 'mode',
                name: 'Mode',
                category: 'mode',
                type: 'select',
                currentValue: 'agent',
                options: [
                    { value: 'agent', name: 'Agent' },
                    { value: 'plan', name: 'Plan' },
                ],
            },
            {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: 'composer-2.5[fast=true]',
                options: [
                    { value: 'composer-2.5[fast=true]', name: 'Composer 2.5' },
                    { value: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'GPT-5.5' },
                ],
            },
            {
                id: 'telemetry',
                name: 'Telemetry',
                category: 'session',
                type: 'select',
                currentValue: 'false',
                options: [
                    { value: 'false', name: 'Off' },
                    { value: 'true', name: 'On' },
                ],
            },
        ];

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

        expect(screen.findByTestId('agent-input-config-option:mode')).toBeNull();
        expect(screen.findByTestId('agent-input-config-option:model')).toBeNull();
        expect(screen.findByTestId('agent-input-config-option:telemetry')).toBeTruthy();
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

    it('publishes a valid model option override after the model changes', async () => {
        modelOptionsState.value = [
            {
                value: 'anthropic/claude-opus-4-1',
                label: 'Claude Opus 4.1',
                description: 'Previous model.',
                modelOptions: [{
                    id: 'legacy_thinking',
                    name: 'Legacy thinking',
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
                legacy_thinking: 'xhigh',
                service_tier: 'fast',
            }}
            onSelectionChange={(selection) => {
                latestSelection = selection;
            }}
        />);

        act(() => {
            lastModelPickerOverlayProps.onSelect('anthropic/claude-sonnet-4-6');
        });

        act(() => {
            lastModelPickerOverlayProps.onSelectOptionControlValue('reasoning_effort', 'high');
        });

        expect(latestSelection).toEqual({
            modelId: 'anthropic/claude-sonnet-4-6',
            sessionModeId: 'default',
            configOverrides: {
                reasoning_effort: 'high',
                service_tier: 'fast',
            },
        });
    });

    it('renders advertised Grok models with only each selected model\'s effort control and dispatches canonical overrides', async () => {
        providerAgentIdState.value = 'grok';
        modelOptionsState.value = [
            {
                value: 'grok-4.5',
                label: 'Grok 4.5',
                description: 'Current model.',
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
            {
                value: 'grok-4.1-fast',
                label: 'Grok 4.1 Fast',
                description: 'Fast model.',
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
            {
                value: 'grok-build',
                label: 'Grok Build',
                description: 'Compatibility fallback without effort metadata.',
            },
        ];
        preflightModelsState.value = {
            availableModels: modelOptionsState.value.map((model) => ({ id: model.value, name: model.label })),
            supportsFreeform: false,
        };
        agentCoreState.supportsFreeform = false;
        let latestSelection: {
            modelId: string;
            sessionModeId: string;
            configOverrides: Readonly<Record<string, string>>;
        } | null = null;

        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={{ kind: 'builtInAgent', agentId: 'grok' }}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="grok-4.5"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            onSelectionChange={(selection) => {
                latestSelection = selection;
            }}
        />);

        expect(lastModelPickerOverlayProps.options.map((model: ModelOptionEntry) => model.value)).toEqual([
            'grok-4.5',
            'grok-4.1-fast',
            'grok-build',
        ]);
        expect(lastModelPickerOverlayProps.selectedOptionControls).toEqual([
            expect.objectContaining({
                option: expect.objectContaining({
                    id: 'reasoning_effort',
                    options: [
                        { value: 'low', name: 'Low' },
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                    ],
                }),
            }),
        ]);

        act(() => {
            lastModelPickerOverlayProps.onSelectOptionControlValue('reasoning_effort', 'high');
        });
        expect(latestSelection).toEqual({
            modelId: 'grok-4.5',
            sessionModeId: 'default',
            configOverrides: { reasoning_effort: 'high' },
        });

        act(() => {
            lastModelPickerOverlayProps.onSelect('grok-4.1-fast');
        });
        expect(lastModelPickerOverlayProps.selectedOptionControls[0].option.options).toEqual([
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
        ]);

        act(() => {
            lastModelPickerOverlayProps.onSelect('grok-build');
        });
        expect(lastModelPickerOverlayProps.selectedOptionControls).toBeUndefined();
        expect(latestSelection).toEqual({
            modelId: 'grok-build',
            sessionModeId: 'default',
            configOverrides: {},
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

    it('does not issue an extra commit when equal config overrides are re-passed with a fresh object', async () => {
        const commitPhases: string[] = [];
        const overrides = { service_tier: 'fast' } as const;
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(
            <React.Profiler
                id="NewSessionEngineOptionDetail"
                onRender={(_id, phase) => {
                    commitPhases.push(phase);
                }}
            >
                <NewSessionEngineOptionDetail
                    backendTarget={backendTarget}
                    selectedMachineId="machine-1"
                    capabilityServerId="server-1"
                    cwd="/repo"
                    selectedModelId="gpt-5.4"
                    selectedSessionModeId="default"
                    selectedConfigOverrides={overrides}
                />
            </React.Profiler>,
        );

        commitPhases.length = 0;

        await screen.update(
            <React.Profiler
                id="NewSessionEngineOptionDetail"
                onRender={(_id, phase) => {
                    commitPhases.push(phase);
                }}
            >
                <NewSessionEngineOptionDetail
                    backendTarget={backendTarget}
                    selectedMachineId="machine-1"
                    capabilityServerId="server-1"
                    cwd="/repo"
                    selectedModelId="gpt-5.4"
                    selectedSessionModeId="default"
                    selectedConfigOverrides={{ service_tier: 'fast' }}
                />
            </React.Profiler>,
        );

        expect(commitPhases).toEqual(['update']);
    });

    it('does not republish an identical config selection when the current option is chosen again', async () => {
        configOptionsState.value = [
            {
                id: 'thinking',
                name: 'Thinking',
                type: 'select',
                currentValue: 'high',
                options: [
                    { value: 'low', name: 'Low' },
                    { value: 'high', name: 'High' },
                ],
            },
        ];

        const onSelectionChange = vi.fn();
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{ thinking: 'high' }}
            onSelectionChange={onSelectionChange}
        />);

        await screen.pressByTestIdAsync('agent-input-config-option-option:thinking:high');

        expect(onSelectionChange).not.toHaveBeenCalled();
    });

    it('does not republish an identical model selection when the current model is chosen again', async () => {
        const onSelectionChange = vi.fn();
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="default"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            onSelectionChange={onSelectionChange}
        />);

        act(() => {
            lastModelPickerOverlayProps.onSelect('default');
        });

        expect(onSelectionChange).not.toHaveBeenCalled();
    });
});
