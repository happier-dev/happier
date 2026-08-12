import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema, type BackendTargetRefV2 } from '@happier-dev/protocol';
import { FavoriteModelSelectionV1Schema } from '@/sync/domains/models/favoriteModelSelections';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AgentInputSelectOption = Readonly<{ value: string; name: string }>;

function favoriteModel(backendTargetKey: string, modelId: string, extra: Record<string, unknown> = {}) {
    return FavoriteModelSelectionV1Schema.parse({ backendTargetKey, modelId, ...extra });
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function resolveInteractiveStyle(style: unknown): Record<string, unknown> {
    return flattenStyle(typeof style === 'function'
        ? (style as (state: Readonly<{ pressed: boolean; hovered: boolean; focused: boolean }>) => unknown)({
            pressed: false,
            hovered: false,
            focused: false,
        })
        : style);
}

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
const providersFeatureEnabledState = vi.hoisted(() => ({ value: true }));
type ProviderProjectionResult = ReturnType<typeof useProviderModelProjection>;
const providerProjectionSpy = vi.hoisted(() => vi.fn<(input: unknown) => ProviderProjectionResult>((_input) => ({
    data: null,
    error: null,
    loading: false,
    status: 'pending',
    refresh: vi.fn(async () => {}),
    refreshWithResult: vi.fn(async () => null),
})));
let lastOptionPickerOverlayProps: any = null;

function renderedModelPickerOptions(): any[] {
    return (lastOptionPickerOverlayProps?.sections ?? [])
        .flatMap((section: { options?: readonly unknown[] }) => section.options ?? []);
}

function renderedNativeModelOption(modelId: string): any {
    return renderedModelPickerOptions().find((option) => (
        option.value?.providerConnectionId === null && option.value.modelId === modelId
    ));
}

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
            lastOptionPickerOverlayProps = props;
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

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => providersFeatureEnabledState.value,
}));

vi.mock('@/providers/hooks/useProviderModelProjection', () => ({
    useProviderModelProjection: (input: unknown) => providerProjectionSpy(input),
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
        lastOptionPickerOverlayProps = null;
        probeEnabledState.models = true;
        probeEnabledState.config = true;
        probePhaseState.models = 'idle';
        probePhaseState.config = 'idle';
        providersFeatureEnabledState.value = true;
        providerProjectionSpy.mockReset();
        providerProjectionSpy.mockReturnValue({
            data: null,
            error: null,
            loading: false,
            status: 'pending',
            refresh: vi.fn(async () => {}),
            refreshWithResult: vi.fn(async () => null),
        });
        probeRefreshSpies.cli.mockClear();
        probeRefreshSpies.models.mockClear();
        probeRefreshSpies.modes.mockClear();
        probeRefreshSpies.config.mockClear();
    });

    it('keeps provider projection disabled when the root providers feature is disabled', async () => {
        providersFeatureEnabledState.value = false;
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

        expect(providerProjectionSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
        expect(lastOptionPickerOverlayProps?.options).toEqual([]);
        expect(lastOptionPickerOverlayProps?.sections).toEqual([
            expect.objectContaining({
                id: 'native',
                options: expect.arrayContaining([
                    expect.objectContaining({ value: null }),
                    expect.objectContaining({
                        value: expect.objectContaining({
                            providerConnectionId: null,
                            modelId: 'preset-fast',
                        }),
                    }),
                ]),
            }),
        ]);
    });

    it('keeps the canonical structured picker for an enabled zero-Provider projection', async () => {
        providerProjectionSpy.mockReturnValueOnce({
            data: {
                status: 'success',
                agentTargetKey: formatBackendTargetKeyV2(backendTarget),
                groups: [],
            },
            error: null,
            loading: false,
            status: 'success',
            refresh: vi.fn(async () => {}),
            refreshWithResult: vi.fn(async () => null),
        });
        const onSelectionChange = vi.fn();
        const onModelSelectionChange = vi.fn();
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');

        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="preset-fast"
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            onSelectionChange={onSelectionChange}
            onModelSelectionChange={onModelSelectionChange}
        />);

        expect(lastOptionPickerOverlayProps?.options).toEqual([]);
        const nativeOption = lastOptionPickerOverlayProps?.sections
            ?.flatMap((section: { options: unknown[] }) => section.options)
            .find((option: { value?: { modelId?: string } | null }) => option.value?.modelId === 'preset-fast');
        expect(nativeOption).toEqual(expect.objectContaining({
            value: expect.objectContaining({ providerConnectionId: null, modelId: 'preset-fast' }),
        }));

        act(() => {
            lastOptionPickerOverlayProps.onSelect(nativeOption.value);
        });
        expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({
            modelId: 'preset-fast',
            modelSelection: expect.objectContaining({
                ref: expect.objectContaining({ providerConnectionId: null, modelId: 'preset-fast' }),
            }),
        }));
        expect(onModelSelectionChange).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            state: 'loading',
            projection: {
                data: null,
                error: null,
                loading: true,
                status: 'pending',
                refresh: vi.fn(async () => {}),
                refreshWithResult: vi.fn(async () => null),
            } satisfies ProviderProjectionResult,
        },
        {
            state: 'error',
            projection: {
                data: null,
                error: {
                    v: 1,
                    code: 'provider_endpoint_unreachable',
                    retryable: true,
                    action: 'retry',
                },
                loading: false,
                status: 'error',
                refresh: vi.fn(async () => {}),
                refreshWithResult: vi.fn(async () => null),
            } satisfies ProviderProjectionResult,
        },
    ])('keeps an exact Provider selection identity without a false recovery row while projection is $state', async ({ state, projection }) => {
        const providerConnectionId = ProviderConnectionIdSchema.parse('pc_stale');
        const selectedModelSelection = {
            v: 1 as const,
            updatedAt: 1,
            ref: {
                agentTargetKey: formatBackendTargetKeyV2(backendTarget),
                providerConnectionId,
                modelId: 'provider-only-model',
            },
        };
        providerProjectionSpy.mockReturnValue(projection);
        const onSelectionChange = vi.fn();
        const { NewSessionEngineOptionDetail } = await import('./NewSessionEngineOptionDetail');

        await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={backendTarget}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            cwd="/repo"
            selectedModelId="provider-only-model"
            selectedModelSelection={selectedModelSelection}
            selectedSessionModeId="default"
            selectedConfigOverrides={{}}
            onSelectionChange={onSelectionChange}
        />);

        expect(providerProjectionSpy).toHaveBeenCalledWith(expect.objectContaining({
            enabled: true,
            currentSelection: selectedModelSelection.ref,
        }));
        expect(lastOptionPickerOverlayProps?.options).toEqual([]);
        expect(lastOptionPickerOverlayProps?.selectedValue).toEqual(selectedModelSelection.ref);
        expect(lastOptionPickerOverlayProps?.effectiveLabel).toBe('provider-only-model');
        const renderedOptions = lastOptionPickerOverlayProps?.sections
            ?.flatMap((section: { options: unknown[] }) => section.options) ?? [];
        expect(renderedOptions.find(
            (option: { value?: { providerConnectionId?: string | null; modelId?: string } | null }) => (
                option.value?.providerConnectionId === providerConnectionId
                && option.value.modelId === 'provider-only-model'
            ),
        )).toBeUndefined();

        const nativeRecovery = renderedOptions.find(
            (option: { value?: { providerConnectionId?: string | null; modelId?: string } | null }) => (
                option.value?.providerConnectionId === null && option.value.modelId === 'preset-fast'
            ),
        );
        expect(nativeRecovery).toBeTruthy();
        expect(nativeRecovery.disabled).not.toBe(true);

        expect(lastOptionPickerOverlayProps?.probe?.phase).toBe(state === 'loading' ? 'loading' : 'idle');
        if (state === 'error') {
            const { ProviderErrorItems } = await import('@/components/settings/providers/ProviderErrorItems');
            expect(lastOptionPickerOverlayProps?.probe?.onRefresh).toBeTypeOf('function');
            expect(lastOptionPickerOverlayProps.summary).toBeTruthy();
            const summary = await renderScreen(lastOptionPickerOverlayProps.summary);
            const errorItems = summary.findByType(ProviderErrorItems.type);
            expect(errorItems.props.error).toBe(projection.error);
            expect(errorItems.props.retry).toBeTypeOf('function');
            await act(async () => { await errorItems.props.retry(); });
            expect(projection.refresh).toHaveBeenCalledTimes(1);
        }

        act(() => {
            lastOptionPickerOverlayProps.onSelect(nativeRecovery.value);
        });
        expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({
            modelSelection: expect.objectContaining({
                ref: expect.objectContaining({ providerConnectionId: null, modelId: 'preset-fast' }),
            }),
        }));
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

        expect(lastOptionPickerOverlayProps?.headerAccessory).toBeTruthy();

        const favoriteAction = screen.findByTestId('new-session-engine-favorite-toggle');
        const targetStyle = resolveInteractiveStyle(favoriteAction?.props.style);
        expect(targetStyle.width ?? targetStyle.minWidth).toBeGreaterThanOrEqual(44);
        expect(targetStyle.height ?? targetStyle.minHeight).toBeGreaterThanOrEqual(44);
        expect(favoriteAction?.props.accessibilityLabel).toBe('profiles.actions.removeFromFavorites');
        expect(typeof favoriteAction?.props.onFocus).toBe('function');

        await act(async () => {
            favoriteAction?.props.onFocus?.();
        });
        expect(screen.findByTestId('new-session-engine-favorite-toggle-tooltip')).toBeTruthy();

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

        act(() => {
            lastOptionPickerOverlayProps.onSelect(renderedNativeModelOption('preset-fast').value);
        });
        expect(latestSelection).toMatchObject({
            modelId: 'preset-fast',
            modelSelection: { ref: { providerConnectionId: null, modelId: 'preset-fast' } },
            sessionModeId: 'review',
            configOverrides: {},
        });
    });

    it('passes the full model list and custom-model capability through to OptionPickerOverlay', async () => {
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

        expect(lastOptionPickerOverlayProps).toBeTruthy();
        expect(lastOptionPickerOverlayProps.options).toEqual([]);
        expect(renderedModelPickerOptions()).toHaveLength(12);
        expect(lastOptionPickerOverlayProps.canEnterCustomValue).toBe(true);
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
                favoriteModel(formatBackendTargetKeyV2(backendTarget), 'preset-fast', { configuredBackendId: 'custom-preset' }),
                favoriteModel(formatBackendTargetKeyV2(backendTarget), 'catalog-only', { configuredBackendId: 'custom-preset' }),
            ]}
            onToggleFavoriteModel={vi.fn()}
        />);

        const presetFast = renderedNativeModelOption('preset-fast');
        const catalogOnly = renderedNativeModelOption('catalog-only');
        expect(lastOptionPickerOverlayProps?.favoriteOptions?.values.has(
            lastOptionPickerOverlayProps.getValueKey(presetFast.value),
        )).toBe(true);
        expect(lastOptionPickerOverlayProps?.favoriteOptions?.values.has(
            lastOptionPickerOverlayProps.getValueKey(catalogOnly.value),
        )).toBe(true);
        expect(lastOptionPickerOverlayProps?.favoriteOptions?.isFavoritable(presetFast)).toBe(true);
        expect(lastOptionPickerOverlayProps?.favoriteOptions?.isFavoritable(catalogOnly)).toBe(true);
        expect(renderedModelPickerOptions().map((option) => option.value?.modelId ?? 'default')).toEqual(
            expect.arrayContaining(['default', 'preset-fast', 'catalog-only']),
        );
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
                favoriteModel(formatBackendTargetKeyV2(staticBackendTarget), 'claude-sonnet-4-5', { builtInAgentId: 'claude' }),
            ]}
            onToggleFavoriteModel={vi.fn()}
        />);

        const sonnet = renderedNativeModelOption('claude-sonnet-4-5');
        const automatic = renderedModelPickerOptions().find((option) => option.value === null);
        expect(lastOptionPickerOverlayProps?.favoriteOptions?.values.has(
            lastOptionPickerOverlayProps.getValueKey(sonnet.value),
        )).toBe(true);
        expect(lastOptionPickerOverlayProps?.favoriteOptions?.isFavoritable(sonnet)).toBe(true);
        expect(lastOptionPickerOverlayProps?.favoriteOptions?.isFavoritable(automatic)).toBe(false);
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

        const defaultOption = renderedModelPickerOptions().find((option) => option.value === null);
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

        expect(lastOptionPickerOverlayProps).toBeTruthy();
        expect(lastOptionPickerOverlayProps.options).toEqual([]);
        expect(lastOptionPickerOverlayProps.canEnterCustomValue).toBe(true);
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

        expect(lastOptionPickerOverlayProps).toBeTruthy();
        expect(lastOptionPickerOverlayProps.options).toEqual([]);
        expect(lastOptionPickerOverlayProps.canEnterCustomValue).toBe(false);
        expect(lastOptionPickerOverlayProps.notes).toContain('agentInput.model.unavailable');
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

        expect(lastOptionPickerOverlayProps).toBeTruthy();
        expect(lastOptionPickerOverlayProps.notes).not.toContain('agentInput.model.unavailable');
        expect(lastOptionPickerOverlayProps.probe?.phase).toBe('loading');
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

        expect(lastOptionPickerOverlayProps).toBeTruthy();
        expect(lastOptionPickerOverlayProps.canEnterCustomValue).toBe(true);
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

        expect(typeof lastOptionPickerOverlayProps?.onSubmitCustomValue).toBe('function');

        act(() => {
            lastOptionPickerOverlayProps.onSubmitCustomValue('custom-model');
        });

        expect(latestSelection).toMatchObject({
            modelId: 'custom-model',
            modelSelection: { ref: { providerConnectionId: null, modelId: 'custom-model' } },
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

        await screen.pressByTestIdAsync(
            `agent-input-config-option-option:${JSON.stringify(['thinking', 'high'])}`,
        );

        expect(latestSelection).toEqual({
            modelId: 'default',
            modelSelection: null,
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

        expect(typeof lastOptionPickerOverlayProps?.onSelectOptionControlValue).toBe('function');

        act(() => {
            lastOptionPickerOverlayProps.onSelectOptionControlValue('service_tier', 'fast');
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

        expect(typeof lastOptionPickerOverlayProps?.onSelectOptionControlValue).toBe('function');

        act(() => {
            lastOptionPickerOverlayProps.onSelectOptionControlValue('reasoning_effort', 'high');
        });

        expect(latestSelection).toEqual(expect.objectContaining({
            configOverrides: {
                reasoning_effort: 'high',
                service_tier: 'fast',
            },
        }));
    });

    it('shows base model scoped controls when the selected model is its declared extended-context variant', async () => {
        modelOptionsState.value = [
            {
                value: 'claude-sonnet-4-6',
                label: 'Claude Sonnet 4.6',
                description: 'Base model with a 1M context variant.',
                extendedContextModelId: 'claude-sonnet-4-6[1m]',
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

        expect(lastOptionPickerOverlayProps?.selectedOptionControls).toEqual(expect.arrayContaining([
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
            lastOptionPickerOverlayProps.onSelect(renderedNativeModelOption('anthropic/claude-sonnet-4-6').value);
        });

        expect(latestSelection).toMatchObject({
            modelId: 'anthropic/claude-sonnet-4-6',
            modelSelection: { ref: { providerConnectionId: null, modelId: 'anthropic/claude-sonnet-4-6' } },
            sessionModeId: 'default',
            configOverrides: {
                service_tier: 'fast',
            },
        });
    });
});
