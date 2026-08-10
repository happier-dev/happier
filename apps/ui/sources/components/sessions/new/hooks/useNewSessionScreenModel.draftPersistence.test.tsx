import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { buildRememberedEngineSelectionScopeKey } from '@/sync/domains/sessionAuthoring/rememberedEngineSelections';

import {
    activeServerAccountScopeState,
    allMachinesState,
    cliDetectionState,
    clearNewSessionDraftMock,
    computeNewSessionInputMaxHeightMock,
    featureFlags,
    flushInteractionQueue,
    loadNewSessionDraftMock,
    machineMcpServersPreviewMock,
    makeTestAutomationDraft,
    makeTestProfile,
    makeTestWorkspace,
    makeTestWorkspaceCheckout,
    makeTestWorkspaceLocation,
    modalShowMock,
    persistDraftNowRef,
    persistedDraft,
    platformOsState,
    renderNewSessionScreenModel,
    resetDraftPersistenceState,
    routerPushMock,
    routerSetParamsMock,
    runFocusEffectsAndSettle,
    saveNewSessionDraftMock,
    searchParamsState,
    settingsState,
    tempSessionDataState,
    targetServerState,
    useCreateNewSessionArgsRef,
    useNewSessionScreenModelModulePromise,
    workspaceGraphState,
} from './__tests__/draftPersistenceTestEnvironment';
import { getCheckoutChipLabel } from './__tests__/checkoutChipSelectors';

// Slim core suite for cross-cutting draft hydration invariants. Domain-specific
// behavior lives in the `.path.test.tsx`, `.machine.test.tsx`, and
// `.checkout.test.tsx` sibling files. Shared mock graph + hoisted state lives
// in `__tests__/draftPersistenceTestEnvironment.ts`.
describe('useNewSessionScreenModel (draft hydration — core)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        resetDraftPersistenceState();
    });

    it('clears remembered Claude plan mode when the user switches the new-session mode back to build', async () => {
        const backendTarget = { kind: 'builtInAgent' as const, agentId: 'claude' as const };
        const scopeKey = buildRememberedEngineSelectionScopeKey({
            serverId: null,
            backendTarget,
        });
        (settingsState as any).rememberLastEngineSelectionsV1 = true;
        (settingsState as any).lastEngineSelectionsByScopeV1 = {
            [scopeKey]: {
                modelId: null,
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: null,
                updatedAt: 1,
            },
        };
        persistedDraft.backendTarget = backendTarget;
        persistedDraft.acpSessionModeId = 'plan';

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.acpSessionModeId).toBe('plan');

        await act(async () => {
            model?.simpleProps?.setAcpSessionModeId?.(null);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(model?.simpleProps?.acpSessionModeId).toBeNull();

        standardCleanup();

        expect((settingsState as any).lastEngineSelectionsByScopeV1?.[scopeKey]?.acpSessionModeId).toBeNull();
    });

    it('drops a persisted Claude model when a route-selected Codex backend owns the new session', async () => {
        searchParamsState.value = {
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        };
        persistedDraft.agentType = 'claude';
        persistedDraft.backendTarget = { kind: 'builtInAgent', agentId: 'claude' };
        persistedDraft.modelMode = 'claude-opus-4-8';

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.agentType).toBe('codex');
        expect(model?.simpleProps?.modelMode).toBe('default');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                modelId: null,
            }),
        }));
    });

    it('hydrates permission, agent, and path from the persisted draft', async () => {
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.variant).toBe('simple');
        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(model?.simpleProps?.permissionMode).toBe('yolo');
        expect(model?.simpleProps?.acpSessionModeId).toBe('plan');
        expect(model?.simpleProps?.acpConfigOptionOverrides).toEqual({
            v: 1,
            updatedAt: 123,
            overrides: {
                speed: { updatedAt: 123, value: 'fast' },
            },
        });
        expect(model?.simpleProps?.machineName).toBe('Machine Two');
        expect(typeof model?.simpleProps?.machinePopover?.renderContent).toBe('function');
        expect(model?.simpleProps?.selectedPath).toBe('/repo/custom');

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            },
        }));
    });

    it('rehydrates and durably updates the principal launch user-attempt id', async () => {
        persistedDraft.launchUserAttemptId = 'opaque-attempt-a';
        await renderNewSessionScreenModel(() => {});

        expect(useCreateNewSessionArgsRef.current?.launchUserAttemptId).toBe('opaque-attempt-a');
        expect(useCreateNewSessionArgsRef.current?.launchIntentSignature).toEqual(expect.any(String));
        const updateAttempt = useCreateNewSessionArgsRef.current?.onLaunchUserAttemptIdChange;
        expect(updateAttempt).toEqual(expect.any(Function));

        await act(async () => {
            (updateAttempt as (value: string | null) => void)('opaque-attempt-b');
        });
        expect(saveNewSessionDraftMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ launchUserAttemptId: 'opaque-attempt-b' }),
        );
    });

    it('hydrates the persisted target server when no route server is selected', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b'];
        persistedDraft.targetServerId = 'server-b';

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.targetServerId).toBe('server-b');
    });

    it('prefers the route target server over the persisted target server', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b', 'server-c'];
        persistedDraft.targetServerId = 'server-b';
        searchParamsState.value = { spawnServerId: 'server-c' };

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.targetServerId).toBe('server-c');
    });

    it('ignores an unavailable persisted target server', async () => {
        targetServerState.allowedTargetServerIds = ['server-a'];
        persistedDraft.targetServerId = 'server-b';

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.targetServerId).not.toBe('server-b');
    });

    it('persists the current target server with the launch draft', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b'];
        targetServerState.targetServerId = 'server-b';

        await renderNewSessionScreenModel(() => {});

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            targetServerId: 'server-b',
        }));
    });

    it('hydrates and persists a Windows remote launch override for the matching machine', async () => {
        allMachinesState.value = [
            { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one', happyHomeDir: '/home/one', happyCliVersion: '1.0.0', platform: 'darwin' } },
            { id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two', happyHomeDir: '/home/two', happyCliVersion: '1.0.0', platform: 'win32' } },
        ];
        persistedDraft.windowsRemoteSessionLaunchModeOverride = {
            machineId: 'machine-2',
            mode: 'windows_terminal',
        };

        await renderNewSessionScreenModel(() => {});

        expect(useCreateNewSessionArgsRef.current?.windowsRemoteSessionLaunchModeOverride).toBe('windows_terminal');

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            windowsRemoteSessionLaunchModeOverride: {
                machineId: 'machine-2',
                mode: 'windows_terminal',
            },
        }));
    });

    it('ignores a persisted Windows remote launch override for a different machine', async () => {
        allMachinesState.value = [
            { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one', happyHomeDir: '/home/one', happyCliVersion: '1.0.0', platform: 'win32' } },
            { id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two', happyHomeDir: '/home/two', happyCliVersion: '1.0.0', platform: 'win32' } },
        ];
        persistedDraft.windowsRemoteSessionLaunchModeOverride = {
            machineId: 'machine-1',
            mode: 'windows_terminal',
        };

        await renderNewSessionScreenModel(() => {});

        expect(useCreateNewSessionArgsRef.current?.windowsRemoteSessionLaunchModeOverride).toBeNull();

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({
            windowsRemoteSessionLaunchModeOverride: expect.anything(),
        }));
    });

    it('clears the Windows remote launch override from persisted drafts after the user changes machines', async () => {
        allMachinesState.value = [
            { id: 'machine-1', metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one', happyHomeDir: '/home/one', happyCliVersion: '1.0.0', platform: 'win32' } },
            { id: 'machine-2', metadata: { displayName: 'Machine Two', host: 'two', homeDir: '/home/two', happyHomeDir: '/home/two', happyCliVersion: '1.0.0', platform: 'win32' } },
        ];
        persistedDraft.windowsRemoteSessionLaunchModeOverride = {
            machineId: 'machine-2',
            mode: 'windows_terminal',
        };

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        const content = model?.simpleProps?.machinePopover?.renderContent({ requestClose: vi.fn() });
        const machineSelectionContent = content as React.ReactElement<{
            onSelectMachine: (machine: { id: string; metadata: { displayName: string; host: string; homeDir: string; happyHomeDir: string; happyCliVersion: string; platform: string } }) => void;
        }>;
        await act(async () => {
            machineSelectionContent.props.onSelectMachine({
                id: 'machine-1',
                metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one', happyHomeDir: '/home/one', happyCliVersion: '1.0.0', platform: 'win32' },
            });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).not.toEqual(expect.objectContaining({
            windowsRemoteSessionLaunchModeOverride: expect.anything(),
        }));
    });

    it('defers machine popover close after selection on web to avoid click fall-through', async () => {
        vi.useFakeTimers();
        try {
            let model: any = null;
            await renderNewSessionScreenModel((nextModel) => {
                model = nextModel;
            });

            const requestClose = vi.fn();
            const content = model?.simpleProps?.machinePopover?.renderContent({ requestClose });
            expect(React.isValidElement(content)).toBe(true);

            await act(async () => {
                (content as React.ReactElement<any>).props.onSelectMachine({
                    id: 'machine-1',
                    metadata: { displayName: 'Machine One', host: 'one', homeDir: '/home/one' },
                });
            });

            expect(requestClose).not.toHaveBeenCalled();

            await act(async () => {
                vi.runOnlyPendingTimers();
            });

            expect(requestClose).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves live composer panel height ownership to the keyboard scaffold', async () => {
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.variant).toBe('simple');
        expect(model?.simpleProps?.sessionPromptInputMaxHeight).toBeUndefined();
        expect(computeNewSessionInputMaxHeightMock).not.toHaveBeenCalled();
    });

    it('keeps simple-panel hot-path props stable across unchanged rerenders', async () => {
        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });
        const firstProps = model?.simpleProps;

        await hook.rerender();
        const secondProps = model?.simpleProps;

        expect(secondProps?.modelOptionsProbe).toBe(firstProps?.modelOptionsProbe);
        expect(secondProps?.acpSessionModeProbe).toBe(firstProps?.acpSessionModeProbe);
        expect(secondProps?.acpConfigOptionsProbe).toBe(firstProps?.acpConfigOptionsProbe);
        expect(secondProps?.connectionStatus).toBe(firstProps?.connectionStatus);
        expect(secondProps?.machinePopover).toBe(firstProps?.machinePopover);
        expect(secondProps?.pathPopover).toBe(firstProps?.pathPopover);
        expect(secondProps?.agentInputExtraActionChips).toBe(firstProps?.agentInputExtraActionChips);

        allMachinesState.value = allMachinesState.value.map((machine) => (
            machine?.id === 'machine-2'
                ? { ...machine, activeAt: 456 }
                : machine
        ));
        await hook.rerender();

        expect(model?.simpleProps?.machinePopover).toBe(firstProps?.machinePopover);

        await hook.unmount();
    });

    it('keeps the default attachment flow id stable across new-session route remounts', async () => {
        let firstModel: any = null;
        const firstHook = await renderNewSessionScreenModel((nextModel) => {
            firstModel = nextModel;
        });
        const firstAttachmentFlowId = firstModel?.simpleProps?.attachmentFlowId;
        expect(typeof firstAttachmentFlowId).toBe('string');
        expect(firstAttachmentFlowId.length).toBeGreaterThan(0);

        await firstHook.unmount();

        let secondModel: any = null;
        const secondHook = await renderNewSessionScreenModel((nextModel) => {
            secondModel = nextModel;
        });

        expect(secondModel?.simpleProps?.attachmentFlowId).toBe(firstAttachmentFlowId);

        await secondHook.unmount();
    });

    it('keeps the agent picker probe stable when CLI detection remains in the same phase', async () => {
        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });
        const firstProbe = model?.simpleProps?.agentPickerProbe;
        const firstAgentPickerOptions = model?.simpleProps?.agentPickerOptions;
        const firstHandleAgentClick = model?.simpleProps?.handleAgentClick;
        const firstHandleAgentPickerSelect = model?.simpleProps?.onAgentPickerSelect;

        cliDetectionState.value = {
            ...cliDetectionState.value,
            timestamp: cliDetectionState.value.timestamp + 1,
            refresh: vi.fn(),
        };
        await hook.rerender();

        expect(model?.simpleProps?.agentPickerProbe).toBe(firstProbe);
        expect(model?.simpleProps?.agentPickerOptions).toBe(firstAgentPickerOptions);
        expect(model?.simpleProps?.handleAgentClick).toBe(firstHandleAgentClick);
        expect(model?.simpleProps?.onAgentPickerSelect).toBe(firstHandleAgentPickerSelect);

        await hook.unmount();
    });

    it('clears backend route seed params after an explicit agent picker selection', async () => {
        searchParamsState.value = {
            agentType: 'codex',
        };
        persistedDraft.agentType = 'claude';

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.agentType).toBe('codex');

        const claudeOption = model?.simpleProps?.agentPickerOptions?.find?.((option: { id: string }) => option.id === 'agent:claude');
        expect(claudeOption).toBeTruthy();

        await act(async () => {
            claudeOption?.onSelectImmediate?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(model?.simpleProps?.agentType).toBe('claude');
        expect(routerSetParamsMock).toHaveBeenCalledWith({
            agentType: undefined,
            backendTarget: undefined,
            backendTargetKey: undefined,
        });

        await hook.unmount();
    });

    it('hydrates scoped worktree intent on first render when the target server is already resolved', async () => {
        targetServerState.allowedTargetServerIds = ['server-a', 'server-b'];
        targetServerState.targetServerId = 'server-b';
        targetServerState.targetServerName = 'Server B';
        persistedDraft.selectedWorkspaceId = 'ws_payments';
        persistedDraft.selectedWorkspaceLocationId = 'loc_local';
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = {
            kind: 'git_worktree',
            displayName: 'feature/first-render-fix',
            baseRef: 'main',
        };

        workspaceGraphState.workspacesByServerId['server-b'] = [
            makeTestWorkspace({
                id: 'ws_payments',
                displayName: 'Payments',
                locationIds: ['loc_local'],
                defaultLocationId: 'loc_local',
            }),
        ];

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(loadNewSessionDraftMock).toHaveBeenCalled();
        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(model?.simpleProps?.checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/first-render-fix',
            baseRef: 'main',
            branchMode: 'new',
        });
        expect(getCheckoutChipLabel(model)).toBe('newSession.checkout.newWorktree: feature/first-render-fix');
        const getServerChip = () => model?.simpleProps?.agentInputExtraActionChips?.find(
            (chip: any) => chip?.key === 'new-session-target-server',
        );
        expect(getServerChip()?.controlId).toBe('server');
        expect(getServerChip()?.collapsedContentPopover).toEqual(expect.objectContaining({
            title: 'Server B',
            label: 'Server B',
        }));
    });

    it('infers linked workspace context on first render when the selected path already belongs to a workspace', async () => {
        persistedDraft.selectedWorkspaceId = null as any;
        persistedDraft.selectedWorkspaceLocationId = null as any;
        persistedDraft.selectedWorkspaceCheckoutId = null as any;
        persistedDraft.checkoutCreationDraft = null;

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                checkoutCreationDraft: null,
            }),
        }));
    });

    it('exposes an automation submit accessibility label when automation is enabled in the draft', async () => {
        featureFlags.automationsEnabled = true;
        persistedDraft.automationDraft = makeTestAutomationDraft({ enabled: true, name: 'Daily summary' });
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.submitAccessibilityLabel).toBe('automations.create.createButtonTitle');
    });

    it('resets stale automation-only draft fields when the route explicitly starts a fresh automation create flow', async () => {
        featureFlags.automationsEnabled = true;
        persistedDraft.automationDraft = makeTestAutomationDraft({
            enabled: true,
            name: 'Legacy automation',
            description: 'Carryover description',
            everyMinutes: 90,
            timezone: 'Europe/Zurich',
        });
        searchParamsState.value = { automation: '1' };
        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.submitAccessibilityLabel).toBe('automations.create.createButtonTitle');
        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            automationDraft: expect.objectContaining(makeTestAutomationDraft({ enabled: true })),
        }));
    });

    it('drops stale in-memory automation mode when focus reloads a plain /new draft after automation create', async () => {
        featureFlags.automationsEnabled = true;
        persistedDraft.automationDraft = makeTestAutomationDraft();
        searchParamsState.value = { automation: '1' };
        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.submitAccessibilityLabel).toBe('automations.create.createButtonTitle');

        searchParamsState.value = {};
        persistedDraft.automationDraft = makeTestAutomationDraft();
        persistedDraft.updatedAt = 456;

        await hook.rerender();
        const cleanups = await runFocusEffectsAndSettle();
        for (const cleanup of cleanups) {
            if (typeof cleanup === 'function') cleanup();
        }

        expect(model?.simpleProps?.submitAccessibilityLabel).toBeUndefined();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({ automation: null }),
        }));
    });

    it('does not rehydrate plain /new into automation mode after autosaving a forced automation route draft', async () => {
        featureFlags.automationsEnabled = true;
        persistedDraft.automationDraft = makeTestAutomationDraft();
        searchParamsState.value = { automation: '1' };

        let automationRouteModel: any = null;
        let plainRouteModel: any = null;
        const automationRouteHook = await renderNewSessionScreenModel((nextModel) => {
            automationRouteModel = nextModel;
        });

        expect(automationRouteModel?.simpleProps?.submitAccessibilityLabel).toBe('automations.create.createButtonTitle');

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        const savedAutomationDraft = saveNewSessionDraftMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
        expect(savedAutomationDraft).toEqual(expect.objectContaining({
            automationDraft: expect.objectContaining({
                enabled: true,
            }),
            entryIntent: 'automation',
        }));

        persistedDraft.automationDraft = savedAutomationDraft?.automationDraft as any;
        persistedDraft.entryIntent = savedAutomationDraft?.entryIntent;
        persistedDraft.updatedAt = Number(savedAutomationDraft?.updatedAt ?? 456);
        searchParamsState.value = {};

        await automationRouteHook.unmount();
        await renderNewSessionScreenModel((nextModel) => {
            plainRouteModel = nextModel;
        });

        expect(plainRouteModel?.simpleProps?.submitAccessibilityLabel).toBeUndefined();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                automation: null,
            }),
        }));
    });

    it('hydrates temp edit seed data and exposes save semantics for automation editing', async () => {
        settingsState.useProfiles = true;
        searchParamsState.value = {
            dataId: 'temp-edit-seed',
            automation: '1',
            automationEditId: 'auto-1',
        };
        tempSessionDataState.value = {
            prompt: 'Review the open pull requests',
            machineId: 'machine-1',
            path: '/repo/edit-seed',
            agentType: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer',
            transcriptStorage: 'direct',
            permissionMode: 'acceptEdits',
            automationDraft: makeTestAutomationDraft({
                enabled: true,
                name: 'PR review',
                description: 'Nightly review',
                everyMinutes: 30,
            }),
        };

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.agentType).toBe('codex');
        expect(model?.simpleProps?.selectedPath).toBe('/repo/edit-seed');
        expect(model?.simpleProps?.permissionMode).toBe('acceptEdits');
        expect(model?.simpleProps?.submitAccessibilityLabel).toBe('automations.edit.saveAutomationLabel');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                directory: '/repo/edit-seed',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                prompt: 'Review the open pull requests',
                displayText: 'Review the open pull requests',
            }),
        }));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            input: 'Review the open pull requests',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/edit-seed',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            permissionMode: 'acceptEdits',
            automationDraft: expect.objectContaining({
                enabled: true,
                name: 'PR review',
                everyMinutes: 30,
            }),
        }));
    });

    it('lets contextual temp seed data replace persisted selections while preserving draft content', async () => {
        searchParamsState.value = {
            dataId: 'session-config-seed',
        };
        persistedDraft.input = 'Persisted prompt';
        persistedDraft.selectedMachineId = 'machine-2';
        persistedDraft.selectedPath = '/repo/persisted';
        persistedDraft.agentType = 'claude';
        persistedDraft.permissionMode = 'yolo';
        persistedDraft.resumeSessionId = 'resume-persisted';
        tempSessionDataState.value = {
            prompt: '',
            machineId: 'machine-1',
            directory: '/repo/from-session',
            agentType: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            permissionMode: 'acceptEdits',
            modelMode: 'gpt-5',
            acpSessionModeId: 'plan',
            replacePersistedDraftSelections: true,
        };

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.promptStore.getPrompt()).toBe('Persisted prompt');
        expect(model?.simpleProps?.agentType).toBe('codex');
        expect(model?.simpleProps?.permissionMode).toBe('acceptEdits');
        expect(model?.simpleProps?.selectedPath).toBe('/repo/from-session');
        expect(model?.simpleProps?.machineName).toBe('Machine One');
        expect(model?.simpleProps?.resumeSessionId).toBe('');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                prompt: 'Persisted prompt',
                displayText: 'Persisted prompt',
                agentId: 'codex',
                permissionMode: 'acceptEdits',
                modelId: 'gpt-5',
                acpSessionModeId: 'plan',
                resumeSessionId: null,
            }),
        }));
        expect(loadNewSessionDraftMock).toHaveBeenCalled();
    });

    it('re-hydrates prompt and resume selection coherently when a newer draft is loaded on focus', async () => {
        persistedDraft.input = 'Old persisted prompt';
        persistedDraft.resumeSessionId = 'sess_old';
        persistedDraft.updatedAt = 123;

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.simpleProps?.promptStore.getPrompt()).toBe('Old persisted prompt');
        expect(model?.simpleProps?.resumeSessionId).toBe('sess_old');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                prompt: 'Old persisted prompt',
                displayText: 'Old persisted prompt',
                resumeSessionId: 'sess_old',
            }),
        }));

        persistedDraft.input = 'Focused draft prompt';
        persistedDraft.resumeSessionId = 'sess_new';
        persistedDraft.selectedWorkspaceId = 'ws_payments';
        persistedDraft.selectedWorkspaceLocationId = 'loc_local';
        persistedDraft.selectedWorkspaceCheckoutId = 'checkout_feature_auth';
        persistedDraft.updatedAt = 456;

        const cleanups = await runFocusEffectsAndSettle();
        for (const cleanup of cleanups) {
            if (typeof cleanup === 'function') cleanup();
        }

        expect(model?.simpleProps?.promptStore.getPrompt()).toBe('Focused draft prompt');
        expect(model?.simpleProps?.resumeSessionId).toBe('sess_new');
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                prompt: 'Focused draft prompt',
                displayText: 'Focused draft prompt',
                resumeSessionId: 'sess_new',
            }),
        }));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            input: 'Focused draft prompt',
            resumeSessionId: 'sess_new',
        }));
    });

    it('does not invalidate the screen model when focus reloads an equivalent draft', async () => {
        let model: any = null;
        let renderCount = 0;

        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
            renderCount += 1;
        });

        const renderedCount = renderCount;

        const cleanups = await runFocusEffectsAndSettle();
        for (const cleanup of cleanups) {
            if (typeof cleanup === 'function') cleanup();
        }

        expect(loadNewSessionDraftMock).toHaveBeenCalled();
        expect(renderCount).toBeLessThanOrEqual(renderedCount + 1);
    });

    it('hydrates mcpSelection into the MCP chip flow and persists it with the draft', async () => {
        featureFlags.mcpServersEnabled = true;
        saveNewSessionDraftMock.mockClear();
        machineMcpServersPreviewMock.mockClear();
        persistDraftNowRef.current = null;

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(machineMcpServersPreviewMock).toHaveBeenCalledWith(
            'machine-2',
            expect.objectContaining({
                agentId: 'claude',
                directory: '/repo/custom',
                selection: expect.objectContaining({
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-portable'],
                    forceExcludeServerIds: ['server-disabled'],
                }),
            }),
            expect.anything(),
        );
        expect(Array.isArray(model?.simpleProps?.agentInputExtraActionChips)).toBe(true);
        expect(model?.simpleProps?.agentInputExtraActionChips.some((chip: any) => chip?.key === 'new-session-mcp')).toBe(true);
        expect(model?.simpleProps?.agentInputExtraActionChips.find((chip: any) => chip?.key === 'new-session-mcp')?.controlId).toBe('mcp');

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledWith(expect.objectContaining({
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-portable'],
                forceExcludeServerIds: ['server-disabled'],
            },
        }));

        featureFlags.mcpServersEnabled = false;
    });

    it('persists canonical inferred workspace selection in autosaved drafts', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        const Probe = () => { useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.not.objectContaining({
            selectedWorkspaceId: expect.anything(),
            selectedWorkspaceLocationId: expect.anything(),
            selectedWorkspaceCheckoutId: expect.anything(),
        }));
        const latestDraft = saveNewSessionDraftMock.mock.calls.at(-1)?.[0];
        expect(latestDraft).toBeTruthy();
        expect('sessionType' in (latestDraft as Record<string, unknown>)).toBe(false);
    });

    it('persists the canonical authoring draft before opening profile edit', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        persistedDraft.backendTarget = { kind: 'builtInAgent', agentId: 'claude' };

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(model?.variant).toBe('wizard');
        expect(typeof model?.wizardProps?.profiles?.openProfileEdit).toBe('function');

        await act(async () => {
            model?.wizardProps?.profiles?.openProfileEdit?.({});
            await flushInteractionQueue();
        });

        expect(routerPushMock).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new/pick/profile-edit',
            params: expect.objectContaining({
                machineId: 'machine-2',
            }),
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            selectedMachineId: 'machine-2',
            selectedPath: '/repo/custom',
        }));
        expect(saveNewSessionDraftMock.mock.calls.at(-1)?.[0]).toEqual(expect.not.objectContaining({
            selectedWorkspaceId: expect.anything(),
            selectedWorkspaceLocationId: expect.anything(),
            selectedWorkspaceCheckoutId: expect.anything(),
        }));
    });

    it('keeps the current route stable and exposes a shared resume popover in the simple panel when resume is available', async () => {
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(model?.simpleProps?.showResumePicker).toBe(true);
        expect(typeof model?.simpleProps?.resumePopover?.renderContent).toBe('function');
        expect(routerSetParamsMock).not.toHaveBeenCalled();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('opens the shared resume browser modal on iOS instead of pushing a picker route', async () => {
        platformOsState.value = 'ios';
        modalShowMock.mockReset();
        routerPushMock.mockReset();

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        const content = model?.simpleProps?.resumePopover?.renderContent?.({
            requestClose: () => {},
        });
        expect(content).toBeTruthy();

        const resumeScreen = await renderScreen(content);

        await act(async () => {
            await resumeScreen.pressByTestIdAsync('resume-id-browse-trigger');
        });

        expect(modalShowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('keeps the profile picker on the current route and exposes a shared profile popover in the simple panel', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = false;

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(typeof model?.simpleProps?.profilePopover?.renderContent).toBe('function');
        expect(routerSetParamsMock).not.toHaveBeenCalled();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('drops already-queued profile-edit draft persistence after draft persistence is disabled and cleared', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            model?.wizardProps?.profiles?.openProfileEdit?.({});
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(routerPushMock).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new/pick/profile-edit',
        }));
        expect(saveNewSessionDraftMock).toHaveBeenCalledTimes(0);

        await act(async () => {
            (useCreateNewSessionArgsRef.current?.disableDraftPersistence as (() => void) | undefined)?.();
            clearNewSessionDraftMock();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await act(async () => {
            await flushInteractionQueue();
        });

        expect(clearNewSessionDraftMock).toHaveBeenCalledTimes(1);
        expect(saveNewSessionDraftMock).toHaveBeenCalledTimes(0);
    });

    it('persists a launch draft with the legacy unscoped key when the active account scope is cleared', async () => {
        activeServerAccountScopeState.value = null;
        loadNewSessionDraftMock.mockReturnValueOnce(null);

        let model: any = null;
        await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        await act(async () => {
            model?.simpleProps?.setPrompt?.('draft after logout');
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        await act(async () => {
            persistDraftNowRef.current?.();
        });

        expect(saveNewSessionDraftMock).toHaveBeenCalledTimes(1);
        expect(clearNewSessionDraftMock).toHaveBeenCalledTimes(0);
    });

    it('keeps the default environment selected even when a workspace graph still carries a legacy default profile', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        settingsState.profiles = [
            makeTestProfile({ id: 'profile_workspace', title: 'Workspace profile', compatibility: { claude: true } }),
        ];
        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(model?.variant).toBe('wizard');
        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();
        expect(model?.wizardProps?.profiles?.getProfileSubtitleExtra?.({ id: 'profile_workspace' })).toBeNull();
        expect(model?.wizardProps?.profiles?.getProfileSubtitleExtra?.({ id: 'profile_other' })).toBeNull();

        await act(async () => {
            model?.wizardProps?.profiles?.onPressDefaultEnvironment?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();
    });

    it('does not reseed profile selection from legacy workspace defaults after clearing back to the default environment', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        settingsState.profiles = [
            makeTestProfile({ id: 'profile_workspace', title: 'Workspace profile', compatibility: { claude: true } }),
            makeTestProfile({ id: 'profile_docs', title: 'Docs profile', compatibility: { claude: true } }),
        ];
        workspaceGraphState.workspacesByServerId['server-a'] = [
            makeTestWorkspace({
                id: 'ws_payments',
                displayName: 'Payments',
                locationIds: ['loc_local'],
                checkoutIds: ['checkout_feature_auth'],
                defaultLocationId: 'loc_local',
                defaultCheckoutId: 'checkout_feature_auth',
            }),
            makeTestWorkspace({
                id: 'ws_docs',
                displayName: 'Docs',
                locationIds: ['loc_docs'],
                checkoutIds: ['checkout_docs_main'],
                defaultLocationId: 'loc_docs',
                defaultCheckoutId: 'checkout_docs_main',
            }),
        ];
        workspaceGraphState.workspaceLocations.loc_docs = makeTestWorkspaceLocation({
            id: 'loc_docs',
            workspaceId: 'ws_docs',
            machineId: 'machine-2',
            path: '/repo/docs',
        });
        workspaceGraphState.workspaceCheckouts.checkout_docs_main = makeTestWorkspaceCheckout({
            id: 'checkout_docs_main',
            workspaceId: 'ws_docs',
            workspaceLocationId: 'loc_docs',
            path: '/repo/docs',
            displayName: 'docs-main',
        });

        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();

        await act(async () => {
            model?.wizardProps?.profiles?.onPressDefaultEnvironment?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();

        searchParamsState.value = {
            machineId: 'machine-2',
            path: '/repo/docs',
        };

        await hook.rerender();

        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();
        expect(model?.wizardProps?.profiles?.getProfileSubtitleExtra?.({ id: 'profile_docs' })).toBeNull();
        expect(model?.wizardProps?.profiles?.getProfileSubtitleExtra?.({ id: 'profile_workspace' })).toBeNull();
    });

    it('shows a not-logged-in subtitle for profiles whose only backend auth is logged out', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        settingsState.lastUsedAgent = 'codex';
        settingsState.profiles = [
            makeTestProfile({ id: 'profile-1', title: 'Profile One', compatibility: { codex: true, claude: false } }),
        ];
        cliDetectionState.value = {
            timestamp: 1,
            available: { claude: true, codex: true },
            authStatus: {
                codex: { state: 'logged_out', checkedAt: 1 },
            },
        } as any;

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(model?.wizardProps?.profiles?.getProfileSubtitleExtra?.({ id: 'profile-1' })).toBe('profiles.machineLogin.status.notLoggedIn');
    });

    it('rejects a profile route param when the profile is not selectable in the current backend set', async () => {
        settingsState.useProfiles = true;
        settingsState.useEnhancedSessionWizard = true;
        settingsState.profiles = [
            makeTestProfile({ id: 'profile-1', title: 'Profile One', compatibility: { codex: false, claude: false } }),
        ];
        searchParamsState.value = {
            profileId: 'profile-1',
        };

        const { useNewSessionScreenModel } = await useNewSessionScreenModelModulePromise;

        let model: any = null;
        const Probe = () => { model = useNewSessionScreenModel(); return null; };

        await renderScreen(React.createElement(Probe));

        expect(model?.wizardProps?.profiles?.selectedProfileId).toBeNull();
        expect(routerSetParamsMock).toHaveBeenCalledWith({ profileId: undefined });
    });

});
