import * as React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';
import type { AccountProfile, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import { useNewSessionAgentPickerControls } from './useNewSessionAgentPickerControls';
import { buildRememberedEngineSelectionScopeKey } from '@/sync/domains/sessionAuthoring/rememberedEngineSelections';

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

vi.mock('@/components/sessions/new/components/NewSessionEngineOptionDetail', () => ({
    NewSessionEngineOptionDetail: (props: Record<string, unknown>) => React.createElement('NewSessionEngineOptionDetail', props),
}));

vi.mock('@/components/sessions/new/components/NewSessionFavoriteModelsDetail', () => ({
    NewSessionFavoriteModelsDetail: (props: Record<string, unknown>) => React.createElement('NewSessionFavoriteModelsDetail', props),
}));

function buildAgentPickerHookParams(overrides: Partial<Parameters<typeof useNewSessionAgentPickerControls>[0]> = {}): Parameters<typeof useNewSessionAgentPickerControls>[0] {
    return {
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        resolvedBackendEntries: [
            {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
                providerAgentId: 'claude',
                builtInAgentId: 'claude',
                iconAgentId: 'claude',
            } as any,
            {
                target: { kind: 'builtInAgent', agentId: 'codex' },
                targetKey: 'agent:codex',
                title: 'Codex',
                subtitle: null,
                providerAgentId: 'codex',
                builtInAgentId: 'codex',
                iconAgentId: 'codex',
            } as any,
        ],
        getCompatibleProfileBackendEntries: () => [],
        isBackendEntrySelectable: () => true,
        selectedBackendEntry: {
            target: { kind: 'builtInAgent', agentId: 'claude' },
            targetKey: 'agent:claude',
            title: 'Claude',
            subtitle: null,
            providerAgentId: 'claude',
            builtInAgentId: 'claude',
            iconAgentId: 'claude',
        } as any,
        selectedBackendTargetKey: 'agent:claude',
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
        ...overrides,
    };
}

describe('useNewSessionAgentPickerControls', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('keeps hot-path picker outputs stable when semantic inputs are unchanged', async () => {
        const initialParams = buildAgentPickerHookParams();
        const hook = await renderHook((props: Parameters<typeof useNewSessionAgentPickerControls>[0]) => (
            useNewSessionAgentPickerControls(props)
        ), { initialProps: initialParams });

        const first = hook.getCurrent();

        await hook.rerender({ ...initialParams });

        const second = hook.getCurrent();
        expect(second.agentPickerOptions).toBe(first.agentPickerOptions);
        expect(second.handleAgentPickerSelect).toBe(first.handleAgentPickerSelect);
        expect(second.handleAgentClick).toBe(first.handleAgentClick);

        await hook.unmount();
    });

    it('keeps all backend options visible, suppresses redundant compatible subtitles, and disables entries that are incompatible with the selected profile', async () => {
        const setBackendTarget = vi.fn();

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: true,
            selectedProfileId: 'profile-1',
            profileMap: new Map([[
                'profile-1',
                { id: 'profile-1', name: 'Profile 1' } as any,
            ]]),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: 'Claude',
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: 'Codex',
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => ([
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: 'Claude',
                } as any,
            ]),
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: 'Claude',
            } as any,
            selectedBackendTargetKey: 'agent:claude',
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
            subtitle: option.subtitle ?? null,
        }))).toEqual([
            { id: 'agent:claude', disabled: false, muted: false, subtitle: null },
            { id: 'agent:codex', disabled: true, muted: true, subtitle: 'newSession.aiBackendNotCompatibleWithSelectedProfile' },
        ]);
    });

    it('orders favorite engines first and exposes row toggle actions without selecting the engine', async () => {
        const setFavoriteBackendTargetKeys = vi.fn();
        const setBackendTarget = vi.fn();
        const hook = await renderHook(() => useNewSessionAgentPickerControls(buildAgentPickerHookParams({
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
                providerAgentId: 'claude',
                builtInAgentId: 'claude',
                iconAgentId: 'claude',
            } as any,
            selectedBackendTargetKey: 'agent:claude',
            setBackendTarget,
            favoriteBackendTargetKeys: ['agent:codex'],
            setFavoriteBackendTargetKeys,
        })));

        expect(hook.getCurrent().agentPickerOptions?.map((option) => option.id)).toEqual([
            'agent:codex',
            'agent:claude',
        ]);

        const claudeOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:claude');
        const claudeAction = (claudeOption as { railAction?: { selected: boolean; onPress: () => void } } | undefined)?.railAction;
        expect(claudeAction?.selected).toBe(false);

        claudeAction?.onPress();

        expect(setFavoriteBackendTargetKeys).toHaveBeenCalledWith(['agent:codex', 'agent:claude']);
        expect(setBackendTarget).not.toHaveBeenCalled();

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex');
        const codexAction = (codexOption as { railAction?: { selected: boolean; onPress: () => void } } | undefined)?.railAction;
        expect(codexAction?.selected).toBe(true);

        codexAction?.onPress();

        expect(setFavoriteBackendTargetKeys).toHaveBeenLastCalledWith([]);
    });

    it('remembers the favorites rail as the focused picker view independently from the selected engine', async () => {
        const onRememberAgentPickerView = vi.fn();
        const hook = await renderHook(() => useNewSessionAgentPickerControls(buildAgentPickerHookParams({
            favoriteModelSelections: [
                { backendTargetKey: 'agent:codex', modelId: 'gpt-5.4' },
            ],
            setFavoriteModelSelections: vi.fn(),
            rememberedAgentPickerView: { kind: 'favoriteModels' },
            onRememberAgentPickerView,
        })));

        expect(hook.getCurrent().agentPickerSelectedOptionId).toBe('favorite-models');

        const favoriteOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'favorite-models');
        favoriteOption?.onSelectImmediate?.();

        expect(onRememberAgentPickerView).toHaveBeenCalledWith({ kind: 'favoriteModels' });

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex');
        codexOption?.onSelectImmediate?.();

        expect(onRememberAgentPickerView).toHaveBeenLastCalledWith({
            kind: 'backend',
            backendTargetKey: 'agent:codex',
        });
    });

    it('adds a favorites rail option when favorite model selections exist', async () => {
        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                    providerAgentId: 'claude',
                    builtInAgentId: 'claude',
                    iconAgentId: 'claude',
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: null,
                    providerAgentId: 'codex',
                    builtInAgentId: 'codex',
                    iconAgentId: 'codex',
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
            } as any,
            selectedBackendTargetKey: 'agent:claude',
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
                { backendTargetKey: 'agent:codex', modelId: 'gpt-5.4' },
            ],
            setFavoriteModelSelections: vi.fn(),
        }));

        expect(hook.getCurrent().agentPickerOptions?.map((option) => option.id)).toEqual([
            'favorite-models',
            'agent:claude',
            'agent:codex',
        ]);
        expect(hook.getCurrent().agentPickerOptions?.[0]?.label).toBe('profiles.groups.favorites');
        expect(hook.getCurrent().agentPickerOptions?.[0]?.closeOnSelectImmediate).toBe(false);
        expect(hook.getCurrent().agentPickerOptions?.[0]?.deferRenderDetailContent).toBe(true);
    });

    it('keeps a favorite model selection when the backend tab becomes focused before external model state catches up', async () => {
        const setBackendTarget = vi.fn();
        const setModelMode = vi.fn();
        const initialParams = buildAgentPickerHookParams({
            setBackendTarget,
            setModelMode: setModelMode as any,
            favoriteModelSelections: [
                {
                    backendTargetKey: 'agent:codex',
                    providerAgentId: 'codex',
                    builtInAgentId: 'codex',
                    modelId: 'gpt-5.5',
                    modelLabel: 'GPT 5.5',
                },
            ],
            setFavoriteModelSelections: vi.fn(),
        });
        const hook = await renderHook((props: Parameters<typeof useNewSessionAgentPickerControls>[0]) => (
            useNewSessionAgentPickerControls(props)
        ), { initialProps: initialParams });

        const favoriteDetail = hook.getCurrent().agentPickerOptions?.[0]?.renderDetailContent?.() as React.ReactElement<{
            onSelectFavoriteModel?: (entry: any, modelId: string, configOverrides?: Readonly<Record<string, string>>) => void;
        }> | undefined;
        const codexEntry = initialParams.resolvedBackendEntries[1]!;

        favoriteDetail?.props?.onSelectFavoriteModel?.(codexEntry, 'gpt-5.5', { reasoning_effort: 'high' });

        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'builtInAgent', agentId: 'codex' });
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
            selectedBackendTargetKey: 'agent:codex',
            modelMode: 'default',
        });

        const codexDetail = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex')
            ?.renderDetailContent?.() as React.ReactElement<{ selectedModelId?: string }> | undefined;

        expect(codexDetail?.props.selectedModelId).toBe('gpt-5.5');
    });

    it('updates favorites detail selection props when a favorite model is selected while the picker stays open', async () => {
        const favoriteGpt55 = {
            backendTargetKey: 'agent:codex',
            providerAgentId: 'codex',
            builtInAgentId: 'codex',
            modelId: 'gpt-5.5',
            modelLabel: 'GPT 5.5',
        };
        const initialParams = buildAgentPickerHookParams({
            favoriteModelSelections: [favoriteGpt55],
            setFavoriteModelSelections: vi.fn(),
        });
        const hook = await renderHook((props: Parameters<typeof useNewSessionAgentPickerControls>[0]) => (
            useNewSessionAgentPickerControls(props)
        ), { initialProps: initialParams });

        const firstOptions = hook.getCurrent().agentPickerOptions;
        const codexEntry = initialParams.resolvedBackendEntries[1]!;

        await hook.rerender({
            ...initialParams,
            selectedBackendEntry: codexEntry,
            selectedBackendTargetKey: 'agent:codex',
            modelMode: 'gpt-5.5',
        });

        expect(hook.getCurrent().agentPickerOptions).toBe(firstOptions);

        const favoriteDetail = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'favorite-models')
            ?.renderDetailContent?.() as React.ReactElement<{
                selectedBackendTargetKey?: string;
                selectedModelId?: string;
            }> | undefined;

        expect(favoriteDetail?.props.selectedBackendTargetKey).toBe('agent:codex');
        expect(favoriteDetail?.props.selectedModelId).toBe('gpt-5.5');
    });

    it('publishes updated config overrides to an already-open favorite model detail', async () => {
        const favoriteGpt55 = {
            backendTargetKey: 'agent:codex',
            providerAgentId: 'codex',
            builtInAgentId: 'codex',
            modelId: 'gpt-5.5',
            modelLabel: 'GPT 5.5',
        };
        const codexEntry = buildAgentPickerHookParams().resolvedBackendEntries[1]!;
        const initialParams = buildAgentPickerHookParams({
            selectedBackendEntry: codexEntry,
            selectedBackendTargetKey: 'agent:codex',
            modelMode: 'gpt-5.5',
            favoriteModelSelections: [favoriteGpt55],
            setFavoriteModelSelections: vi.fn(),
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 10,
                overrides: {
                    context: { updatedAt: 10, value: '272k' },
                },
            },
        });
        const hook = await renderHook((props: Parameters<typeof useNewSessionAgentPickerControls>[0]) => (
            useNewSessionAgentPickerControls(props)
        ), { initialProps: initialParams });
        const firstOptions = hook.getCurrent().agentPickerOptions;

        await hook.rerender({
            ...initialParams,
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 20,
                overrides: {
                    context: { updatedAt: 20, value: '1m' },
                },
            },
        });

        expect(hook.getCurrent().agentPickerOptions).not.toBe(firstOptions);
        const favoriteDetail = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'favorite-models')
            ?.renderDetailContent?.() as React.ReactElement<{
                selectedConfigOverrides?: Readonly<Record<string, string>>;
            }> | undefined;
        expect(favoriteDetail?.props.selectedConfigOverrides).toEqual({ context: '1m' });
    });

    it('atomically selects a favorite backend, model, and config when editing it from another backend', async () => {
        const favoriteGpt55 = {
            backendTargetKey: 'agent:codex',
            providerAgentId: 'codex',
            builtInAgentId: 'codex',
            modelId: 'gpt-5.5',
            modelLabel: 'GPT 5.5',
        };
        const setBackendTarget = vi.fn();
        const setModelMode = vi.fn();
        const setAcpSessionModeId = vi.fn();
        const setSessionConfigOptionOverrides = vi.fn();
        const onRememberEngineSelection = vi.fn();
        const codexEntry = buildAgentPickerHookParams().resolvedBackendEntries[1]!;
        const hook = await renderHook(() => useNewSessionAgentPickerControls(buildAgentPickerHookParams({
            favoriteModelSelections: [favoriteGpt55],
            setFavoriteModelSelections: vi.fn(),
            setBackendTarget,
            setModelMode: setModelMode as any,
            acpSessionModeId: 'build',
            setAcpSessionModeId: setAcpSessionModeId as any,
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 10,
                overrides: {
                    context: { updatedAt: 10, value: '272k' },
                },
            },
            setSessionConfigOptionOverrides: setSessionConfigOptionOverrides as any,
            onRememberEngineSelection,
        })));
        const favoriteDetail = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'favorite-models')
            ?.renderDetailContent?.() as React.ReactElement<{
                onSelectFavoriteModelOptionValue?: (
                    entry: typeof codexEntry,
                    modelId: string,
                    configId: string,
                    valueId: string,
                ) => void;
            }> | undefined;

        favoriteDetail?.props.onSelectFavoriteModelOptionValue?.(
            codexEntry,
            'gpt-5.5',
            'context',
            '1m',
        );

        expect(setBackendTarget).toHaveBeenCalledTimes(1);
        expect(setBackendTarget).toHaveBeenCalledWith(codexEntry.target);
        expect(setModelMode).toHaveBeenCalledTimes(1);
        expect(setModelMode).toHaveBeenCalledWith('gpt-5.5');
        expect(setAcpSessionModeId).toHaveBeenCalledTimes(1);
        expect(setAcpSessionModeId).toHaveBeenCalledWith(null);
        expect(setSessionConfigOptionOverrides).toHaveBeenCalledWith(expect.objectContaining({
            overrides: {
                context: {
                    updatedAt: expect.any(Number),
                    value: '1m',
                },
            },
        }));
        expect(onRememberEngineSelection).toHaveBeenCalledWith(
            codexEntry.target,
            expect.objectContaining({
                modelId: 'gpt-5.5',
                acpSessionModeId: null,
                sessionConfigOptionOverrides: expect.objectContaining({
                    overrides: {
                        context: {
                            updatedAt: expect.any(Number),
                            value: '1m',
                        },
                    },
                }),
            }),
        );
    });

    it('updates engine detail favorite toggles when favorite model settings change while the picker stays open', async () => {
        const setFavoriteModelSelections = vi.fn();
        const favoriteGpt54 = {
            backendTargetKey: 'agent:codex',
            providerAgentId: 'codex',
            builtInAgentId: 'codex',
            modelId: 'gpt-5.4',
            modelLabel: 'GPT 5.4',
        };
        const favoriteGpt55 = {
            backendTargetKey: 'agent:codex',
            providerAgentId: 'codex',
            builtInAgentId: 'codex',
            modelId: 'gpt-5.5',
            modelLabel: 'GPT 5.5',
        };
        const initialParams = buildAgentPickerHookParams({
            favoriteModelSelections: [favoriteGpt54],
            setFavoriteModelSelections,
        });
        const hook = await renderHook((props: Parameters<typeof useNewSessionAgentPickerControls>[0]) => (
            useNewSessionAgentPickerControls(props)
        ), { initialProps: initialParams });

        await hook.rerender({
            ...initialParams,
            favoriteModelSelections: [favoriteGpt54, favoriteGpt55],
        });

        const codexDetail = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex')
            ?.renderDetailContent?.() as React.ReactElement<{
                favoriteModelSelections?: readonly typeof favoriteGpt54[];
                onToggleFavoriteModel?: (model: { modelId: string; modelLabel: string }) => void;
            }> | undefined;

        expect(codexDetail?.props.favoriteModelSelections?.map((favorite) => favorite.modelId)).toEqual([
            'gpt-5.4',
            'gpt-5.5',
        ]);

        codexDetail?.props.onToggleFavoriteModel?.({
            modelId: 'gpt-5.5',
            modelLabel: 'GPT 5.5',
        });

        expect(setFavoriteModelSelections).toHaveBeenCalledWith([favoriteGpt54]);
    });

    it('does not expose favorite model selections for backends incompatible with the selected profile', async () => {
        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: true,
            selectedProfileId: 'profile-1',
            profileMap: new Map([[
                'profile-1',
                { id: 'profile-1', name: 'Profile 1' } as any,
            ]]),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                    providerAgentId: 'claude',
                    builtInAgentId: 'claude',
                    iconAgentId: 'claude',
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: null,
                    providerAgentId: 'codex',
                    builtInAgentId: 'codex',
                    iconAgentId: 'codex',
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => ([
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                    providerAgentId: 'claude',
                    builtInAgentId: 'claude',
                    iconAgentId: 'claude',
                } as any,
            ]),
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
            } as any,
            selectedBackendTargetKey: 'agent:claude',
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
                    backendTargetKey: 'agent:codex',
                    providerAgentId: 'codex',
                    builtInAgentId: 'codex',
                    modelId: 'gpt-5.4',
                },
            ],
            setFavoriteModelSelections: vi.fn(),
        }));

        expect(hook.getCurrent().agentPickerOptions?.map((option) => option.id)).toEqual([
            'agent:claude',
            'agent:codex',
        ]);
    });

    it('keeps unavailable backends selectable (muted) and orders available entries first', async () => {
        const setBackendTarget = vi.fn();

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: null,
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: (entry: any) => entry.targetKey !== 'agent:codex',
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
            } as any,
            selectedBackendTargetKey: 'agent:claude',
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
        }))).toEqual([
            { id: 'agent:claude', disabled: false, muted: false },
            { id: 'agent:codex', disabled: false, muted: true },
        ]);

        hook.getCurrent().handleAgentPickerSelect('agent:codex');
        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'builtInAgent', agentId: 'codex' });
    });

    it('publishes engine detail selection changes immediately for the focused backend option', async () => {
        const setBackendTarget = vi.fn();
        const setModelMode = vi.fn();
        const setAcpSessionModeId = vi.fn();
        const setSessionConfigOptionOverrides = vi.fn();
        const onRememberEngineSelection = vi.fn();
        const refreshProbe = { phase: 'idle' as const, onRefresh: vi.fn() };

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: null,
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
            } as any,
            selectedBackendTargetKey: 'agent:claude',
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
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex');
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

        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'builtInAgent', agentId: 'codex' });
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
    });

    it('passes per-entry connected-services bindings to an engine detail even when another engine is selected', async () => {
        const accountProfileConnectedServicesV2: AccountProfile['connectedServicesV2'] = [
            {
                serviceId: 'openai-codex',
                profiles: [
                    {
                        profileId: 'leeroy',
                        status: 'connected',
                        kind: 'oauth',
                        providerEmail: 'leeroy@example.com',
                        providerAccountId: null,
                        expiresAt: null,
                        lastUsedAt: null,
                        health: null,
                    },
                ],
                groups: [{
                    groupId: 'happier',
                    displayName: 'Happier',
                    activeProfileId: 'leeroy',
                    generation: 1,
                    memberProfileIds: ['leeroy'],
                }],
            },
        ];
        const expectedConnectedServices: ConnectedServiceBindingsV1 = {
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'happier',
                },
            },
        };
        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            ...buildAgentPickerHookParams(),
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
                providerAgentId: 'claude',
                builtInAgentId: 'claude',
                iconAgentId: 'claude',
            } as any,
            selectedBackendTargetKey: 'agent:claude',
            accountProfileConnectedServicesV2,
            connectedServicesFeatureEnabled: true,
            connectedServicesAccountGroupsFeatureEnabled: true,
            agentNewSessionOptionStateByAgentId: {
                'agent:codex': {
                    connectedServicesBindingsByServiceId: {
                        'openai-codex': {
                            source: 'connected',
                            selection: 'group',
                            groupId: 'happier',
                        },
                    },
                },
            },
            settings: {
                connectedServicesProfileLabelByKey: {},
                connectedServicesDefaultProfileByServiceId: {},
                connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
            } as any,
        } as Parameters<typeof useNewSessionAgentPickerControls>[0]));

        const codexDetail = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex')
            ?.renderDetailContent?.() as React.ReactElement<{ connectedServices?: ConnectedServiceBindingsV1 | null }> | undefined;

        expect(codexDetail?.props.connectedServices).toEqual(expect.objectContaining({
            v: expectedConnectedServices.v,
            bindingsByServiceId: expect.objectContaining(expectedConnectedServices.bindingsByServiceId),
        }));
    });

    it('keeps an unselected native mode unset when selecting a new engine', async () => {
        const setAcpSessionModeId = vi.fn();
        const hook = await renderHook(() => useNewSessionAgentPickerControls(buildAgentPickerHookParams({
            setAcpSessionModeId,
        })));

        hook.getCurrent().handleAgentPickerSelect('agent:codex');

        expect(setAcpSessionModeId).toHaveBeenCalledWith(null);
        await hook.unmount();
    });

    it.each([null, 'default'] as const)('restores a remembered native mode without rewriting %s', async (acpSessionModeId) => {
        const params = buildAgentPickerHookParams();
        const entry = params.resolvedBackendEntries[1]!;
        const setAcpSessionModeId = vi.fn();
        const scopeKey = buildRememberedEngineSelectionScopeKey({ serverId: 'server-1', backendTarget: entry.target });
        const hook = await renderHook(() => useNewSessionAgentPickerControls(buildAgentPickerHookParams({
            setAcpSessionModeId,
            rememberEngineSelectionsEnabled: true,
            rememberedEngineSelectionServerId: 'server-1',
            rememberedEngineSelectionsByScope: {
                [scopeKey]: { modelId: null, acpSessionModeId, sessionConfigOptionOverrides: null, updatedAt: 1 },
            },
        })));

        hook.getCurrent().handleAgentPickerSelect(entry.targetKey);

        expect(setAcpSessionModeId).toHaveBeenCalledWith(acpSessionModeId);
        await hook.unmount();
    });

    it('clears ACP session mode when selecting a backend that does not expose session modes', async () => {
        const setBackendTarget = vi.fn();
        const setModelMode = vi.fn();
        const setAcpSessionModeId = vi.fn();
        const onRememberEngineSelection = vi.fn();
        const kimiEntry = {
            target: { kind: 'builtInAgent', agentId: 'kimi' },
            targetKey: 'agent:kimi',
            title: 'Kimi',
            subtitle: null,
            providerAgentId: 'kimi',
            builtInAgentId: 'kimi',
            iconAgentId: 'kimi',
        } as const;

        const hook = await renderHook(() => useNewSessionAgentPickerControls(buildAgentPickerHookParams({
            resolvedBackendEntries: [
                ...buildAgentPickerHookParams().resolvedBackendEntries,
                kimiEntry as any,
            ],
            setBackendTarget,
            setModelMode: setModelMode as any,
            acpSessionModeId: 'plan',
            setAcpSessionModeId: setAcpSessionModeId as any,
            onRememberEngineSelection,
        })));

        hook.getCurrent().handleAgentPickerSelect('agent:kimi');

        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'builtInAgent', agentId: 'kimi' });
        expect(setModelMode).toHaveBeenCalledWith('default');
        expect(setAcpSessionModeId).toHaveBeenCalledWith(null);
        expect(onRememberEngineSelection).toHaveBeenCalledWith(
            { kind: 'builtInAgent', agentId: 'kimi' },
            {
                modelId: 'default',
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
            },
        );
    });

    it('marks engine rail selections as immediate updates that keep the popover open', async () => {
        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: null,
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
            } as any,
            selectedBackendTargetKey: 'agent:claude',
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

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex');

        expect(codexOption?.onSelectImmediate).toBeTypeOf('function');
        expect(codexOption?.closeOnSelectImmediate).toBe(false);
    });

    it('does not expose an explicit apply action for detailed engine options', async () => {
        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: null,
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
            } as any,
            selectedBackendTargetKey: 'agent:claude',
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

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex');

        expect(codexOption?.renderDetailContent).toBeTypeOf('function');
        expect(codexOption?.deferRenderDetailContent).toBe(true);
        expect(codexOption?.onApply).toBeUndefined();
    });

    it('restores the cached per-backend engine selection when a backend is reselected', async () => {
        const setBackendTarget = vi.fn();
        const setModelMode = vi.fn();
        const setAcpSessionModeId = vi.fn();
        const setSessionConfigOptionOverrides = vi.fn();
        const onRememberEngineSelection = vi.fn();

        const hook = await renderHook(() => useNewSessionAgentPickerControls({
            useProfiles: false,
            selectedProfileId: null,
            profileMap: new Map(),
            resolvedBackendEntries: [
                {
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                    subtitle: null,
                } as any,
                {
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                    subtitle: null,
                } as any,
            ],
            getCompatibleProfileBackendEntries: () => [],
            isBackendEntrySelectable: () => true,
            selectedBackendEntry: {
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
                subtitle: null,
            } as any,
            selectedBackendTargetKey: 'agent:claude',
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
            onRememberEngineSelection,
        }));

        const codexOption = hook.getCurrent().agentPickerOptions?.find((option) => option.id === 'agent:codex');
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

        hook.getCurrent().handleAgentPickerSelect('agent:codex');

        expect(setBackendTarget).toHaveBeenCalledWith({ kind: 'builtInAgent', agentId: 'codex' });
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
        expect(onRememberEngineSelection).toHaveBeenCalledWith(
            { kind: 'builtInAgent', agentId: 'codex' },
            {
                modelId: 'gpt-5.4',
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: expect.objectContaining({
                    overrides: {
                        reasoning_effort: {
                            updatedAt: expect.any(Number),
                            value: 'high',
                        },
                    },
                }),
            },
        );
    });
});
