import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentStaticModels } from '@happier-dev/agents';
import {
    createProviderErrorV1,
    DEFAULT_PROVIDER_SETTINGS_V1,
    ProviderConnectionIdSchema,
    serializeModelVisibilityRefV1,
    type ProviderBoundModelRef,
} from '@happier-dev/protocol';
import type { DaemonProviderCurrentSelectionRecoveryV1 } from '@happier-dev/protocol/rpc';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { SessionModelProjectionGroup } from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import type { OptionPickerOverlayProps } from '@/components/sessions/pickers/OptionPickerOverlay';
import { renderScreen } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { settingsParse } from '@/sync/domains/settings/settings';

import {
    installProfileEditFormModuleMocks,
    profileEditFormTestState,
    resetProfileEditFormTestState,
} from './profileEditFormTestHelpers';
import { resolveProfileBackendTargetKeyForEntry } from './profileBackendEntryStorage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let settingsState = settingsParse({});
let providersFeatureEnabled = true;
let optionPickerOverlayProps: Array<OptionPickerOverlayProps<ProviderBoundModelRef | null>> = [];
let providerProjectionGroups: SessionModelProjectionGroup[] = [];
let providerCurrentSelectionRecovery: DaemonProviderCurrentSelectionRecoveryV1 | null = null;
let providerProjectionError: unknown = null;
const providerProjectionRefresh = vi.fn(async () => {});
const confirmExperimental = vi.fn(async (_confirmation: unknown, commitSelection: () => void) => {
    commitSelection();
    return true;
});
const clearExperimentalFailure = vi.fn();
const confirmationHookInputs: Array<Readonly<{
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    agentTargetKey: string | null;
}>> = [];

resetProfileEditFormTestState();
installProfileEditFormModuleMocks({
    storageModule: () => createStorageModuleStub({
        useSettings: () => settingsState,
    }),
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (
        featureId: string,
        scope?: Readonly<{ scopeKind?: string; serverId?: string | null }>,
    ) => providersFeatureEnabled
        && featureId === 'providers'
        && scope?.scopeKind === 'spawn'
        && scope.serverId === 'server-profile',
}));

vi.mock('@/providers/hooks/useProviderModelProjection', () => ({
    useProviderModelProjection: () => ({
        data: {
            status: 'success',
            agentTargetKey: 'backend:claude',
            groups: providerProjectionGroups,
            currentSelectionRecovery: providerCurrentSelectionRecovery,
        },
        error: providerProjectionError,
        loading: false,
        status: 'success',
        refresh: providerProjectionRefresh,
    }),
}));

vi.mock('@/providers/hooks/useConfirmExperimentalProviderModel', () => ({
    useConfirmExperimentalProviderModel: (input: Readonly<{
        enabled: boolean;
        machineId: string | null;
        serverId: string | null;
        agentTargetKey: string | null;
    }>) => {
        confirmationHookInputs.push(input);
        return {
            confirm: confirmExperimental,
            error: null,
            retry: null,
            clear: clearExperimentalFailure,
        };
    },
}));

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: (props: OptionPickerOverlayProps<ProviderBoundModelRef | null>) => {
        optionPickerOverlayProps.push(props);
        return React.createElement('OptionPickerOverlay');
    },
}));

function claudeEntry(): ResolvedBackendCatalogEntry {
    return {
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        backendTargetKey: 'agent:claude',
        kind: 'builtInAgent',
        backendId: 'claude',
        agentId: 'claude',
        catalogAgentId: 'claude',
        builtInAgentId: 'claude',
        iconAgentId: 'claude',
        title: 'Claude',
        subtitle: 'Claude',
    };
}

function staleProviderGroup(): SessionModelProjectionGroup {
    const connectionId = ProviderConnectionIdSchema.parse('pc_stale');
    return {
        connectionId,
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
            ref: {
                agentTargetKey: 'agent:claude',
                providerConnectionId: connectionId,
                modelId: 'stale-provider-model',
            },
            descriptor: { id: 'stale-provider-model', name: 'Stale Provider model' },
            sources: { manual: false, static: true, probe: false },
            confidence: 'verified_static',
            compatibility: {
                result: {
                    status: 'verified',
                    selectedProtocol: 'openai-responses',
                    evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-07-12' },
                },
                compatibilityFingerprint: 'compatibility:v1:stale',
                confirmed: true,
            },
            endpointHealth: 'available',
            catalog: { stale: false },
            loadState: 'unknown',
            visibility: 'visible',
        }],
    };
}

function experimentalProviderGroup(): SessionModelProjectionGroup {
    const base = staleProviderGroup();
    const row = base.rows[0]!;
    return {
        ...base,
        connectionRevision: 7,
        rows: [{
            ...row,
            ref: {
                ...row.ref,
                agentTargetKey: 'backend:claude',
                modelId: 'experimental-provider-model',
            },
            descriptor: { id: 'experimental-provider-model', name: 'Experimental Provider model' },
            compatibility: {
                result: {
                    status: 'experimental',
                    selectedProtocol: 'openai-responses',
                    reasons: ['compatibility_evidence_missing'],
                    confirmationScope: { kind: 'model', modelId: 'experimental-provider-model' },
                },
                compatibilityFingerprint: 'compatibility:v1:experimental-provider-model',
                confirmed: false,
            },
        }],
    };
}

function sameModelProviderGroup(input: Readonly<{
    connectionId: string;
    connectionName: string;
}>): SessionModelProjectionGroup {
    const base = staleProviderGroup();
    const connectionId = ProviderConnectionIdSchema.parse(input.connectionId);
    const row = base.rows[0]!;
    return {
        ...base,
        connectionId,
        connectionName: input.connectionName,
        rows: [{
            ...row,
            ref: {
                ...row.ref,
                providerConnectionId: connectionId,
                modelId: 'shared-provider-model',
            },
            descriptor: {
                id: 'shared-provider-model',
                name: 'Shared Provider model',
            },
        }],
    };
}

describe('SlimProfileRoutingFields model visibility', () => {
    beforeEach(() => {
        profileEditFormTestState.modalShowSpy.mockReset();
        settingsState = settingsParse({});
        providersFeatureEnabled = true;
        optionPickerOverlayProps = [];
        providerProjectionGroups = [];
        providerCurrentSelectionRecovery = null;
        providerProjectionError = null;
        providerProjectionRefresh.mockClear();
        confirmExperimental.mockClear();
        clearExperimentalFailure.mockClear();
        confirmationHookInputs.length = 0;
    });

    it('renders a hidden current native model as disabled recovery and omits other hidden native models', async () => {
        const models = getAgentStaticModels('claude');
        expect(models.length).toBeGreaterThanOrEqual(3);
        const current = models[0]!;
        const hiddenNonCurrent = models[1]!;
        const visible = models[2]!;
        const entry = claudeEntry();
        const agentTargetKey = resolveProfileBackendTargetKeyForEntry(entry);
        const hiddenCurrentKey = serializeModelVisibilityRefV1({
            scope: 'agent', agentTargetKey, providerConnectionId: null, modelId: current.id,
        });
        const hiddenNonCurrentKey = serializeModelVisibilityRefV1({
            scope: 'agent', agentTargetKey, providerConnectionId: null, modelId: hiddenNonCurrent.id,
        });
        settingsState = settingsParse({
            providerSettingsV1: {
                ...DEFAULT_PROVIDER_SETTINGS_V1,
                modelVisibilityByRef: {
                    [hiddenCurrentKey]: 'hidden',
                    [hiddenNonCurrentKey]: 'hidden',
                },
            },
        });
        const { SlimProfileRoutingFields } = await import('./SlimProfileRoutingFields');
        const screen = await renderScreen(<SlimProfileRoutingFields
            entries={[entry]}
            machineId={null}
            serverId="server-profile"
            defaultPermissionModeByTargetKey={{}}
            defaultPersistenceModeByTargetKey={{}}
            preferredAgentTargetKey={agentTargetKey}
            preferredModelSelection={{
                v: 1,
                updatedAt: 1,
                ref: { agentTargetKey, providerConnectionId: null, modelId: current.id },
            }}
            onPermissionDefaultsChange={vi.fn()}
            onPersistenceDefaultsChange={vi.fn()}
            onPreferredAgentChange={vi.fn()}
            onPreferredModelChange={vi.fn()}
        />);

        const preferredModelRow = screen.findAll((row) => (
            typeof row.props.onPress === 'function'
            && row.props.title === 'profiles.preferredModel.title'
        )).at(-1);
        expect(preferredModelRow).toBeTruthy();
        expect(preferredModelRow?.props.subtitle).toBe(current.name);
        expect(preferredModelRow?.props.detail).toBeUndefined();
        await act(async () => {
            preferredModelRow?.props.onPress?.();
        });

        const modalRequest = profileEditFormTestState.modalShowSpy.mock.calls.at(-1)?.[0] as Readonly<{
            component: React.ComponentType<Record<string, unknown>>;
            props: Record<string, unknown>;
        }>;
        expect(modalRequest).toBeTruthy();
        await renderScreen(React.createElement(modalRequest.component, {
            ...modalRequest.props,
            onClose: vi.fn(),
        }));

        const options = optionPickerOverlayProps.at(-1)?.sections?.flatMap((section) => section.options) ?? [];
        expect(options.find((option) => option.value?.modelId === current.id)).toMatchObject({
            disabled: true,
        });
        expect(options.some((option) => option.value?.modelId === hiddenNonCurrent.id)).toBe(false);
        expect(options.find((option) => option.value?.modelId === visible.id)?.disabled).not.toBe(true);
    });

    it('keeps the exact Provider connection distinguishable in the closed preferred-model summary', async () => {
        const work = sameModelProviderGroup({
            connectionId: 'pc_work',
            connectionName: 'Work',
        });
        const personal = sameModelProviderGroup({
            connectionId: 'pc_personal',
            connectionName: 'Personal',
        });
        providerProjectionGroups = [work, personal];
        const entry = claudeEntry();
        const agentTargetKey = resolveProfileBackendTargetKeyForEntry(entry);
        const selected = personal.rows[0]!.ref;
        const { SlimProfileRoutingFields } = await import('./SlimProfileRoutingFields');
        const screen = await renderScreen(<SlimProfileRoutingFields
            entries={[entry]}
            machineId="machine-profile"
            serverId="server-profile"
            defaultPermissionModeByTargetKey={{}}
            defaultPersistenceModeByTargetKey={{}}
            preferredAgentTargetKey={agentTargetKey}
            preferredModelSelection={{ v: 1, updatedAt: 1, ref: selected }}
            onPermissionDefaultsChange={vi.fn()}
            onPersistenceDefaultsChange={vi.fn()}
            onPreferredAgentChange={vi.fn()}
            onPreferredModelChange={vi.fn()}
        />);

        const preferredModelRow = screen.findAll((row) => (
            typeof row.props.onPress === 'function'
            && row.props.title === 'profiles.preferredModel.title'
        )).at(-1);
        expect(preferredModelRow).toBeTruthy();
        expect(preferredModelRow?.props.subtitle).toBe('Shared Provider model');
        expect(preferredModelRow?.props.detail).toContain('Personal');
        expect(preferredModelRow?.props.detail).not.toContain('Work');
        expect(preferredModelRow?.props.accessibilityLabel).toBe(
            'profiles.preferredModel.title. Gateway, Personal, Shared Provider model',
        );
    });

    it('keeps a missing exact Provider selection truthful in the closed summary', async () => {
        const entry = claudeEntry();
        const agentTargetKey = resolveProfileBackendTargetKeyForEntry(entry);
        const selected = {
            agentTargetKey,
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_deleted'),
            modelId: 'missing-model',
        };
        providerCurrentSelectionRecovery = {
            kind: 'connection_deleted',
            ref: selected,
            error: createProviderErrorV1('provider_connection_not_found', {
                connectionId: selected.providerConnectionId,
                machineId: 'machine-profile',
            }),
            displaySnapshot: {
                providerName: 'Gateway',
                connectionName: 'Retired connection',
                modelName: 'Previous model',
            },
        };
        const { SlimProfileRoutingFields } = await import('./SlimProfileRoutingFields');
        const screen = await renderScreen(<SlimProfileRoutingFields
            entries={[entry]}
            machineId="machine-profile"
            serverId="server-profile"
            defaultPermissionModeByTargetKey={{}}
            defaultPersistenceModeByTargetKey={{}}
            preferredAgentTargetKey={agentTargetKey}
            preferredModelSelection={{ v: 1, updatedAt: 1, ref: selected }}
            onPermissionDefaultsChange={vi.fn()}
            onPersistenceDefaultsChange={vi.fn()}
            onPreferredAgentChange={vi.fn()}
            onPreferredModelChange={vi.fn()}
        />);

        const preferredModelRow = screen.findAll((row) => (
            typeof row.props.onPress === 'function'
            && row.props.title === 'profiles.preferredModel.title'
        )).at(-1);
        expect(preferredModelRow).toBeTruthy();
        expect(preferredModelRow?.props.subtitle).toBe('Previous model');
        expect(preferredModelRow?.props.detail).toBe('settingsProviders.errors.notFoundDescription');
        expect(preferredModelRow?.props.accessibilityLabel).toBe(
            'profiles.preferredModel.title. Gateway, Retired connection, Previous model. settingsProviders.errors.notFoundDescription',
        );
    });

    it('does not expose a retained Provider projection after the target-server feature decision disables Providers', async () => {
        providersFeatureEnabled = false;
        providerProjectionGroups = [staleProviderGroup()];
        const entry = claudeEntry();
        const agentTargetKey = resolveProfileBackendTargetKeyForEntry(entry);
        const { SlimProfileRoutingFields } = await import('./SlimProfileRoutingFields');
        const screen = await renderScreen(<SlimProfileRoutingFields
            entries={[entry]}
            machineId="machine-profile"
            serverId="server-profile"
            defaultPermissionModeByTargetKey={{}}
            defaultPersistenceModeByTargetKey={{}}
            preferredAgentTargetKey={agentTargetKey}
            onPermissionDefaultsChange={vi.fn()}
            onPersistenceDefaultsChange={vi.fn()}
            onPreferredAgentChange={vi.fn()}
            onPreferredModelChange={vi.fn()}
        />);

        const preferredModelRow = screen.findAll((row) => (
            typeof row.props.onPress === 'function'
            && row.props.title === 'profiles.preferredModel.title'
        )).at(-1);
        expect(preferredModelRow).toBeTruthy();
        await act(async () => {
            preferredModelRow?.props.onPress?.();
        });

        const modalRequest = profileEditFormTestState.modalShowSpy.mock.calls.at(-1)?.[0] as Readonly<{
            component: React.ComponentType<Record<string, unknown>>;
            props: Record<string, unknown>;
        }>;
        await renderScreen(React.createElement(modalRequest.component, {
            ...modalRequest.props,
            onClose: vi.fn(),
        }));

        const options = optionPickerOverlayProps.at(-1)?.sections?.flatMap((section) => section.options) ?? [];
        expect(options.some((option) => option.value?.providerConnectionId === 'pc_stale')).toBe(false);
    });

    it('confirms an experimental Provider model in the exact Profile scope before persisting it', async () => {
        providerProjectionGroups = [experimentalProviderGroup()];
        const entry = claudeEntry();
        const agentTargetKey = resolveProfileBackendTargetKeyForEntry(entry);
        const onPreferredModelChange = vi.fn();
        const { SlimProfileRoutingFields } = await import('./SlimProfileRoutingFields');
        const screen = await renderScreen(<SlimProfileRoutingFields
            entries={[entry]}
            machineId="machine-profile"
            serverId="server-profile"
            defaultPermissionModeByTargetKey={{}}
            defaultPersistenceModeByTargetKey={{}}
            preferredAgentTargetKey={agentTargetKey}
            onPermissionDefaultsChange={vi.fn()}
            onPersistenceDefaultsChange={vi.fn()}
            onPreferredAgentChange={vi.fn()}
            onPreferredModelChange={onPreferredModelChange}
        />);

        expect(confirmationHookInputs.at(-1)).toMatchObject({
            enabled: true,
            machineId: 'machine-profile',
            serverId: 'server-profile',
            agentTargetKey,
        });
        const preferredModelRow = screen.findAll((row) => (
            typeof row.props.onPress === 'function'
            && row.props.title === 'profiles.preferredModel.title'
        )).at(-1);
        await act(async () => {
            preferredModelRow?.props.onPress?.();
        });
        const modalRequest = profileEditFormTestState.modalShowSpy.mock.calls.at(-1)?.[0] as Readonly<{
            component: React.ComponentType<Record<string, unknown>>;
            props: Record<string, unknown>;
        }>;
        await renderScreen(React.createElement(modalRequest.component, {
            ...modalRequest.props,
            onClose: vi.fn(),
        }));

        const experimentalRef = experimentalProviderGroup().rows[0]!.ref;
        const experimentalOption = optionPickerOverlayProps.at(-1)?.sections
            ?.flatMap((section) => section.options)
            .find((option) => option.value?.modelId === experimentalRef.modelId);
        expect(experimentalOption?.disabled).not.toBe(true);
        await act(async () => {
            optionPickerOverlayProps.at(-1)?.onSelect(experimentalRef);
            await Promise.resolve();
        });

        expect(confirmExperimental).toHaveBeenCalledWith(expect.objectContaining({
            connectionId: experimentalRef.providerConnectionId,
            expectedConnectionRevision: 7,
            agentTargetKey,
            modelId: experimentalRef.modelId,
        }), expect.any(Function));
        expect(onPreferredModelChange).toHaveBeenCalledWith(expect.objectContaining({
            v: 1,
            ref: experimentalRef,
        }));
    });

    it('renders typed Provider projection recovery and retries through the projection owner', async () => {
        providerProjectionError = createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: 'machine-profile',
        });
        const entry = claudeEntry();
        const { SlimProfileRoutingFields } = await import('./SlimProfileRoutingFields');
        const screen = await renderScreen(<SlimProfileRoutingFields
            entries={[entry]}
            machineId="machine-profile"
            serverId="server-profile"
            defaultPermissionModeByTargetKey={{}}
            defaultPersistenceModeByTargetKey={{}}
            preferredAgentTargetKey={resolveProfileBackendTargetKeyForEntry(entry)}
            onPermissionDefaultsChange={vi.fn()}
            onPersistenceDefaultsChange={vi.fn()}
            onPreferredAgentChange={vi.fn()}
            onPreferredModelChange={vi.fn()}
        />);

        expect(screen.findByTestId('provider-error:provider_endpoint_unavailable')).toBeTruthy();
        expect(screen.findByTestId('provider-error-action:provider_endpoint_unavailable')).toBeTruthy();
        await screen.pressByTestIdAsync('provider-error-action:provider_endpoint_unavailable');
        expect(providerProjectionRefresh).toHaveBeenCalledOnce();
    });
});
