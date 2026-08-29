import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AgentId } from '@/agents/catalog/catalog';
import { createResolvedAgentCatalogEntryFixture, renderScreen } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import type { OptionPickerOverlayProps } from '@/components/sessions/pickers/OptionPickerOverlay';
import type { ModelOption, PreflightModelList } from '@/sync/domains/models/modelOptions';
import { settingsParse } from '@/sync/domains/settings/settings';
import {
    DEFAULT_PROVIDER_SETTINGS_V1,
    serializeModelVisibilityRefV1,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';
import { FavoriteModelSelectionV1Schema } from '@/sync/domains/models/favoriteModelSelections';
import { SelectionList } from '@/components/ui/selectionList';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let optionPickerOverlayProps: OptionPickerOverlayProps[] = [];
let renderActualOptionPickerOverlay = false;

function favoriteModel(backendTargetKey: string, modelId: string, extra: Record<string, unknown> = {}) {
    return FavoriteModelSelectionV1Schema.parse({ backendTargetKey, modelId, ...extra });
}

function favoriteOptionValue(backendTargetKey: string, modelId: string, providerConnectionId: string | null = null) {
    return JSON.stringify([backendTargetKey, providerConnectionId, modelId]);
}

function expectedNativeSelection(backendTargetKey: string, modelId: string) {
    return expect.objectContaining({
        ref: { agentTargetKey: backendTargetKey, providerConnectionId: null, modelId },
    });
}

function getOptionIdentityIconProps(icon: React.ReactNode): React.ComponentProps<typeof AgentCatalogIdentityIcon> | null {
    return React.isValidElement<React.ComponentProps<typeof AgentCatalogIdentityIcon>>(icon)
        && icon.type === AgentCatalogIdentityIcon
        ? icon.props
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

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/pickers/OptionPickerOverlay')>();
    const StringOptionPickerOverlay = actual.OptionPickerOverlay<string>;
    return {
        ...actual,
        OptionPickerOverlay: (props: OptionPickerOverlayProps) => {
            optionPickerOverlayProps.push(props);
            return renderActualOptionPickerOverlay
                ? React.createElement(StringOptionPickerOverlay, props)
                : React.createElement('OptionPickerOverlay', props);
        },
    };
});

const settings = settingsParse({});

function createBuiltInEntry(agentId: AgentId, title: string): ResolvedBackendCatalogEntry {
    const backendTarget: BackendTargetRefV2 = { kind: 'backend', backendId: agentId, sourceKind: 'built_in' };
    return {
        agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId }),
        backendTarget,
        backendTargetKey: `agent:${agentId}`,
        kind: 'builtInAgent',
        backendId: agentId,
        agentId: agentId,
        catalogAgentId: agentId,
        builtInAgentId: agentId,
        iconAgentId: agentId,
        title,
        subtitle: agentId,
        cliAuthBackgroundCheckSafe: false,
    };
}

const agentCoreById: Partial<Record<AgentId, { dynamicProbe: 'dynamic' | 'static-only' }>> = {
    claude: { dynamicProbe: 'dynamic' },
    codex: { dynamicProbe: 'dynamic' },
};

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        AGENT_IDS: ['claude', 'codex'],
        getAgentCore: (agentId: AgentId | null) => {
            const core = actual.getAgentCore(agentId);
            return {
                ...core,
                model: {
                    ...core.model,
                    dynamicProbe: agentId ? (agentCoreById[agentId]?.dynamicProbe ?? 'dynamic') : 'dynamic',
                },
            };
        },
        getAgentIconSource: () => null,
        getAgentIconSvgXml: () => null,
        getAgentIconTintColor: () => null,
        isBundledAgentId: (value: unknown): value is string => typeof value === 'string' && ['claude', 'codex', 'customAcp'].includes(value),
    };
});

const preflightModelsByTargetKey: Record<string, {
    modelOptions: ModelOption[];
    preflightModels: PreflightModelList | null;
    probePhase?: 'idle' | 'loading' | 'refreshing';
}> = {};
const providerGroupsByTargetKey: Record<string, any[]> = {};
const providerFailuresByTargetKey: Record<string, any[]> = {};
const providerErrorsByTargetKey: Record<string, any> = {};
let providersFeatureEnabled = true;
let retainStaleProviderProjectionDataWhenDisabled = false;
const providerProjectionInputs: Array<Readonly<{
    enabled: boolean;
    agentTargetKey: string;
}>> = [];

vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => providersFeatureEnabled }));
vi.mock('@/providers/hooks/useProviderModelProjection', () => ({
    useProviderModelProjection: (input: { enabled: boolean; agentTargetKey: string }) => {
        providerProjectionInputs.push(input);
        return {
            data: input.enabled || retainStaleProviderProjectionDataWhenDisabled
                ? { status: 'success', agentTargetKey: input.agentTargetKey, groups: providerGroupsByTargetKey[input.agentTargetKey] ?? [] }
                : null,
            error: providerErrorsByTargetKey[input.agentTargetKey] ?? null,
            refreshFailures: input.enabled ? (providerFailuresByTargetKey[input.agentTargetKey] ?? []) : [],
            loading: false,
            status: input.enabled ? 'success' : 'disabled',
            refresh: vi.fn(),
        };
    },
}));

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
        renderActualOptionPickerOverlay = false;
        for (const key of Object.keys(preflightModelsByTargetKey)) {
            delete preflightModelsByTargetKey[key];
        }
        for (const key of Object.keys(providerGroupsByTargetKey)) {
            delete providerGroupsByTargetKey[key];
        }
        for (const key of Object.keys(providerFailuresByTargetKey)) {
            delete providerFailuresByTargetKey[key];
        }
        for (const key of Object.keys(providerErrorsByTargetKey)) {
            delete providerErrorsByTargetKey[key];
        }
        providersFeatureEnabled = true;
        retainStaleProviderProjectionDataWhenDisabled = false;
        providerProjectionInputs.length = 0;
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
                favoriteModel('agent:claude', 'claude-opus-4-6', {
                    catalogAgentId: 'claude',
                    builtInAgentId: 'claude',
                    backendLabel: 'Claude',
                    modelLabel: 'Opus 4.6',
                }),
                favoriteModel('agent:codex', 'gpt-5.5', {
                    catalogAgentId: 'codex',
                    builtInAgentId: 'codex',
                    backendLabel: 'Codex',
                    modelLabel: 'GPT 5.5',
                }),
            ]}
            resolvedBackendEntries={[
                createBuiltInEntry('claude', 'Claude'),
                createBuiltInEntry('codex', 'Codex'),
            ]}
            selectedBackendTargetKey="agent:claude"
            selectedModelId="claude-opus-4-6"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            projectionCurrent
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
        expect(latestPickerProps?.options.map((option) => getOptionIdentityIconProps(option.icon))).toEqual([
            expect.objectContaining({
                entry: expect.objectContaining({ agentId: 'claude' }),
                machineId: 'machine-1',
                serverId: 'server-1',
                current: true,
                size: 20,
            }),
            expect.objectContaining({
                entry: expect.objectContaining({ agentId: 'codex' }),
                machineId: 'machine-1',
                serverId: 'server-1',
                current: true,
                size: 20,
            }),
        ]);
        expect(latestPickerProps?.options.map((option) => getOptionIconSize(option.icon))).toEqual([
            20,
            20,
        ]);
    });

    it('surfaces projection-wide Provider errors alongside per-connection failures', async () => {
        providerErrorsByTargetKey['agent:codex'] = createProviderErrorV1('provider_machine_unavailable', {
            machineId: 'machine-1',
        });
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');
        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[favoriteModel('agent:codex', 'gpt-5.5', {
                catalogAgentId: 'codex', builtInAgentId: 'codex', backendLabel: 'Codex', modelLabel: 'GPT 5.5',
            })]}
            resolvedBackendEntries={[createBuiltInEntry('codex', 'Codex')]}
            selectedBackendTargetKey="agent:codex"
            selectedModelId="gpt-5.5"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            projectionCurrent
            settings={settings}
            onSelectFavoriteModel={vi.fn()}
            onToggleFavoriteModel={vi.fn()}
        />);

        const summary = optionPickerOverlayProps.at(-1)?.summary;
        const summaryScreen = await renderScreen(<>{summary}</>);
        expect(summaryScreen.findAllByType(ProviderErrorItems.type).map((item) => item.props.error.code))
            .toEqual(['provider_machine_unavailable']);
    });

    it('surfaces every Provider projection failure for favorite backends', async () => {
        providerFailuresByTargetKey['agent:codex'] = [
            {
                connectionId: 'pc_secret',
                error: createProviderErrorV1('provider_secret_missing', {
                    machineId: 'machine-1', connectionId: 'pc_secret',
                }),
            },
            {
                connectionId: 'pc_endpoint',
                error: createProviderErrorV1('provider_endpoint_unavailable', {
                    machineId: 'machine-1', connectionId: 'pc_endpoint',
                }),
            },
        ];
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');
        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[favoriteModel('agent:codex', 'gpt-5.5', {
                catalogAgentId: 'codex', builtInAgentId: 'codex', backendLabel: 'Codex', modelLabel: 'GPT 5.5',
            })]}
            resolvedBackendEntries={[createBuiltInEntry('codex', 'Codex')]}
            selectedBackendTargetKey="agent:codex"
            selectedModelId="gpt-5.5"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            projectionCurrent
            settings={settings}
            onSelectFavoriteModel={vi.fn()}
            onToggleFavoriteModel={vi.fn()}
        />);

        const summary = optionPickerOverlayProps.at(-1)?.summary;
        const summaryScreen = await renderScreen(<>{summary}</>);
        expect(summaryScreen.findAllByType(ProviderErrorItems.type).map((item) => item.props.error.code))
            .toEqual(['provider_secret_missing', 'provider_endpoint_unavailable']);
    });

    it('keeps the real favorite picker root scope stable across non-structural parent rerenders', async () => {
        renderActualOptionPickerOverlay = true;
        preflightModelsByTargetKey['agent:codex'] = {
            modelOptions: [],
            preflightModels: {
                availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
                supportsFreeform: false,
            },
        };
        const favorite = favoriteModel('agent:codex', 'gpt-5.5', {
            catalogAgentId: 'codex',
            builtInAgentId: 'codex',
            backendLabel: 'Codex',
            modelLabel: 'GPT 5.5',
        });
        const favoriteModelSelections = [favorite];
        const resolvedBackendEntries = [createBuiltInEntry('codex', 'Codex')];
        const onSelectFavoriteModel = vi.fn();
        const onToggleFavoriteModel = vi.fn();
        const onRemoveFavoriteModelSelection = vi.fn();
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');
        const renderDetail = () => (
            <NewSessionFavoriteModelsDetail
                favoriteModelSelections={favoriteModelSelections}
                resolvedBackendEntries={resolvedBackendEntries}
                selectedBackendTargetKey="agent:codex"
                selectedModelId="gpt-5.5"
                selectedMachineId="machine-1"
                capabilityServerId="server-1"
                cwd="/repo"
                settings={settings}
                onSelectFavoriteModel={onSelectFavoriteModel}
                onToggleFavoriteModel={onToggleFavoriteModel}
                onRemoveFavoriteModelSelection={onRemoveFavoriteModelSelection}
            />
        );
        const screen = await renderScreen(renderDetail());
        const rootStepBefore = screen.findByType(SelectionList).props.rootStep;

        await act(async () => {
            screen.tree.update(renderDetail());
        });

        expect(screen.findByType(SelectionList).props.rootStep).toBe(rootStepBefore);
    });

    it('keeps an eligible Provider favorite selectable by its exact connection-bound ref', async () => {
        const providerFavorite = FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1, updatedAt: 1,
                ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_work', modelId: 'shared-model' },
            },
            modelLabel: 'Provider shared model', backendLabel: 'Codex', catalogAgentId: 'codex', builtInAgentId: 'codex',
        });
        providerGroupsByTargetKey['agent:codex'] = [{
            connectionId: providerFavorite.selection.ref.providerConnectionId,
            providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom',
            connectionRevision: 1, authorization: { authorized: true }, manualModelPolicy: 'allowed', supportsFreeformModelIds: true,
            suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent',
            rows: [{
                ref: providerFavorite.selection.ref,
                descriptor: { id: 'shared-model', name: 'Provider shared model', description: 'From Work' },
                sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                compatibility: { result: { status: 'verified' }, compatibilityFingerprint: 'compatibility:v1:work', confirmed: true },
                endpointHealth: 'available', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
            }],
        }];
        const onSelectFavoriteModel = vi.fn();
        const codexEntry = createBuiltInEntry('codex', 'Codex');
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[providerFavorite]}
            resolvedBackendEntries={[codexEntry]}
            selectedBackendTargetKey="agent:codex"
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            settings={settings}
            onSelectFavoriteModel={onSelectFavoriteModel}
            onToggleFavoriteModel={vi.fn()}
        />);

        const picker = optionPickerOverlayProps.at(-1);
        const exactValue = favoriteOptionValue('agent:codex', 'shared-model', 'pc_work');
        expect(picker?.options).toEqual(expect.arrayContaining([expect.objectContaining({
            value: exactValue,
            label: 'Provider shared model',
        })]));
        picker?.onSelect?.(exactValue);
        expect(onSelectFavoriteModel).toHaveBeenCalledWith(
            codexEntry,
            expect.objectContaining({ ref: providerFavorite.selection.ref }),
            {},
        );
    });

    it('keeps the canonical disabled presentation for a favorite the projection refuses', async () => {
        const providerFavorite = FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1, updatedAt: 1,
                ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_work', modelId: 'blocked-model' },
            },
            modelLabel: 'Blocked model', backendLabel: 'Codex', catalogAgentId: 'codex', builtInAgentId: 'codex',
        });
        providerGroupsByTargetKey['agent:codex'] = [{
            connectionId: providerFavorite.selection.ref.providerConnectionId,
            providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom',
            connectionRevision: 1, authorization: { authorized: true }, manualModelPolicy: 'allowed', supportsFreeformModelIds: true,
            suppressedConnectedServiceIds: [], modelLoadAction: 'descriptor_absent',
            rows: [{
                ref: providerFavorite.selection.ref,
                descriptor: { id: 'blocked-model', name: 'Blocked model', description: 'From Work' },
                sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                compatibility: {
                    result: { status: 'incompatible', reasons: [] },
                    compatibilityFingerprint: 'compatibility:v1:blocked',
                    confirmed: false,
                },
                endpointHealth: 'available', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible',
            }],
        }];
        const onSelectFavoriteModel = vi.fn();
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[providerFavorite]}
            resolvedBackendEntries={[createBuiltInEntry('codex', 'Codex')]}
            selectedBackendTargetKey="agent:codex"
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            settings={settings}
            onSelectFavoriteModel={onSelectFavoriteModel}
            onToggleFavoriteModel={vi.fn()}
        />);

        const picker = optionPickerOverlayProps.at(-1);
        const exactValue = favoriteOptionValue('agent:codex', 'blocked-model', 'pc_work');
        const blocked = picker?.options.find((option) => option.value === exactValue);
        // The projection already decided this row is unselectable and why; the
        // favorites pane must show that decision rather than an enabled-looking
        // row whose press silently does nothing.
        expect(blocked?.disabled).toBe(true);
        expect(blocked?.description).toContain('settingsProviders.compatibility.incompatible');
        picker?.onSelect?.(exactValue);
        expect(onSelectFavoriteModel).not.toHaveBeenCalled();
    });

    it('keeps duplicate Provider favorite names collision-safe for assistive technology', async () => {
        const favorites = ['pc_gateway_a', 'pc_gateway_b'].map((connectionId) => (
            FavoriteModelSelectionV1Schema.parse({
                selection: {
                    v: 1,
                    updatedAt: 1,
                    ref: {
                        agentTargetKey: 'agent:codex',
                        providerConnectionId: connectionId,
                        modelId: 'shared-model',
                    },
                },
                modelLabel: 'Shared model',
                backendLabel: 'Codex',
                catalogAgentId: 'codex',
                builtInAgentId: 'codex',
            })
        ));
        providerGroupsByTargetKey['agent:codex'] = favorites.map((favorite, index) => ({
            connectionId: favorite.selection.ref.providerConnectionId,
            providerName: `Gateway ${index === 0 ? 'A' : 'B'}`,
            connectionName: 'Work',
            connectionRole: 'named',
            connectionDisplayNameMode: 'custom',
            connectionRevision: 1,
            authorization: { authorized: true },
            manualModelPolicy: 'allowed',
            supportsFreeformModelIds: true,
            suppressedConnectedServiceIds: [],
            modelLoadAction: 'descriptor_absent',
            rows: [{
                ref: favorite.selection.ref,
                descriptor: { id: 'shared-model', name: 'Shared model' },
                sources: { manual: false, static: true, probe: false },
                confidence: 'verified_static',
                compatibility: {
                    result: { status: 'verified' },
                    compatibilityFingerprint: `compatibility:v1:${index}`,
                    confirmed: true,
                },
                endpointHealth: 'available',
                catalog: { stale: false },
                loadState: 'unknown',
                visibility: 'visible',
            }],
        }));
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={favorites}
            resolvedBackendEntries={[createBuiltInEntry('codex', 'Codex')]}
            selectedBackendTargetKey="agent:codex"
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            settings={settings}
            onSelectFavoriteModel={vi.fn()}
            onToggleFavoriteModel={vi.fn()}
        />);

        expect(optionPickerOverlayProps.at(-1)?.options.map((option) => option.accessibilityLabel)).toEqual([
            'Gateway A, Work, Shared model',
            'Gateway B, Work, Shared model',
        ]);
    });

    it('keeps deleted same-model Provider favorites collision-safe from persisted display snapshots', async () => {
        const favorites = ['Work', 'Personal'].map((connectionName, index) => (
            FavoriteModelSelectionV1Schema.parse({
                selection: {
                    v: 1,
                    updatedAt: 1,
                    ref: {
                        agentTargetKey: 'agent:codex',
                        providerConnectionId: `pc_deleted_${index}`,
                        modelId: 'shared-model',
                    },
                },
                modelLabel: 'Shared model',
                backendLabel: 'Codex',
                catalogAgentId: 'codex',
                builtInAgentId: 'codex',
                providerDisplaySnapshot: {
                    providerName: 'Gateway',
                    connectionName,
                    connectionRole: 'named',
                    connectionDisplayNameMode: 'custom',
                },
            })
        ));
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={favorites}
            resolvedBackendEntries={[createBuiltInEntry('codex', 'Codex')]}
            selectedBackendTargetKey="agent:codex"
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            settings={settings}
            onSelectFavoriteModel={vi.fn()}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        expect(optionPickerOverlayProps.at(-1)?.options.map((option) => ({
            label: option.label,
            description: option.description,
            accessibilityLabel: option.accessibilityLabel,
        }))).toEqual([
            {
                label: 'Shared model',
                description: 'Gateway · Work',
                accessibilityLabel: 'Gateway, Work, Shared model',
            },
            {
                label: 'Shared model',
                description: 'Gateway · Personal',
                accessibilityLabel: 'Gateway, Personal, Shared model',
            },
        ]);
    });

    it('applies hidden native model policy when Providers are enabled', async () => {
        providersFeatureEnabled = true;
        const favorite = favoriteModel('agent:codex', 'hidden-native', {
            modelLabel: 'Hidden native', backendLabel: 'Codex', catalogAgentId: 'codex', builtInAgentId: 'codex',
        });
        preflightModelsByTargetKey['agent:codex'] = {
            modelOptions: [{ value: 'hidden-native', label: 'Hidden native', description: '' }],
            preflightModels: { availableModels: [{ id: 'hidden-native', name: 'Hidden native' }], supportsFreeform: false },
        };
        const visibilityKey = serializeModelVisibilityRefV1({
            scope: 'agent', agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'hidden-native',
        });
        const hiddenSettings = settingsParse({
            providerSettingsV1: {
                ...DEFAULT_PROVIDER_SETTINGS_V1,
                modelVisibilityByRef: { [visibilityKey]: 'hidden' },
            },
        });
        const onSelectFavoriteModel = vi.fn();
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[favorite]}
            resolvedBackendEntries={[createBuiltInEntry('codex', 'Codex')]}
            selectedBackendTargetKey="agent:codex"
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            settings={hiddenSettings}
            onSelectFavoriteModel={onSelectFavoriteModel}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        const picker = optionPickerOverlayProps.at(-1);
        const value = favoriteOptionValue('agent:codex', 'hidden-native');
        expect(picker?.options).toEqual(expect.arrayContaining([expect.objectContaining({ value })]));
        picker?.onSelect?.(value);
        expect(onSelectFavoriteModel).not.toHaveBeenCalled();
    });

    it('keeps native favorites available and disables Provider projection when Providers are unavailable', async () => {
        providersFeatureEnabled = false;
        retainStaleProviderProjectionDataWhenDisabled = true;
        const favorite = favoriteModel('agent:codex', 'hidden-native', {
            modelLabel: 'Hidden native', backendLabel: 'Codex', catalogAgentId: 'codex', builtInAgentId: 'codex',
        });
        const providerFavorite = FavoriteModelSelectionV1Schema.parse({
            selection: {
                v: 1,
                updatedAt: 1,
                ref: {
                    agentTargetKey: 'agent:codex',
                    providerConnectionId: 'pc_stale',
                    modelId: 'stale-provider-model',
                },
            },
            modelLabel: 'Stale Provider model',
            backendLabel: 'Codex',
            catalogAgentId: 'codex',
            builtInAgentId: 'codex',
        });
        providerGroupsByTargetKey['agent:codex'] = [{
            connectionId: providerFavorite.selection.ref.providerConnectionId,
            providerName: 'Gateway',
            connectionName: 'Stale cache',
            connectionRole: 'named',
            connectionDisplayNameMode: 'custom',
            connectionRevision: 1,
            authorization: { authorized: true },
            manualModelPolicy: 'allowed',
            supportsFreeformModelIds: true,
            suppressedConnectedServiceIds: [],
            modelLoadAction: 'descriptor_absent',
            rows: [{
                ref: providerFavorite.selection.ref,
                descriptor: { id: 'stale-provider-model', name: 'Stale Provider model' },
                sources: { manual: false, static: true, probe: false },
                confidence: 'verified_static',
                compatibility: {
                    result: { status: 'verified' },
                    compatibilityFingerprint: 'compatibility:v1:stale',
                    confirmed: true,
                },
                endpointHealth: 'available',
                catalog: { stale: false },
                loadState: 'unknown',
                visibility: 'visible',
            }],
        }];
        preflightModelsByTargetKey['agent:codex'] = {
            modelOptions: [{ value: 'hidden-native', label: 'Hidden native', description: '' }],
            preflightModels: { availableModels: [{ id: 'hidden-native', name: 'Hidden native' }], supportsFreeform: false },
        };
        const visibilityKey = serializeModelVisibilityRefV1({
            scope: 'agent', agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'hidden-native',
        });
        const hiddenSettings = settingsParse({
            providerSettingsV1: {
                ...DEFAULT_PROVIDER_SETTINGS_V1,
                modelVisibilityByRef: { [visibilityKey]: 'hidden' },
            },
        });
        const onSelectFavoriteModel = vi.fn();
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[favorite, providerFavorite]}
            resolvedBackendEntries={[createBuiltInEntry('codex', 'Codex')]}
            selectedBackendTargetKey="agent:codex"
            selectedModelId="default"
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            settings={hiddenSettings}
            onSelectFavoriteModel={onSelectFavoriteModel}
            onToggleFavoriteModel={vi.fn()}
            onRemoveFavoriteModelSelection={vi.fn()}
        />);

        expect(providerProjectionInputs.length).toBeGreaterThan(0);
        expect(providerProjectionInputs.every((input) => (
            input.enabled === false && input.agentTargetKey === 'agent:codex'
        ))).toBe(true);
        const picker = optionPickerOverlayProps.at(-1);
        const value = favoriteOptionValue('agent:codex', 'hidden-native');
        picker?.onSelect?.(value);
        expect(onSelectFavoriteModel).toHaveBeenCalledWith(
            expect.objectContaining({ backendTargetKey: 'agent:codex' }),
            expectedNativeSelection('agent:codex', 'hidden-native'),
            {},
        );
        onSelectFavoriteModel.mockClear();
        picker?.onSelect?.(favoriteOptionValue('agent:codex', 'stale-provider-model', 'pc_stale'));
        expect(onSelectFavoriteModel).not.toHaveBeenCalled();
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
        const favorite = favoriteModel('agent:codex', 'gpt-5.5', {
            catalogAgentId: 'codex',
            builtInAgentId: 'codex',
            backendLabel: 'Codex',
            modelLabel: 'GPT 5.5',
        });
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
        stalePickerProps?.onSelect?.(favoriteOptionValue('agent:codex', 'gpt-5.5'));
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
        availablePickerProps?.onSelect?.(favoriteOptionValue('agent:codex', 'gpt-5.5'));

        expect(onSelectFavoriteModel).toHaveBeenCalledWith(codexEntry, expectedNativeSelection('agent:codex', 'gpt-5.5'), {});
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
                favoriteModel('agent:codex', 'gpt-5.5', {
                    catalogAgentId: 'codex',
                    builtInAgentId: 'codex',
                    backendLabel: 'Codex',
                    modelLabel: 'GPT 5.5',
                }),
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
        latestPickerProps?.onSelect?.(favoriteOptionValue('agent:codex', 'gpt-5.5'));

        expect(onSelectFavoriteModel).toHaveBeenCalledWith(codexEntry, expectedNativeSelection('agent:codex', 'gpt-5.5'), {});
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
                favoriteModel('agent:codex', 'gpt-5.5', {
                    catalogAgentId: 'codex',
                    builtInAgentId: 'codex',
                    backendLabel: 'Codex',
                    modelLabel: 'GPT 5.5',
                }),
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
        latestPickerProps?.onSelect?.(favoriteOptionValue('agent:codex', 'gpt-5.5'));

        expect(onSelectFavoriteModel).toHaveBeenCalledWith(codexEntry, expectedNativeSelection('agent:codex', 'gpt-5.5'), {});
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
                favoriteModel('agent:codex', 'gpt-5.5', {
                    catalogAgentId: 'codex',
                    builtInAgentId: 'codex',
                    backendLabel: 'Codex',
                    modelLabel: 'GPT 5.5',
                }),
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

        expect(onSelectFavoriteModelOptionValue).toHaveBeenCalledWith(
            codexEntry,
            expectedNativeSelection('agent:codex', 'gpt-5.5'),
            'reasoning_effort',
            'medium',
        );
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
                favoriteModel('agent:codex', 'gpt-5.5', {
                    catalogAgentId: 'codex',
                    builtInAgentId: 'codex',
                    backendLabel: 'Codex',
                    modelLabel: 'GPT 5.5',
                }),
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
        latestPickerProps?.onSelect?.(favoriteOptionValue('agent:codex', 'gpt-5.5'));

        expect(onSelectFavoriteModel).toHaveBeenCalledWith(codexEntry, expectedNativeSelection('agent:codex', 'gpt-5.5'), {
            service_tier: 'fast',
        });
    });

    it('renders stale favorite models with a remove affordance instead of dropping the pane', async () => {
        const onRemoveFavoriteModelSelection = vi.fn();
        const favorite = favoriteModel('agent:claude', 'retired-model', {
            catalogAgentId: 'claude',
            builtInAgentId: 'claude',
            backendLabel: 'Claude',
            modelLabel: 'Retired model',
        });
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
                identityAgentId: getOptionIdentityIconProps(option.icon)?.entry.agentId ?? null,
            iconSize: getOptionIconSize(option.icon),
        }))).toEqual([
            {
                value: favoriteOptionValue('agent:claude', 'retired-model'),
                label: 'Retired model',
                description: 'Claude',
                identityAgentId: 'claude',
                iconSize: 20,
            },
        ]);
        expect(latestPickerProps?.favoriteOptions?.values.has(favoriteOptionValue('agent:claude', 'retired-model'))).toBe(true);

        latestPickerProps?.favoriteOptions?.onToggle(latestPickerProps.options[0]);

        expect(onRemoveFavoriteModelSelection).toHaveBeenCalledWith(favorite);
    });

    it('routes an extended-context favorite control through model selection instead of config overrides', async () => {
        const onSelectFavoriteModel = vi.fn();
        const onSelectFavoriteModelOptionValue = vi.fn();
        preflightModelsByTargetKey['agent:claude'] = {
            modelOptions: [{
                value: 'claude-sonnet-4-6',
                label: 'Sonnet 4.6',
                description: 'Balanced',
                extendedContextModelId: 'claude-sonnet-4-6[1m]',
            }],
            preflightModels: null,
        };
        const claudeEntry = createBuiltInEntry('claude', 'Claude');
        const { NewSessionFavoriteModelsDetail } = await import('./NewSessionFavoriteModelsDetail');

        await renderScreen(<NewSessionFavoriteModelsDetail
            favoriteModelSelections={[favoriteModel('agent:claude', 'claude-sonnet-4-6')]}
            resolvedBackendEntries={[claudeEntry]}
            selectedBackendTargetKey="agent:claude"
            selectedModelId="claude-sonnet-4-6"
            selectedConfigOverrides={{ reasoning_effort: 'high' }}
            selectedMachineId="machine-1"
            capabilityServerId="server-1"
            settings={settings}
            onSelectFavoriteModel={onSelectFavoriteModel}
            onSelectFavoriteModelOptionValue={onSelectFavoriteModelOptionValue}
            onToggleFavoriteModel={vi.fn()}
        />);

        const latestPickerProps = optionPickerOverlayProps.at(-1);
        expect(latestPickerProps?.selectedOptionControls?.find(
            (control) => control.option.id === 'extended_context_model',
        )?.effectiveValue).toBe('false');
        latestPickerProps?.onSelectOptionControlValue?.('extended_context_model', 'true');

        expect(onSelectFavoriteModel).toHaveBeenCalledWith(
            claudeEntry,
            expectedNativeSelection('agent:claude', 'claude-sonnet-4-6[1m]'),
            { reasoning_effort: 'high' },
        );
        expect(onSelectFavoriteModelOptionValue).not.toHaveBeenCalled();
    });
});
