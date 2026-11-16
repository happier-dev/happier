import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit/fixtures/agentCatalogFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';

import { useNewSessionAgentPickerControls as useActualNewSessionAgentPickerControls } from './useNewSessionAgentPickerControls';
import { useNewSessionAgentPickerEngineSelectionState } from './useNewSessionAgentPickerEngineSelectionState';

function useNewSessionAgentPickerControls(params: Omit<Parameters<typeof useActualNewSessionAgentPickerControls >[0], 'engineSelectionState'>
    & Partial<Pick<Parameters<typeof useNewSessionAgentPickerEngineSelectionState>[0], 'modelSelectionIsExplicit'>>) {
    const engineSelectionState = useNewSessionAgentPickerEngineSelectionState({ modelSelectionIsExplicit: true, ...params });
    return useActualNewSessionAgentPickerControls({ ...params, engineSelectionState });
}
import { useNewSessionAgentAuthoringOptionsState } from './useNewSessionAgentAuthoringOptionsState';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { t } from '@/text';
import type { AgentId } from '@/agents/catalog/catalog';
import { FavoriteModelSelectionV1Schema } from '@/sync/domains/models/favoriteModelSelections';
import { SessionModelSelectionV1Schema} from '@happier-dev/protocol/providers/selection/v1';
import { type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';

function favoriteModel(backendTargetKey: string, modelId: string, extra: Record<string, unknown> = {}) {
    return FavoriteModelSelectionV1Schema.parse({ backendTargetKey, modelId, ...extra });
}

const modalMockState = vi.hoisted(() => ({
    alert: vi.fn(),
}));

// Hoist the shared translation boundary before fixtures can import the runtime text module.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

installNewSessionScreenModelCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock();
        modalMock.spies.alert.mockImplementation((...args: unknown[]) => modalMockState.alert(...args));
        return modalMock.module;
    },
});

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/agents/registry/registryUi', () => ({
    getAgentPickerIconScale: () => 1,
}));

vi.mock('@/components/sessions/new/components/NewSessionEngineOptionDetail', () => ({
    NewSessionEngineOptionDetail: (props: Record<string, unknown>) => React.createElement('NewSessionEngineOptionDetail', props),
}));

vi.mock('@/components/sessions/new/components/NewSessionFavoriteModelsDetail', () => ({
    NewSessionFavoriteModelsDetail: (props: Record<string, unknown>) => React.createElement('NewSessionFavoriteModelsDetail', props),
}));

function createBuiltInBackendEntry(backendId: 'claude' | 'codex', title: string, subtitle: string | null): ResolvedBackendCatalogEntry {
    const backendTarget = { kind: 'backend' as const, backendId };
    return {
        agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: backendId }),
        backendTarget,
        backendTargetKey: formatBackendTargetKeyV2(backendTarget),
        kind: 'builtInAgent',
        backendId,
        agentId: backendId,
        catalogAgentId: backendId as any,
        builtInAgentId: backendId as any,
        iconAgentId: backendId as any,
        title,
        subtitle,
        cliAuthBackgroundCheckSafe: false,
    };
}

function createConfiguredBackendEntry(
    backendId: string,
    title: string,
    subtitle: string | null,
    capabilities?: ResolvedBackendCatalogEntry['capabilities'],
): ResolvedBackendCatalogEntry {
    const backendTarget = { kind: 'backend' as const, backendId, configuredBackendId: backendId };
    return {
        agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: backendId }),
        backendTarget,
        backendTargetKey: formatBackendTargetKeyV2(backendTarget),
        kind: 'configuredBackend',
        backendId,
        agentId: backendId,
        catalogAgentId: null,
        builtInAgentId: null,
        iconAgentId: null,
        capabilities,
        title,
        subtitle,
        cliAuthBackgroundCheckSafe: false,
    };
}

function createPluginBackendEntry(
    backendId: string,
    catalogAgentId: AgentId,
    title: string,
    subtitle: string | null,
): ResolvedBackendCatalogEntry {
    const backendTarget = { kind: 'backend' as const, backendId };
    return {
        agentCatalogEntry: createResolvedAgentCatalogEntryFixture({ agentId: catalogAgentId }),
        backendTarget,
        backendTargetKey: formatBackendTargetKeyV2(backendTarget),
        kind: 'pluginBackend',
        backendId,
        agentId: catalogAgentId,
        catalogAgentId,
        builtInAgentId: null,
        iconAgentId: catalogAgentId,
        title,
        subtitle,
        cliAuthBackgroundCheckSafe: false,
    };
}

describe('useNewSessionAgentPickerControls', () => {
    it.each(['use', 'manage'] as const)('offers composer installs only with Manage access, starting at %s', async (initialRole) => {
        const previous = storage.getState();
        const entry = createBuiltInBackendEntry('claude', 'Claude', null);
        const facts = MachineAgentInventoryItemSchema.parse({
            agentId: 'claude', title: 'Claude', installed: false, version: null, latestVersion: null,
            update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'login_terminal' },
            platform: { supported: true }, install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        });
        const agent = projectMachineAgent({ agentId: 'claude', title: 'Claude', facts, checking: false,
            stale: false, connectedServices: [], job: null, installedCheckedAt: 1 });
        const publish = (role: 'use' | 'manage' | null) => {
            const machine = role ? createMachineFixture({ id: 'shared-machine', isShared: true,
                access: { role, resourceMode: 'plain', accessState: 'ready', custodian: { accountId: 'owner', displayName: 'Owner' } } }) : null;
            storage.setState({
                machineListByServerId: { 'server-1': machine ? [machine] : [] },
                machineRecordsByServerId: { 'server-1': machine ? { [machine.id]: machine } : {} },
            });
        };
        publish(initialRole);
        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false, projectionCurrent: true, selectedProfileId: null, profileMap: new Map(),
            resolvedBackendEntries: [entry, createBuiltInBackendEntry('codex', 'Codex', null)], getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => false, selectedBackendEntry: entry,
            selectedBackendTargetKey: entry.backendTargetKey, setBackendTarget: vi.fn(),
            modelMode: 'default', setModelMode: vi.fn(), acpSessionModeId: null, setAcpSessionModeId: vi.fn(),
            sessionConfigOptionOverrides: null, setSessionConfigOptionOverrides: vi.fn(),
            selectedMachineId: 'shared-machine', capabilityServerId: 'server-1', selectedPath: '/repo',
            getBackendEntryMachineAgent: () => agent, machineAgentsStatus: 'ready',
        }));
        try {
            const option = () => hook.getCurrent().agentPickerOptions?.find(value => value.id === entry.backendTargetKey);
            expect(option()).toBeDefined();
            expect(Boolean(option()?.statusAction)).toBe(initialRole === 'manage');
            for (const role of ['manage', 'use', null] as const) {
                await act(async () => publish(role));
                expect(Boolean(option()?.statusAction)).toBe(role === 'manage');
            }
        } finally {
            await hook.unmount();
            storage.setState({ machineListByServerId: previous.machineListByServerId,
                machineRecordsByServerId: previous.machineRecordsByServerId });
        }
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('retains local picker intent across Account echoes and subscribes mounted details to their Agent keys', async () => {
        const previous = storage.getState().settings;
        storage.setState({ settings: { ...settingsDefaults, experiments: false } });
        const claude = createBuiltInBackendEntry('claude', 'Claude', null);
        const codex = createBuiltInBackendEntry('codex', 'Codex', null);
        let commits = 0;
        const hook = await renderHook(() => {
            React.useLayoutEffect(() => { commits++; });
            const [backendTarget, setBackendTarget] = React.useState<PersistedBackendTargetRefV2>(claude.backendTarget);
            const selectedEntry = formatBackendTargetKeyV2(backendTarget) === codex.backendTargetKey ? codex : claude;
            return useNewSessionAgentPickerControls({
                useProfiles: false, projectionCurrent: true, selectedProfileId: null, profileMap: new Map(),
                resolvedBackendEntries: [claude, codex], getCompatibleProfileBackendEntries: () => [],
                isBackendEntrySelectable: () => true, selectedBackendEntry: selectedEntry,
                selectedBackendTargetKey: selectedEntry.backendTargetKey, setBackendTarget,
                modelMode: 'default', setModelMode: vi.fn(), acpSessionModeId: null, setAcpSessionModeId: vi.fn(),
                sessionConfigOptionOverrides: null, setSessionConfigOptionOverrides: vi.fn(),
                selectedMachineId: null, capabilityServerId: 'server-1', selectedPath: '/repo',
                initialAgentPickerView: { kind: 'favoriteModels' },
                favoriteModelSelections: [favoriteModel(codex.backendTargetKey, 'gpt-5.4', { builtInAgentId: 'codex' })],
                setFavoriteModelSelections: vi.fn(),
            });
        });
        let detail: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            expect(hook.getCurrent().agentPickerSelectedOptionId).toBe('favorite-models');
            await act(async () => hook.getCurrent().handleAgentPickerSelect(codex.backendTargetKey));
            const before = commits;
            await act(async () => storage.setState({ settings: { ...storage.getState().settings, experiments: true } }));
            expect(commits).toBe(before);
            expect(hook.getCurrent().agentPickerSelectedOptionId).toBe(codex.backendTargetKey);
            const renderDetail = hook.getCurrent().agentPickerOptions?.find(option => option.id === 'favorite-models')?.renderDetailContent;
            if (!renderDetail) throw new Error('Missing favorite detail');
            detail = await renderScreen(<>{renderDetail({ onRequestClose: vi.fn() })}</>);
            const selectedSettings = detail.tree.root.findByType('NewSessionFavoriteModelsDetail').props.settings;
            expect(selectedSettings).toEqual({ codexBackendMode: undefined });
            const openedAt = commits;
            await act(async () => storage.setState({ settings: { ...storage.getState().settings, experiments: false } }));
            expect(detail.tree.root.findByType('NewSessionFavoriteModelsDetail').props.settings).toBe(selectedSettings);
            await act(async () => storage.setState({ settings: settingsParse({ ...storage.getState().settings, codexBackendMode: 'acp' }) }));
            expect(detail.tree.root.findByType('NewSessionFavoriteModelsDetail').props.settings).toEqual({ codexBackendMode: 'acp' });
            expect(commits).toBe(openedAt);
        } finally {
            await detail?.unmount(); await hook.unmount(); storage.setState({ settings: previous });
        }
    });

    it('keeps all backend options visible, suppresses redundant compatible subtitles, and disables entries that are incompatible with the selected profile', async () => {
        const setBackendTarget = vi.fn();
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', 'Claude');
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', 'Codex');

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: true,
            projectionCurrent: true,
            selectedProfileId: 'profile-1',
            profileMap: new Map([[
                'profile-1',
                { id: 'profile-1', name: 'Profile 1' } as any,
            ]]),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => ([claudeEntry]),
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget,
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
        }));

        expect(modalMockState.alert).not.toHaveBeenCalled();
        expect(setBackendTarget).not.toHaveBeenCalled();
        expect(hook.getCurrent().agentPickerOptions?.map((option) => ({
            id: option.id,
            disabled: option.disabled ?? false,
            muted: (option as any).muted ?? false,
            deferRenderDetailContent: option.deferRenderDetailContent ?? false,
            subtitle: option.subtitle ?? null,
        }))).toEqual([
            { id: claudeEntry.backendTargetKey, disabled: false, muted: false, deferRenderDetailContent: true, subtitle: null },
            { id: codexEntry.backendTargetKey, disabled: true, muted: true, deferRenderDetailContent: true, subtitle: t('newSession.aiBackendNotCompatibleWithSelectedProfile') },
        ]);
    });

    it('orders favorite engines first and exposes row toggle actions without selecting the engine', async () => {
        const setFavoriteBackendTargetKeys = vi.fn();
        const setBackendTarget = vi.fn();
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget,
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            favoriteBackendTargetKeys: [codexEntry.backendTargetKey],
            setFavoriteBackendTargetKeys,
        }));

        expect(hook.getCurrent().agentPickerOptions?.map((option) => option.id)).toEqual([
            codexEntry.backendTargetKey,
            claudeEntry.backendTargetKey,
        ]);

        const claudeOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === claudeEntry.backendTargetKey);
        const claudeAction = (claudeOption as { railAction?: { selected: boolean; onPress: () => void } } | undefined)?.railAction;
        expect(claudeAction?.selected).toBe(false);

        claudeAction?.onPress();

        expect(setFavoriteBackendTargetKeys).toHaveBeenCalledWith([codexEntry.backendTargetKey, claudeEntry.backendTargetKey]);
        expect(setBackendTarget).not.toHaveBeenCalled();

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === codexEntry.backendTargetKey);
        const codexAction = (codexOption as { railAction?: { selected: boolean; onPress: () => void } } | undefined)?.railAction;
        expect(codexAction?.selected).toBe(true);

        codexAction?.onPress();

        expect(setFavoriteBackendTargetKeys).toHaveBeenLastCalledWith([]);
    });

    it('remembers the favorites rail as the focused picker view independently from the selected engine', async () => {
        const onRememberAgentPickerView = vi.fn();
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget: vi.fn(),
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            favoriteModelSelections: [
                favoriteModel(codexEntry.backendTargetKey, 'gpt-5.4', { builtInAgentId: 'codex' }),
            ],
            setFavoriteModelSelections: vi.fn(),
            initialAgentPickerView: { kind: 'favoriteModels' },
            onRememberAgentPickerView,
        }));

        expect(hook.getCurrent().agentPickerSelectedOptionId).toBe('favorite-models');

        const favoriteOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'favorite-models');
        favoriteOption?.onSelectImmediate?.();

        expect(onRememberAgentPickerView).toHaveBeenCalledWith({ kind: 'favoriteModels' });

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === codexEntry.backendTargetKey);
        codexOption?.onSelectImmediate?.();

        expect(onRememberAgentPickerView).toHaveBeenLastCalledWith({
            kind: 'backend',
            backendTargetKey: codexEntry.backendTargetKey,
        });
    });

    it('adds a favorites rail option when favorite model selections exist', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget: vi.fn(),
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            favoriteModelSelections: [
                favoriteModel(codexEntry.backendTargetKey, 'gpt-5.4', { builtInAgentId: 'codex' }),
            ],
            setFavoriteModelSelections: vi.fn(),
        }));

        expect(hook.getCurrent().agentPickerOptions?.map((option) => option.id)).toEqual([
            'favorite-models',
            claudeEntry.backendTargetKey,
            codexEntry.backendTargetKey,
        ]);
        expect(hook.getCurrent().agentPickerOptions?.[0]?.label).toBe(t('profiles.groups.favorites'));
        expect(hook.getCurrent().agentPickerOptions?.[0]?.closeOnSelectImmediate).toBe(false);
        expect(hook.getCurrent().agentPickerOptions?.[0]?.deferRenderDetailContent).toBe(true);
        expect(hook.getCurrent().agentPickerOptions?.[0]?.deferredDetailContentCacheKey).toBe('new-session-favorite-models:server-1:machine-1:/repo');
    });

    it('keeps a favorite model selection when the backend tab becomes focused before external model state catches up', async () => {
        const setBackendTarget = vi.fn();
        const setModelMode = vi.fn();
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);
        const initialParams: Parameters<typeof useNewSessionAgentPickerControls>[0] = {
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget,
            modelMode: 'default',
            setModelMode: setModelMode as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            favoriteModelSelections: [
                favoriteModel(codexEntry.backendTargetKey, 'gpt-5.5', {
                    catalogAgentId: 'codex',
                    builtInAgentId: 'codex',
                    modelLabel: 'GPT 5.5',
                }),
            ],
            setFavoriteModelSelections: vi.fn(),
        };
        const hook = await renderHook((props: Parameters<typeof useNewSessionAgentPickerControls>[0]) => (
            useNewSessionAgentPickerControls(props)
        ), { initialProps: initialParams });
        const onRequestClose = vi.fn();

        const favoriteDetail = hook.getCurrent().agentPickerOptions?.[0]?.renderDetailContent?.({ onRequestClose }) as React.ReactElement<{
            onSelectFavoriteModel?: (entry: ResolvedBackendCatalogEntry, modelSelection: ReturnType<typeof favoriteModel>['selection'], configOverrides?: Readonly<Record<string, string>>) => void;
        }> | undefined;

        favoriteDetail?.props?.onSelectFavoriteModel?.(
            codexEntry,
            initialParams.favoriteModelSelections![0]!.selection,
            { reasoning_effort: 'high' },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(setBackendTarget).toHaveBeenCalledWith(codexEntry.backendTarget);
        expect(setModelMode).toHaveBeenCalledWith('gpt-5.5');
        expect(onRequestClose).toHaveBeenCalledTimes(1);
        expect(initialParams.setSessionConfigOptionOverrides).toHaveBeenCalledWith(expect.objectContaining({
            overrides: {
                reasoning_effort: {
                    updatedAt: expect.any(Number),
                    value: 'high',
                },
            },
        }));

        await hook.rerender({
            ...initialParams,
            selectedBackendEntry: codexEntry,
            selectedBackendTargetKey: codexEntry.backendTargetKey,
            modelMode: 'default',
        });

        const codexDetail = hook.getCurrent().agentPickerOptions?.find((option) => option.id === codexEntry.backendTargetKey)
            ?.renderDetailContent?.({ onRequestClose: vi.fn() }) as React.ReactElement<{ selectedModelId?: string }> | undefined;

        const detailScreen = await renderScreen(<>{codexDetail}</>);
        expect(detailScreen.tree.root.findByType('NewSessionEngineOptionDetail').props.selectedModelId).toBe('gpt-5.5');
        await detailScreen.unmount();
    });

    it('selects a favorite with its exact provider connection identity', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);
        const providerSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 123,
            ref: {
                agentTargetKey: codexEntry.backendTargetKey,
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'shared-id',
            },
        });
        const setEngineSelectionForBackendTarget = vi.fn();
        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget: vi.fn(),
            modelMode: 'default',
            modelSelection: null,
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            setEngineSelectionForBackendTarget,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            favoriteModelSelections: [{ selection: providerSelection }],
            setFavoriteModelSelections: vi.fn(),
        }));

        const favoriteDetail = hook.getCurrent().agentPickerOptions?.[0]?.renderDetailContent?.({ onRequestClose: vi.fn() }) as React.ReactElement<{
            onSelectFavoriteModel?: (
                entry: ResolvedBackendCatalogEntry,
                selection: typeof providerSelection,
                configOverrides?: Readonly<Record<string, string>>,
            ) => void;
        }> | undefined;
        favoriteDetail?.props.onSelectFavoriteModel?.(codexEntry, providerSelection, { reasoning_effort: 'high' });

        expect(setEngineSelectionForBackendTarget).toHaveBeenCalledWith(
            codexEntry.backendTargetKey,
            expect.objectContaining({ modelSelection: providerSelection }),
        );
    });

    it.each(['model', 'control'] as const)('retires Team source before publishing an explicit favorite %s choice', async (choice) => {
        const codex = createBuiltInBackendEntry('codex', 'Codex', null);
        const claude = createBuiltInBackendEntry('claude', 'Claude', null);
        const nativeSelection = SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1,
            ref: { agentTargetKey: codex.backendTargetKey, providerConnectionId: null, modelId: 'shared-id' } });
        const teamSelection = { kind: 'team_credential_provider_model' as const, teamId: 'team-a', resourceId: 'resource-a',
            expectedResourceRevision: 1, deliveryMode: 'brokered' as const, agentTargetKey: codex.backendTargetKey, modelId: 'shared-id' };
        const hook = await renderHook(() => {
            const [selectedTeam, setSelectedTeam] = React.useState<typeof teamSelection | null>(teamSelection);
            const source = React.useRef(selectedTeam);
            source.current = selectedTeam;
            const [remembered, setRemembered] = React.useState<typeof nativeSelection | null>(null);
            const [backendTarget, setBackendTarget] = React.useState<PersistedBackendTargetRefV2>(codex.backendTarget);
            const authoring = useNewSessionAgentAuthoringOptionsState({ agentType: 'codex', backendTargetKey: codex.backendTargetKey,
                hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: null,
                implicitProfileModelSelection: nativeSelection });
            const picker = useNewSessionAgentPickerControls({
                useProfiles: false, projectionCurrent: true, selectedProfileId: null, profileMap: new Map(),
                resolvedBackendEntries: [codex, claude], getCompatibleProfileBackendEntries: () => [],
                isBackendEntrySelectable: () => true, selectedBackendEntry: codex,
                selectedBackendTargetKey: formatBackendTargetKeyV2(backendTarget), setBackendTarget,
                modelMode: authoring.modelMode, modelSelection: authoring.modelSelection,
                modelSelectionIsExplicit: authoring.modelSelectionForPersistence !== undefined,
                setModelMode: authoring.setModelMode, acpSessionModeId: authoring.acpSessionModeId,
                setAcpSessionModeId: authoring.setAcpSessionModeId,
                sessionConfigOptionOverrides: authoring.sessionConfigOptionOverrides,
                setSessionConfigOptionOverrides: authoring.setSessionConfigOptionOverrides,
                setEngineSelectionForBackendTarget: authoring.setEngineSelectionForBackendTarget,
                canRetainModelSelection: () => source.current === null,
                onRememberEngineSelection: (_target, selection) => setRemembered(selection.modelSelection),
                selectedMachineId: 'machine-1', capabilityServerId: 'server-1', selectedPath: '/repo',
                favoriteModelSelections: [{ selection: nativeSelection }],
                teamModels: { selectedTeamCredentialModel: selectedTeam, onSelectOtherModel: () => {
                    source.current = null;
                    setSelectedTeam(null);
                } },
            });
            return { picker, authoring, selectedTeam, remembered };
        });
        try {
            const detail = hook.getCurrent().picker.agentPickerOptions?.find(option => option.id === 'favorite-models')
                ?.renderDetailContent?.({ onRequestClose: () => {} });
            type FavoriteDetailProps = React.ComponentProps<typeof import('@/components/sessions/new/components/NewSessionFavoriteModelsDetail').NewSessionFavoriteModelsDetail>;
            if (!React.isValidElement<FavoriteDetailProps>(detail)) throw new Error('Missing favorite detail');
            await act(async () => {
                if (choice === 'model') detail.props.onSelectFavoriteModel(codex, nativeSelection);
                else detail.props.onSelectFavoriteModelOptionValue?.(codex, nativeSelection, 'reasoning_effort', 'low');
            });
            expect(hook.getCurrent().selectedTeam).toBeNull();
            expect(hook.getCurrent().authoring.modelSelection?.ref).toEqual(nativeSelection.ref);
            expect(hook.getCurrent().remembered?.ref).toEqual(nativeSelection.ref);
            if (choice === 'control') expect(hook.getCurrent().authoring.sessionConfigOptionOverrides?.overrides.reasoning_effort?.value).toBe('low');
        } finally { await hook.unmount(); }
    });

    it('does not expose favorite model selections for backends incompatible with the selected profile', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: true,
            projectionCurrent: true,
            selectedProfileId: 'profile-1',
            profileMap: new Map([[
                'profile-1',
                { id: 'profile-1', name: 'Profile 1' } as any,
            ]]),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => ([claudeEntry]),
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget: vi.fn(),
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            favoriteModelSelections: [
                favoriteModel(codexEntry.backendTargetKey, 'gpt-5.4', {
                    catalogAgentId: 'codex',
                    builtInAgentId: 'codex',
                }),
            ],
            setFavoriteModelSelections: vi.fn(),
        }));

        expect(hook.getCurrent().agentPickerOptions?.map((option) => option.id)).toEqual([
            claudeEntry.backendTargetKey,
            codexEntry.backendTargetKey,
        ]);
    });

    it('disables unavailable backend rows with a visible reason and blocks selection', async () => {
        const setBackendTarget = vi.fn();
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: (entry) => entry.backendTargetKey !== codexEntry.backendTargetKey,
            getBackendEntryUnavailabilityReason: (entry) => (
                entry.backendTargetKey === codexEntry.backendTargetKey ? 'cli-not-detected:codex' : null
            ),
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget,
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
        }));

        const options = hook.getCurrent().agentPickerOptions ?? [];
        expect(options.map((option) => ({
            id: option.id,
            disabled: option.disabled ?? false,
            muted: (option as any).muted ?? false,
            subtitle: option.subtitle ?? null,
        }))).toEqual([
            { id: claudeEntry.backendTargetKey, disabled: false, muted: false, subtitle: null },
            {
                id: codexEntry.backendTargetKey,
                disabled: true,
                muted: true,
                subtitle: t('newSession.aiBackendCliNotDetectedOnMachine', { cli: resolveAgentCatalogTitle('codex') }),
            },
        ]);

        hook.getCurrent().handleAgentPickerSelect(codexEntry.backendTargetKey);
        expect(setBackendTarget).not.toHaveBeenCalled();
    });

    it('does not expose entries that explicitly do not support sessions in the new session picker', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const reviewOnlyEntry = createConfiguredBackendEntry(
            'review-only',
            'Review Only',
            'Code review runtime',
            {
                executionRun: { supported: true },
                session: { supported: false },
            },
        );

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, reviewOnlyEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: (entry) => entry.capabilities?.session?.supported !== false,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget: vi.fn(),
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
        }));

        expect(hook.getCurrent().agentPickerOptions?.map((option) => option.id) ?? []).not.toContain(
            reviewOnlyEntry.backendTargetKey,
        );
    });

    it('exposes a configured ACP backend even when it is the only resolved backend entry', async () => {
        const setBackendTarget = vi.fn();
        const configuredEntry = createConfiguredBackendEntry('review-bot', 'Review Bot', 'review-bot');

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [configuredEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: configuredEntry,
            selectedBackendTargetKey: configuredEntry.backendTargetKey,
            setBackendTarget,
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
        }));

        expect(hook.getCurrent().agentPickerOptions?.map((option) => option.id)).toEqual([configuredEntry.backendTargetKey]);
        hook.getCurrent().handleAgentPickerSelect(configuredEntry.backendTargetKey);
        expect(setBackendTarget).toHaveBeenCalledWith(configuredEntry.backendTarget);
    });

    it('passes plugin backend provider identity to engine detail probes', async () => {
        const antigravityEntry = createPluginBackendEntry(
            'antigravity-localharness',
            'antigravity',
            'Antigravity',
            null,
        );

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [antigravityEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: antigravityEntry,
            selectedBackendTargetKey: antigravityEntry.backendTargetKey,
            setBackendTarget: vi.fn(),
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
        }));

        const detailElement = hook.getCurrent().agentPickerOptions?.[0]
            ?.renderDetailContent?.({ onRequestClose: vi.fn() }) as React.ReactElement<{ runtimeCarrierAgentId?: string | null }> | undefined;

        expect(detailElement?.props.runtimeCarrierAgentId).toBe('antigravity');
    });

    it('uses the single selectable backend when clicking the agent input', async () => {
        const setBackendTarget = vi.fn();
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: (entry) => entry.backendTargetKey === codexEntry.backendTargetKey,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget,
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
        }));

        hook.getCurrent().handleAgentClick();

        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'backend', backendId: 'codex' });
    });

    it('ignores a stale remembered backend view when the selected backend changes externally', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: codexEntry,
            selectedBackendTargetKey: codexEntry.backendTargetKey,
            setBackendTarget: vi.fn(),
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            initialAgentPickerView: {
                kind: 'backend', backendTargetKey: claudeEntry.backendTargetKey,
            },
        }));

        expect(hook.getCurrent().agentPickerSelectedOptionId).toBe(codexEntry.backendTargetKey);
    });

    it('publishes engine detail selection changes immediately for the focused backend option', async () => {
        const setBackendTarget = vi.fn();
        const setModelMode = vi.fn();
        const setAcpSessionModeId = vi.fn();
        const setSessionConfigOptionOverrides = vi.fn();
        const onRememberEngineSelection = vi.fn();
        const refreshProbe = { phase: 'idle' as const, onRefresh: vi.fn() };
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget,
            modelMode: 'default',
            setModelMode: setModelMode as any,
            acpSessionModeId: null,
            setAcpSessionModeId: setAcpSessionModeId as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: setSessionConfigOptionOverrides as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
            refreshProbe,
            onRememberEngineSelection,
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === codexEntry.backendTargetKey);
        const detailElement = codexOption?.renderDetailContent?.({ onRequestClose: vi.fn() }) as React.ReactElement<{
            onSelectionChange?: (selection: {
                modelId: string;
                sessionModeId: string;
                configOverrides: Readonly<Record<string, string>>;
            }) => void;
        }> | undefined;

        expect(detailElement?.props?.onSelectionChange).toBeTypeOf('function');
        expect((detailElement?.props as any)?.refreshProbe).toEqual(refreshProbe);

        detailElement?.props?.onSelectionChange?.({
            modelId: 'gpt-5.4',
            sessionModeId: 'plan',
            configOverrides: { reasoning_effort: 'high', speed: 'fast' },
        });

        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'backend', backendId: 'codex' });
        expect(setModelMode).toHaveBeenCalledWith('gpt-5.4');
        expect(setAcpSessionModeId).toHaveBeenCalledWith('plan');
        expect(setSessionConfigOptionOverrides).toHaveBeenCalledWith(expect.objectContaining({
            overrides: {
                reasoning_effort: {
                    updatedAt: expect.any(Number),
                    value: 'high',
                },
                speed: {
                    updatedAt: expect.any(Number),
                    value: 'fast',
                },
            },
        }));
        expect(onRememberEngineSelection).toHaveBeenCalledWith(codexEntry.backendTarget, {
            modelSelection: {
                v: 1,
                updatedAt: expect.any(Number),
                ref: {
                    agentTargetKey: codexEntry.backendTargetKey,
                    providerConnectionId: null,
                    modelId: 'gpt-5.4',
                },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: expect.objectContaining({
                overrides: {
                    reasoning_effort: {
                        updatedAt: expect.any(Number),
                        value: 'high',
                    },
                    speed: {
                        updatedAt: expect.any(Number),
                        value: 'fast',
                    },
                },
            }),
        });
    });

    it('marks engine rail selections as immediate updates that keep the popover open', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);
        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget: vi.fn(),
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === codexEntry.backendTargetKey);

        expect(codexOption?.onSelectImmediate).toBeTypeOf('function');
        expect(codexOption?.closeOnSelectImmediate).toBe(false);
    });

    it('does not expose an explicit apply action for detailed engine options', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);
        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget: vi.fn(),
            modelMode: 'default',
            setModelMode: vi.fn() as any,
            acpSessionModeId: null,
            setAcpSessionModeId: vi.fn() as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: vi.fn() as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === codexEntry.backendTargetKey);

        expect(codexOption?.renderDetailContent).toBeTypeOf('function');
        expect(codexOption?.deferRenderDetailContent).toBe(true);
        expect(codexOption?.deferredDetailContentCacheKey).toBe(`new-session-engine:server-1:machine-1:${codexEntry.backendTargetKey}:/repo`);
        expect(codexOption?.onApply).toBeUndefined();
    });

    it('restores the cached per-backend engine selection when a backend is reselected', async () => {
        const setBackendTarget = vi.fn();
        const setModelMode = vi.fn();
        const setAcpSessionModeId = vi.fn();
        const setSessionConfigOptionOverrides = vi.fn();
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            projectionCurrent: true,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [claudeEntry, codexEntry],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: claudeEntry,
            selectedBackendTargetKey: claudeEntry.backendTargetKey,
            setBackendTarget,
            modelMode: 'default',
            setModelMode: setModelMode as any,
            acpSessionModeId: null,
            setAcpSessionModeId: setAcpSessionModeId as any,
            sessionConfigOptionOverrides: null,
            setSessionConfigOptionOverrides: setSessionConfigOptionOverrides as any,
            selectedMachineId: 'machine-1',
            capabilityServerId: 'server-1',
            selectedPath: '/repo',
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === codexEntry.backendTargetKey);
        const detailElement = codexOption?.renderDetailContent?.({ onRequestClose: vi.fn() }) as React.ReactElement<{
            onSelectionChange?: (selection: {
                modelId: string;
                sessionModeId: string;
                configOverrides: Readonly<Record<string, string>>;
            }) => void;
        }> | undefined;

        detailElement?.props?.onSelectionChange?.({
            modelId: 'gpt-5.4',
            sessionModeId: 'plan',
            configOverrides: { reasoning_effort: 'high' },
        });

        vi.clearAllMocks();

        hook.getCurrent().handleAgentPickerSelect(codexEntry.backendTargetKey);

        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'backend', backendId: 'codex' });
        expect(setModelMode).toHaveBeenCalledWith('gpt-5.4');
        expect(setAcpSessionModeId).toHaveBeenCalledWith('plan');
        expect(setSessionConfigOptionOverrides).toHaveBeenCalledWith(expect.objectContaining({
            overrides: {
                reasoning_effort: {
                    updatedAt: expect.any(Number),
                    value: 'high',
                },
            },
        }));
    });

    it.each([
        { late: false, rail: false }, { late: true, rail: false },
        { late: false, rail: true }, { late: true, rail: true },
    ])('keeps a destination Agent model inherited with late Team context=$late and rail=$rail until a model is chosen', async ({ late, rail }) => {
        const claude = createBuiltInBackendEntry('claude', 'Claude', null);
        const codex = createBuiltInBackendEntry('codex', 'Codex', null);
        const selection = { v: 2 as const, updatedAt: 1, ref: {
            source: 'team_resource' as const, teamId: 'team-a', resourceId: 'resource-a',
            expectedResourceRevision: 0, deliveryMode: 'brokered' as const,
            agentTargetKey: codex.backendTargetKey, modelId: 'gpt-6.1-sol',
        } };
        const hook = await renderHook(({ configured }) => {
            const [target, setBackendTarget] = React.useState<PersistedBackendTargetRefV2>(claude.backendTarget);
            const entry = formatBackendTargetKeyV2(target) === codex.backendTargetKey ? codex : claude;
            const authoring = useNewSessionAgentAuthoringOptionsState({
                agentType: entry.catalogAgentId, backendTargetKey: entry.backendTargetKey,
                hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: null,
                managedDefaults: configured ? { teamDefaults: { team: { modelByAgentTargetKey: {
                    [codex.backendTargetKey]: selection,
                } }, groups: {} } } : undefined,
            });
            const picker = useNewSessionAgentPickerControls({
                useProfiles: false, projectionCurrent: true, selectedProfileId: null, profileMap: new Map(),
                resolvedBackendEntries: [claude, codex], getCompatibleProfileBackendEntries: () => [],
                isBackendEntrySelectable: () => true, selectedBackendEntry: entry,
                selectedBackendTargetKey: entry.backendTargetKey, setBackendTarget,
                modelMode: authoring.modelMode, modelSelection: authoring.modelSelection,
                setModelMode: authoring.setModelMode, acpSessionModeId: authoring.acpSessionModeId,
                setAcpSessionModeId: authoring.setAcpSessionModeId,
                sessionConfigOptionOverrides: authoring.sessionConfigOptionOverrides,
                setSessionConfigOptionOverrides: authoring.setSessionConfigOptionOverrides,
                setEngineSelectionForBackendTarget: authoring.setEngineSelectionForBackendTarget,
                selectedMachineId: 'machine-1', capabilityServerId: 'server-1', selectedPath: '/repo',
            });
            return { authoring, picker };
        }, { initialProps: { configured: !late } });
        try {
            const select = (key: string) => {
                if (rail) hook.getCurrent().picker.agentPickerOptions?.find(option => option.id === key)?.onSelectImmediate?.();
                else hook.getCurrent().picker.handleAgentPickerSelect(key);
            };
            await act(async () => select(codex.backendTargetKey));
            if (late) await hook.rerender({ configured: true });
            expect(hook.getCurrent().authoring.modelMode).toBe('gpt-6.1-sol');
            expect(hook.getCurrent().authoring.modelSelectionV2).toEqual(selection);
            expect(hook.getCurrent().authoring.modelSelectionForPersistence).toBeUndefined();
            await act(async () => hook.getCurrent().authoring.setModelMode('default'));
            expect(hook.getCurrent().authoring.modelMode).toBe('default');
            expect(hook.getCurrent().authoring.modelSelectionForPersistence).toBeNull();
            await act(async () => select(claude.backendTargetKey));
            await act(async () => select(codex.backendTargetKey));
            expect(hook.getCurrent().authoring.modelMode).toBe('default');
            expect(hook.getCurrent().authoring.modelSelectionForPersistence).toBeNull();
        } finally { await hook.unmount(); }
    });

    it('propagates destination backend detail selections through target-scoped authoring state', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        function useHarness() {
            const [backendTarget, setBackendTarget] = React.useState<PersistedBackendTargetRefV2>(
                () => claudeEntry.backendTarget,
            );
            const selectedEntry = formatBackendTargetKeyV2(backendTarget) === codexEntry.backendTargetKey
                ? codexEntry
                : claudeEntry;
            const authoring = useNewSessionAgentAuthoringOptionsState({
                agentType: selectedEntry.catalogAgentId as AgentId,
                backendTargetKey: selectedEntry.backendTargetKey,
                allowTargetlessDraftEngineSelection: false,
                hydratedTempAuthoringDraft: null,
                hydratedPersistedAuthoringDraft: null,
                rememberedEngineSelection: null,
            });
            const picker = useNewSessionAgentPickerControls({
                useProfiles: false,
                projectionCurrent: true,
                selectedProfileId: null,
                profileMap: new Map(),
                resolvedBackendEntries: [claudeEntry, codexEntry],
                getCompatibleProfileBackendEntries: () => [],
                isBackendEntrySelectable: () => true,
                selectedBackendEntry: selectedEntry,
                selectedBackendTargetKey: selectedEntry.backendTargetKey,
                setBackendTarget,
                modelMode: authoring.modelMode,
                setModelMode: authoring.setModelMode,
                acpSessionModeId: authoring.acpSessionModeId,
                setAcpSessionModeId: authoring.setAcpSessionModeId,
                sessionConfigOptionOverrides: authoring.sessionConfigOptionOverrides,
                setSessionConfigOptionOverrides: authoring.setSessionConfigOptionOverrides,
                setEngineSelectionForBackendTarget: authoring.setEngineSelectionForBackendTarget,
                selectedMachineId: 'machine-1',
                capabilityServerId: 'server-1',
                selectedPath: '/repo',
                });

            return {
                selectedEntry,
                authoring,
                picker,
            };
        }

        const hook = await renderHook(() => useHarness());

        expect(hook.getCurrent().selectedEntry.backendTargetKey).toBe(claudeEntry.backendTargetKey);
        expect(hook.getCurrent().authoring.modelMode).toBe('default');
        expect(hook.getCurrent().authoring.acpSessionModeId).toBeNull();

        const codexDetail = hook.getCurrent().picker.agentPickerOptions
            ?.find((option) => option.id === codexEntry.backendTargetKey)
            ?.renderDetailContent?.({ onRequestClose: vi.fn() }) as React.ReactElement<{
                onSelectionChange?: (selection: {
                    modelId: string;
                    sessionModeId: string;
                    configOverrides: Readonly<Record<string, string>>;
                }) => void;
            }> | undefined;

        await act(async () => {
            codexDetail?.props?.onSelectionChange?.({
                modelId: 'gpt-5.4',
                sessionModeId: 'plan',
                configOverrides: {
                    reasoning_effort: 'high',
                    speed: 'fast',
                },
            });
        });
        await hook.rerender();

        expect(hook.getCurrent().selectedEntry.backendTargetKey).toBe(codexEntry.backendTargetKey);
        expect(hook.getCurrent().authoring.modelMode).toBe('gpt-5.4');
        expect(hook.getCurrent().authoring.acpSessionModeId).toBe('plan');
        expect(hook.getCurrent().authoring.sessionConfigOptionOverrides).toEqual(expect.objectContaining({
            overrides: {
                reasoning_effort: {
                    updatedAt: expect.any(Number),
                    value: 'high',
                },
                speed: {
                    updatedAt: expect.any(Number),
                    value: 'fast',
                },
            },
        }));

        await act(async () => {
            hook.getCurrent().picker.handleAgentPickerSelect(codexEntry.backendTargetKey);
        });
        await hook.rerender();

        expect(hook.getCurrent().selectedEntry.backendTargetKey).toBe(codexEntry.backendTargetKey);
        expect(hook.getCurrent().authoring.modelMode).toBe('gpt-5.4');
        expect(hook.getCurrent().authoring.acpSessionModeId).toBe('plan');
        expect(hook.getCurrent().authoring.sessionConfigOptionOverrides?.overrides.reasoning_effort?.value).toBe('high');
        expect(hook.getCurrent().authoring.sessionConfigOptionOverrides?.overrides.speed?.value).toBe('fast');
    });
});
