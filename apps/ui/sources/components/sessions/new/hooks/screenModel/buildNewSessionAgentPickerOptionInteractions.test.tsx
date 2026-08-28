import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { installNewSessionComponentsCommonModuleMocks } from '@/components/sessions/new/components/newSessionComponentsTestHelpers';
import { createResolvedAgentCatalogEntryFixture, renderScreen } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

import type { SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedModelPickerProps = Readonly<{
    sections?: ReadonlyArray<{ options?: ReadonlyArray<{ value: { modelId: string; providerConnectionId: string | null } | null }> }>;
    onSelect: (value: { modelId: string; providerConnectionId: string | null } | null) => void;
}>;

const capturedModelPicker = vi.hoisted(() => ({ props: null as CapturedModelPickerProps | null }));

function requireCapturedModelPickerProps(): CapturedModelPickerProps {
    const props = capturedModelPicker.props;
    if (!props) throw new Error('model picker was not rendered');
    return props;
}

installNewSessionComponentsCommonModuleMocks({
    reactNative: () => createReactNativeWebMock({
        ActivityIndicator: 'ActivityIndicator',
        Pressable: 'Pressable',
        Platform: {
            OS: 'web',
            select: (value: Record<string, unknown>) => value.web ?? value.default,
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
    Typography: { default: () => ({}) },
}));

vi.mock('@/agents/catalog/catalog', () => ({
    isBundledAgentId: (value: string) => ['claude', 'codex', 'custom-preset'].includes(value),
    getAgentCore: () => ({ model: { supportsFreeform: true, dynamicProbe: 'dynamic' } }),
}));

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: (props: CapturedModelPickerProps & { title?: string }) => {
        if (props.title === 'agentInput.model.title') {
            capturedModelPicker.props = props;
        }
        return React.createElement('OptionPickerOverlay', { testID: 'option-picker-overlay' });
    },
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        modelOptions: [
            { value: 'default', label: 'Preset default', description: 'Uses the backend default.' },
            { value: 'preset-fast', label: 'Preset Fast', description: 'Fast preset model.' },
        ],
        preflightModels: { availableModels: [], supportsFreeform: false },
        probe: { phase: 'idle' },
    }),
}));

const capturedConfigOptionsProbe = vi.hoisted(() => ({
    runtimeCarrierAgentId: undefined as string | null | undefined,
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState', () => ({
    useNewSessionPreflightConfigOptionsState: (params: Readonly<{ runtimeCarrierAgentId?: string | null }>) => {
        capturedConfigOptionsProbe.runtimeCarrierAgentId = params.runtimeCarrierAgentId;
        return {
            configOptions: [],
            unavailable: false,
            probe: { phase: 'idle' },
        };
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/providers/hooks/useProviderModelProjection', () => ({
    useProviderModelProjection: () => ({
        data: null,
        error: null,
        loading: false,
        status: 'pending',
        refresh: vi.fn(async () => {}),
        refreshWithResult: vi.fn(async () => null),
    }),
}));

const backendTarget: BackendTargetRefV2 = {
    kind: 'backend',
    backendId: 'custom-preset',
    configuredBackendId: 'custom-preset',
    sourceKind: 'configured',
};

const entry: ResolvedBackendCatalogEntry = {
    agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: 'custom-preset' }),
    backendTarget,
    backendTargetKey: 'backend:custom-preset',
    kind: 'configuredBackend',
    backendId: 'custom-preset',
    agentId: 'custom-preset',
    catalogAgentId: null,
    builtInAgentId: null,
    iconAgentId: null,
    title: 'Custom Preset',
    subtitle: null,
    cliAuthBackgroundCheckSafe: false,
};

/**
 * An installed Agent owns its own `cli.<agentId>` capability, so the expanded
 * New Session detail must operate under that operational identity. `catalogAgentId`
 * is the closed built-in UI backing and is `null` for every plugin-contributed
 * Agent: handing it to the detail erases the identity every probe in that pane
 * keys on.
 */
const pluginEntry: ResolvedBackendCatalogEntry = {
    agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: 'acme.review.agent' }),
    backendTarget: { kind: 'backend', backendId: 'acme.review.agent' },
    backendTargetKey: 'backend:acme.review.agent',
    kind: 'pluginBackend',
    backendId: 'acme.review.agent',
    agentId: 'acme.review.agent',
    catalogAgentId: null,
    builtInAgentId: null,
    iconAgentId: null,
    title: 'Acme Review',
    subtitle: null,
    cliAuthBackgroundCheckSafe: false,
};

describe('buildNewSessionAgentPickerOptionInteractions', () => {
    it('expands an installed Agent detail under that Agent\'s operational identity', async () => {
        capturedConfigOptionsProbe.runtimeCarrierAgentId = undefined;
        const selection: SessionAgentPickerSelection = {
            modelId: 'default',
            modelSelection: null,
            sessionModeId: 'default',
            configOverrides: {},
        };

        const { buildNewSessionAgentPickerOptionInteractions } = await import('./buildNewSessionAgentPickerOptionInteractions');
        const interactions = buildNewSessionAgentPickerOptionInteractions({
            entry: pluginEntry,
            disabled: false,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            settings: settingsDefaults,
            getEngineSelectionForTargetKey: () => selection,
            selectEngineSelection: vi.fn(),
        });

        const renderDetailContent = interactions.renderDetailContent;
        if (!renderDetailContent) throw new Error('renderDetailContent missing');
        await renderScreen(<>{renderDetailContent({ onRequestClose: vi.fn() })}</>);

        expect(capturedConfigOptionsProbe.runtimeCarrierAgentId).toBe('acme.review.agent');
    }, 180_000);

    it('selects a model without requesting the engine popover close', async () => {
        capturedModelPicker.props = null;
        const onRequestClose = vi.fn();
        const selectEngineSelection = vi.fn();
        const selection: SessionAgentPickerSelection = {
            modelId: 'default',
            modelSelection: null,
            sessionModeId: 'default',
            configOverrides: {},
        };

        const { buildNewSessionAgentPickerOptionInteractions } = await import('./buildNewSessionAgentPickerOptionInteractions');
        const interactions = buildNewSessionAgentPickerOptionInteractions({
            entry,
            disabled: false,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            settings: settingsDefaults,
            getEngineSelectionForTargetKey: () => selection,
            selectEngineSelection,
        });

        const renderDetailContent = interactions.renderDetailContent;
        if (!renderDetailContent) throw new Error('renderDetailContent missing');
        await renderScreen(<>{renderDetailContent({ onRequestClose })}</>);

        const modelPicker = requireCapturedModelPickerProps();
        const option = (modelPicker.sections ?? [])
            .flatMap((section) => section.options ?? [])
            .find((candidate) => candidate.value?.modelId === 'preset-fast');
        if (!option) throw new Error('preset-fast option missing');

        await act(async () => {
            modelPicker.onSelect(option.value);
            // `deferAgentInputPopoverClose` defers to the next macrotask on web,
            // so drain one before asserting that no close was requested.
            await new Promise((resolve) => { setTimeout(resolve, 0); });
        });

        expect(selectEngineSelection).toHaveBeenCalledWith(entry, expect.objectContaining({
            modelId: 'preset-fast',
            modelSelection: expect.objectContaining({
                ref: expect.objectContaining({ modelId: 'preset-fast' }),
            }),
        }));
        expect(onRequestClose).not.toHaveBeenCalled();
    });
});
