import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';

import { useNewSessionAgentPickerControls } from './useNewSessionAgentPickerControls';
import { useNewSessionAgentAuthoringOptionsState } from './useNewSessionAgentAuthoringOptionsState';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AgentId } from '@/agents/catalog/catalog';

const modalMockState = vi.hoisted(() => ({
    alert: vi.fn(),
}));

installNewSessionScreenModelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
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

vi.mock('@/agents/registry/registryUiBehavior', () => ({
    resolveAgentUiBehavior: () => ({
        permissions: {
            footer: {
                usePermissionUpdates: false,
                forceReadOnlyAfterStop: true,
                supportsExecPolicyAmendment: false,
                stopHandling: 'denyAndAbortRun',
            },
        },
        newSession: {
            supportsTranscriptStorageMode: () => false,
        },
    }),
    resolveAgentUiBehaviorFromFlavor: () => null,
    getAgentResumeExperimentsFromSettings: () => ({ enabled: true, switches: {} }),
    buildResumeCapabilityOptionsFromUiState: (opts: { settings: unknown }) => ({ accountSettings: opts.settings }),
    getNewSessionPreflightIssues: () => [],
    buildNewSessionOptionsFromUiState: () => null,
    canSelectAgentWithoutDetectedCli: () => false,
    getNewSessionAgentInputExtraActionChips: () => undefined,
    getNewSessionRelevantInstallableDepKeys: () => [],
    buildSpawnSessionExtrasFromUiState: () => ({}),
    buildSpawnEnvironmentVariablesFromUiState: (opts: { environmentVariables?: Record<string, string> }) => opts.environmentVariables,
    buildResumeSessionExtrasFromUiState: () => ({}),
    buildWakeResumeExtras: () => ({}),
    supportsDetectedMcpConfigScan: () => false,
    supportsEditableSessionGoals: () => false,
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
        backendTarget,
        backendTargetKey: formatBackendTargetKeyV2(backendTarget),
        kind: 'builtInAgent',
        backendId,
        providerId: backendId,
        providerAgentId: backendId as any,
        builtInAgentId: backendId as any,
        iconAgentId: backendId as any,
        title,
        subtitle,
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
        backendTarget,
        backendTargetKey: formatBackendTargetKeyV2(backendTarget),
        kind: 'configuredBackend',
        backendId,
        providerId: backendId,
        providerAgentId: null,
        builtInAgentId: null,
        iconAgentId: null,
        capabilities,
        title,
        subtitle,
    };
}

function createPluginBackendEntry(
    backendId: string,
    providerAgentId: AgentId,
    title: string,
    subtitle: string | null,
): ResolvedBackendCatalogEntry {
    const backendTarget = { kind: 'backend' as const, backendId };
    return {
        backendTarget,
        backendTargetKey: formatBackendTargetKeyV2(backendTarget),
        kind: 'pluginBackend',
        backendId,
        providerId: providerAgentId,
        providerAgentId,
        builtInAgentId: null,
        iconAgentId: providerAgentId,
        title,
        subtitle,
    };
}

describe('useNewSessionAgentPickerControls', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('keeps all backend options visible, suppresses redundant compatible subtitles, and disables entries that are incompatible with the selected profile', async () => {
        const setBackendTarget = vi.fn();
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', 'Claude');
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', 'Codex');

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: true,
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
            settings: {} as any,
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
            { id: codexEntry.backendTargetKey, disabled: true, muted: true, deferRenderDetailContent: true, subtitle: 'newSession.aiBackendNotCompatibleWithSelectedProfile' },
        ]);
    });

    it('orders favorite engines first and exposes row toggle actions without selecting the engine', async () => {
        const setFavoriteBackendTargetKeys = vi.fn();
        const setBackendTarget = vi.fn();
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
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
            settings: {} as any,
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
            settings: {} as any,
            favoriteModelSelections: [
                { backendTargetKey: codexEntry.backendTargetKey, builtInAgentId: 'codex', modelId: 'gpt-5.4' },
            ],
            setFavoriteModelSelections: vi.fn(),
            rememberedAgentPickerView: { kind: 'favoriteModels' },
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
            settings: {} as any,
            favoriteModelSelections: [
                { backendTargetKey: codexEntry.backendTargetKey, builtInAgentId: 'codex', modelId: 'gpt-5.4' },
            ],
            setFavoriteModelSelections: vi.fn(),
        }));

        expect(hook.getCurrent().agentPickerOptions?.map((option) => option.id)).toEqual([
            'favorite-models',
            claudeEntry.backendTargetKey,
            codexEntry.backendTargetKey,
        ]);
        expect(hook.getCurrent().agentPickerOptions?.[0]?.label).toBe('profiles.groups.favorites');
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
            settings: {} as any,
            favoriteModelSelections: [
                {
                    backendTargetKey: codexEntry.backendTargetKey,
                    providerAgentId: 'codex',
                    builtInAgentId: 'codex',
                    modelId: 'gpt-5.5',
                    modelLabel: 'GPT 5.5',
                },
            ],
            setFavoriteModelSelections: vi.fn(),
        };
        const hook = await renderHook((props: Parameters<typeof useNewSessionAgentPickerControls>[0]) => (
            useNewSessionAgentPickerControls(props)
        ), { initialProps: initialParams });

        const favoriteDetail = hook.getCurrent().agentPickerOptions?.[0]?.renderDetailContent?.() as React.ReactElement<{
            onSelectFavoriteModel?: (entry: ResolvedBackendCatalogEntry, modelId: string, configOverrides?: Readonly<Record<string, string>>) => void;
        }> | undefined;

        favoriteDetail?.props?.onSelectFavoriteModel?.(codexEntry, 'gpt-5.5', { reasoning_effort: 'high' });

        expect(setBackendTarget).toHaveBeenCalledWith(codexEntry.backendTarget);
        expect(setModelMode).toHaveBeenCalledWith('gpt-5.5');
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
            ?.renderDetailContent?.() as React.ReactElement<{ selectedModelId?: string }> | undefined;

        expect(codexDetail?.props.selectedModelId).toBe('gpt-5.5');
    });

    it('does not expose favorite model selections for backends incompatible with the selected profile', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: true,
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
            settings: {} as any,
            favoriteModelSelections: [
                {
                    backendTargetKey: codexEntry.backendTargetKey,
                    providerAgentId: 'codex',
                    builtInAgentId: 'codex',
                    modelId: 'gpt-5.4',
                },
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
            settings: {} as any,
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
                subtitle: {
                    key: 'newSession.aiBackendCliNotDetectedOnMachine',
                    params: { cli: 'agentInput.agent.codex' },
                },
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
            settings: {} as any,
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
            settings: {} as any,
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
            settings: {} as any,
        }));

        const detailElement = hook.getCurrent().agentPickerOptions?.[0]
            ?.renderDetailContent?.() as React.ReactElement<{ runtimeCarrierAgentId?: string | null }> | undefined;

        expect(detailElement?.props.runtimeCarrierAgentId).toBe('antigravity');
    });

    it('uses the single selectable backend when clicking the agent input', async () => {
        const setBackendTarget = vi.fn();
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
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
            settings: {} as any,
        }));

        hook.getCurrent().handleAgentClick();

        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'backend', backendId: 'codex' });
    });

    it('ignores a stale remembered backend view when the selected backend changes externally', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
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
            settings: {} as any,
            rememberedAgentPickerView: {
                kind: 'backend',
                backendTargetKey: claudeEntry.backendTargetKey,
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
            settings: {} as any,
            refreshProbe,
            onRememberEngineSelection,
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === codexEntry.backendTargetKey);
        const detailElement = codexOption?.renderDetailContent?.() as React.ReactElement<{
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
            modelId: 'gpt-5.4',
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
            settings: {} as any,
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
            settings: {} as any,
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
            settings: {} as any,
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === codexEntry.backendTargetKey);
        const detailElement = codexOption?.renderDetailContent?.() as React.ReactElement<{
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

    it('propagates destination backend detail selections through target-scoped authoring state', async () => {
        const claudeEntry = createBuiltInBackendEntry('claude', 'Claude', null);
        const codexEntry = createBuiltInBackendEntry('codex', 'Codex', null);

        function useHarness() {
            const [backendTarget, setBackendTarget] = React.useState(claudeEntry.backendTarget);
            const selectedEntry = backendTarget.backendId === 'codex' ? codexEntry : claudeEntry;
            const authoring = useNewSessionAgentAuthoringOptionsState({
                agentType: selectedEntry.providerAgentId as AgentId,
                backendTargetKey: selectedEntry.backendTargetKey,
                allowTargetlessDraftEngineSelection: false,
                hydratedTempAuthoringDraft: null,
                hydratedPersistedAuthoringDraft: null,
                rememberedEngineSelection: null,
            });
            const picker = useNewSessionAgentPickerControls({
                useProfiles: false,
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
                settings: {} as any,
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
            ?.renderDetailContent?.() as React.ReactElement<{
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
