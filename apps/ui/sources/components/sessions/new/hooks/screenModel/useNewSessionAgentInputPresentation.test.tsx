import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, flushHookEffects, act } from '@/dev/testkit';
import { clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope, captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { Router } from 'expo-router';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { canAttemptMachineSpawn, resolveMachineSpawnReadiness, type MachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const sessionAgentInputTheme = {
    colors: {
        state: {
            success: { foreground: '#0f0' },
            danger: { foreground: '#f00' },
        },
    },
} as const;

const network = await installSessionOpsNetworkBoundary();
const scope = { serverId: 'srv', accountId: 'presentation-account' };
beforeEach(async () => {
    clearMachineRequestReachabilityForTest();
    network.resetRequests();
    await network.addHome('https://srv', scope.accountId);
});
afterAll(() => network.dispose());

// Load the real graph during collection, not inside the first hook's timeout.
await import('./useNewSessionAgentInputPresentation');

describe('useNewSessionAgentInputPresentation', () => {
    function createRouter(): Router {
        const routerMock = createExpoRouterMock();
        return {
            back: () => routerMock.state.router.back(),
            canGoBack: vi.fn(() => false),
            push: (value: any) => routerMock.state.router.push(value),
            navigate: vi.fn<Router['navigate']>(),
            replace: (value: any) => routerMock.state.router.replace(value),
            dismiss: vi.fn<Router['dismiss']>(),
            dismissTo: vi.fn<Router['dismissTo']>(),
            dismissAll: vi.fn<Router['dismissAll']>(),
            canDismiss: vi.fn(() => false),
            setParams: vi.fn() as any,
            reload: vi.fn<Router['reload']>(),
            prefetch: vi.fn<Router['prefetch']>(),
        } as unknown as Router;
    }

    it('stays quiet for an online machine, even while exact spawn readiness is unknown, and speaks only when it cannot start', async () => {
        const { useNewSessionAgentInputPresentation } = await import('./useNewSessionAgentInputPresentation');
        let machine: Machine | null = {
            id: 'm1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: {
                host: 'host-1',
                displayName: 'Host one',
                homeDir: '/home/me',
                platform: 'darwin',
                happyHomeDir: '/home/me/.happier',
                happyCliVersion: '0.0.0-test',
            },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };
        let readiness: MachineSpawnReadiness = { status: 'unknown', machineId: 'm1' };
        let selectedMachineId: string | null = 'm1';

        const hook = await renderHook(() => useNewSessionAgentInputPresentation({
            theme: {
                colors: {
                    state: {
                        success: { foreground: 'success' },
                        danger: { foreground: 'danger' },
                    },
                },
            },
            selectedMachine: machine,
            selectedMachineSpawnReadiness: readiness,
            automationFeatureEnabled: false,
            automationDraft: {
                enabled: false,
                name: '',
                description: '',
                triggers: [{
                    clientId: 'schedule-half-hourly',
                    definition: {
                        kind: 'schedule',
                        enabled: true,
                        schedule: { kind: 'interval', scheduleExpr: null, everyMs: 30 * 60_000, timezone: null },
                    },
                }],
            },
            onOpenAutomationEditor: vi.fn(),
            repoScmSnapshot: null,
            checkoutChipModel: {
                selectedOptionId: 'current_path',
                options: [{ id: 'current_path', kind: 'current_path', path: '/repo' }],
            },
            checkoutPickerOpen: false,
            setCheckoutPickerOpen: vi.fn(),
            checkoutCreationDraft: null,
            selectedMachineId,
            selectedPath: '/repo',
            setSelectedPath: vi.fn(),
            setCheckoutCreationDraft: vi.fn(),
            pendingGitWorktreeBaseRefRef: { current: null },
            pendingGitWorktreeSourceKindRef: { current: 'current' },
            shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: false },
            router: createRouter(),
            promptStore: createNewSessionPromptStore(''),
            setSessionPrompt: vi.fn(),
            handleCreateSession: vi.fn(),
            backendTarget: { kind: 'backend', backendId: 'claude' },
            agentType: 'claude',
            staticAgentId: 'claude',
            runtimeCarrierAgentId: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: false,
            showServerPickerChip: false,
            targetServerId: 'srv',
            targetServerName: 'Server A',
            capabilitiesChip: null,
            externalSessionsFeatureEnabled: false,
            supportsDirectTranscriptStorage: false,
            transcriptStorage: 'persisted',
            hasUserSelectedTranscriptStorageRef: { current: false },
            setTranscriptStorage: vi.fn(),
            selectedMachineIsWindows: false,
            effectiveWindowsRemoteSessionLaunchMode: null,
            windowsTerminalAvailable: false,
            setWindowsRemoteSessionLaunchModeOverride: vi.fn(),
        }));

        // A ready machine is named by its chip; healthy state says nothing above the card.
        expect(hook.getCurrent().connectionStatus).toBeUndefined();
        expect(canAttemptMachineSpawn({ scope, selectedMachineId, machine, spawnReadiness: readiness })).toBe(true);
        // Presence can recover before the earlier capabilities/readiness snapshot.
        readiness = { status: 'offline', machineId: 'm1' };
        await hook.rerender();
        expect(hook.getCurrent().connectionStatus).toBeUndefined();
        expect(canAttemptMachineSpawn({ scope, selectedMachineId, machine, spawnReadiness: readiness })).toBe(true);
        // Conversely, a cached ready result must not override current withdrawal.
        readiness = { status: 'ready', machineId: 'm1' };
        await act(async () => withdrawMachinePresenceForScope(scope));
        expect(hook.getCurrent().connectionStatus?.text).toBe('newSession.machineUnavailableStatus');
        expect(canAttemptMachineSpawn({ scope, selectedMachineId, machine, spawnReadiness: readiness })).toBe(false);
        await act(async () => captureMachinePresenceObservation(scope)([machine!.id]));
        expect(hook.getCurrent().connectionStatus).toBeUndefined();
        machine = { ...machine!, active: false, activeAt: 0 };
        await hook.rerender();
        expect(hook.getCurrent().connectionStatus?.text).toBe('newSession.machineOfflineInlineTitle');
        expect(canAttemptMachineSpawn({ scope, selectedMachineId, machine, spawnReadiness: readiness })).toBe(false);
        machine = { ...machine, active: true, activeAt: Date.now() };
        readiness = resolveMachineSpawnReadiness({ scope, selectedMachineId: 'm1', machine, keyAvailable: false, rpcAvailable: true });
        await hook.rerender();
        expect(hook.getCurrent().connectionStatus).toMatchObject({
            text: 'machineRequester.keyPending(machine=Host one)', isPulsing: false, recovery: 'machine',
        });
        expect(canAttemptMachineSpawn({ scope, selectedMachineId: 'm1', machine, spawnReadiness: readiness })).toBe(false);
        // A machine whose details this device cannot read is "this machine" in the sentence, never its raw id.
        const readableMachine = machine;
        machine = { ...machine, metadata: null, availability: { kind: 'locked', reason: 'encryption_material_unavailable' } } as unknown as Machine;
        readiness = resolveMachineSpawnReadiness({ scope, selectedMachineId: 'm1', machine, keyAvailable: false, rpcAvailable: true });
        await hook.rerender();
        expect(hook.getCurrent().connectionStatus?.text).toBe('machineRequester.keyPending(machine=machine.thisMachineInSentence)');
        machine = readableMachine;
        readiness = resolveMachineSpawnReadiness({ scope, selectedMachineId: 'm1', machine, keyAvailable: false, rpcAvailable: true });
        machine = { ...machine, active: false, activeAt: 0 };
        readiness = resolveMachineSpawnReadiness({ scope, selectedMachineId: 'm1', machine, keyAvailable: false, rpcAvailable: true });
        await hook.rerender();
        expect(hook.getCurrent().connectionStatus).toMatchObject({ text: 'newSession.machineOfflineInlineTitle', dotColor: 'danger' });
        expect(canAttemptMachineSpawn({ scope, selectedMachineId, machine, spawnReadiness: readiness })).toBe(false);
        machine = null;
        await hook.rerender();
        expect(hook.getCurrent().connectionStatus).toMatchObject({
            text: 'newSession.machineUnavailableStatus', isPulsing: false, recovery: 'machine',
        });
        selectedMachineId = null;
        readiness = resolveMachineSpawnReadiness({ scope, selectedMachineId, machine });
        await hook.rerender();
        expect(hook.getCurrent().connectionStatus).toBeUndefined();
        expect(canAttemptMachineSpawn({ scope, selectedMachineId, machine, spawnReadiness: readiness })).toBe(false);
        await hook.unmount();
    });

    it('keeps connection status stable when only machine heartbeat timestamps change', async () => {
        const { useNewSessionAgentInputPresentation } = await import('./useNewSessionAgentInputPresentation');
        const router = createRouter();
        let activeAt = Date.now();
        let contentLabel = 'First account';
        const makeMcpChip = () => {
            const capturedLabel = contentLabel;
            return { key: 'new-session-mcp', render: () => null,
                collapsedContentPopover: { title: 'MCP', renderContent: () => capturedLabel } };
        };
        let capabilitiesChip = makeMcpChip();
        let initialParams: Parameters<typeof useNewSessionAgentInputPresentation>[0] = {
            theme: {
                colors: {
                    state: {
                        success: { foreground: 'success' },
                        danger: { foreground: 'danger' },
                    },
                },
            },
            selectedMachine: {
                id: 'm1',
                seq: 1,
                createdAt: 1,
                updatedAt: activeAt,
                active: true,
                activeAt,
                revokedAt: null,
                metadata: {
                    host: 'host-1',
                    homeDir: '/home/me',
                    platform: 'darwin',
                    happyHomeDir: '/home/me/.happier',
                    happyCliVersion: '0.0.0-test',
                },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
            },
            // A line that speaks (the key is still on its way), so its identity is worth keeping.
            selectedMachineSpawnReadiness: { status: 'keyUnavailable', machineId: 'm1' },
            automationFeatureEnabled: false,
            automationDraft: {
                enabled: false,
                name: '',
                description: '',
                triggers: [{
                    clientId: 'schedule-half-hourly',
                    definition: {
                        kind: 'schedule',
                        enabled: true,
                        schedule: { kind: 'interval', scheduleExpr: null, everyMs: 30 * 60_000, timezone: null },
                    },
                }],
            },
            onOpenAutomationEditor: vi.fn(),
            repoScmSnapshot: null,
            checkoutChipModel: {
                selectedOptionId: 'current_path',
                options: [{ id: 'current_path', kind: 'current_path', path: '/repo' }],
            },
            checkoutPickerOpen: false,
            setCheckoutPickerOpen: vi.fn(),
            checkoutCreationDraft: null,
            selectedMachineId: 'm1',
            selectedPath: '/repo',
            setSelectedPath: vi.fn(),
            setCheckoutCreationDraft: vi.fn(),
            pendingGitWorktreeBaseRefRef: { current: null },
            pendingGitWorktreeSourceKindRef: { current: 'current' },
            shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: false },
            router,
            promptStore: createNewSessionPromptStore(''),
            setSessionPrompt: vi.fn(),
            handleCreateSession: vi.fn(),
            backendTarget: { kind: 'backend', backendId: 'claude' },
            agentType: 'claude',
            staticAgentId: 'claude',
            runtimeCarrierAgentId: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: false,
            showServerPickerChip: false,
            targetServerId: 'srv',
            targetServerName: 'Server A',
            capabilitiesChip,
            externalSessionsFeatureEnabled: false,
            supportsDirectTranscriptStorage: false,
            transcriptStorage: 'persisted',
            hasUserSelectedTranscriptStorageRef: { current: false },
            setTranscriptStorage: vi.fn(),
            selectedMachineIsWindows: false,
            effectiveWindowsRemoteSessionLaunchMode: null,
            windowsTerminalAvailable: false,
            setWindowsRemoteSessionLaunchModeOverride: vi.fn(),
        };
        const renderPresentation = () => useNewSessionAgentInputPresentation({ ...initialParams,
            selectedMachine: initialParams.selectedMachine ? { ...initialParams.selectedMachine, activeAt, updatedAt: activeAt } : null,
            capabilitiesChip });

        const hook = await renderHook(renderPresentation, {
            flushOptions: { cycles: 1, turns: 4 },
        });
        const firstConnectionStatus = hook.getCurrent().connectionStatus;
        const firstChips = hook.getCurrent().agentInputExtraActionChips;

        activeAt += 1000;
        await hook.rerender();

        expect(firstConnectionStatus).toBeDefined();
        expect(hook.getCurrent().connectionStatus).toBe(firstConnectionStatus);
        expect(hook.getCurrent().agentInputExtraActionChips).toBe(firstChips);
        contentLabel = 'Second account';
        capabilitiesChip = makeMcpChip();
        await hook.rerender();
        const updatedChip = hook.getCurrent().agentInputExtraActionChips.find(chip => chip.key === 'new-session-mcp');
        const renderContent = updatedChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected current MCP popover content');
        expect(renderContent({ requestClose: vi.fn(), maxHeight: 300 })).toBe('Second account');
        expect(hook.getCurrent().agentInputExtraActionChips).not.toBe(firstChips);
        activeAt = 0;
        initialParams = { ...initialParams, selectedMachine: { ...initialParams.selectedMachine!, active: false,
            managedInputRuntime: { nativeReady: false, wakeState: 'asleep', newSessionWake: { kind: 'available' } } } };
        await hook.rerender();
        expect(hook.getCurrent().connectionStatus?.text).toBe('managedWake.startsOnSend');
        expect(hook.getCurrent().connectionStatus?.recovery).toBeUndefined();
        await hook.unmount();
    });

    it('exposes automation controls via an action chip (no inline automation section)', async () => {
        const { useNewSessionAgentInputPresentation } = await import('./useNewSessionAgentInputPresentation');
        const routerMock = createExpoRouterMock();
        const router = {
            back: () => routerMock.state.router.back(),
            canGoBack: vi.fn(() => false),
            push: (value: any) => routerMock.state.router.push(value),
            navigate: vi.fn<Router['navigate']>(),
            replace: (value: any) => routerMock.state.router.replace(value),
            dismiss: vi.fn<Router['dismiss']>(),
            dismissTo: vi.fn<Router['dismissTo']>(),
            dismissAll: vi.fn<Router['dismissAll']>(),
            canDismiss: vi.fn(() => false),
            setParams: vi.fn() as any,
            reload: vi.fn<Router['reload']>(),
            prefetch: vi.fn<Router['prefetch']>(),
        } as unknown as Router;

        const hook = await renderHook(() => useNewSessionAgentInputPresentation({
            theme: {
                colors: {
                    state: {
                        success: { foreground: '#0f0' },
                        danger: { foreground: '#f00' },
                    },
                },
            },
            selectedMachine: null,
            automationFeatureEnabled: true,
            automationDraft: {
                enabled: true,
                name: 'Nightly',
                description: 'Run nightly work',
                triggers: [{
                    clientId: 'schedule-half-hourly',
                    definition: {
                        kind: 'schedule',
                        enabled: true,
                        schedule: { kind: 'interval', scheduleExpr: null, everyMs: 30 * 60_000, timezone: null },
                    },
                }],
            },
            onOpenAutomationEditor: vi.fn(),
            repoScmSnapshot: null,
            checkoutChipModel: {
                selectedOptionId: 'current_path',
                options: [{ id: 'current_path', kind: 'current_path', path: '/repo' }],
            },
            checkoutPickerOpen: false,
            setCheckoutPickerOpen: vi.fn(),
            checkoutCreationDraft: null,
            selectedMachineId: null,
            selectedPath: '/repo',
            setSelectedPath: vi.fn(),
            setCheckoutCreationDraft: vi.fn(),
            pendingGitWorktreeBaseRefRef: { current: null },
            pendingGitWorktreeSourceKindRef: { current: 'current' },
            shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: false },
            router,
            promptStore: createNewSessionPromptStore(''),
            setSessionPrompt: vi.fn(),
            handleCreateSession: vi.fn(),
            backendTarget: { kind: 'backend', backendId: 'claude' },
            agentType: 'claude',
            staticAgentId: 'claude',
            runtimeCarrierAgentId: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: true,
            showServerPickerChip: false,
            targetServerId: null,
            targetServerName: 'Server A',
            capabilitiesChip: null,
            externalSessionsFeatureEnabled: false,
            supportsDirectTranscriptStorage: false,
            transcriptStorage: 'persisted',
            hasUserSelectedTranscriptStorageRef: { current: false },
            setTranscriptStorage: vi.fn(),
            selectedMachineIsWindows: false,
            effectiveWindowsRemoteSessionLaunchMode: null,
            windowsTerminalAvailable: false,
            setWindowsRemoteSessionLaunchModeOverride: vi.fn(),
        }));

        expect(hook.getCurrent().agentInputExtraActionChips.some((chip) => chip.key === 'new-session-automate')).toBe(true);
    });

    it('adds a link-file chip that appends the selected file path into the draft prompt', async () => {
        const { useNewSessionAgentInputPresentation } = await import('./useNewSessionAgentInputPresentation');
        const routerMock = createExpoRouterMock();
        let currentPrompt = 'hello';
        const setSessionPromptSpy = vi.fn();
        const setSessionPrompt: React.Dispatch<React.SetStateAction<string>> = (next) => {
            setSessionPromptSpy(next);
            if (typeof next === 'function') {
                // Emulate a "string-only" setter (common wrapper pattern) that ignores functional updates.
                // The new-session link-file chip must still work in this scenario.
                return;
            }
            currentPrompt = next;
        };

        const router = {
            back: () => routerMock.state.router.back(),
            canGoBack: vi.fn(() => false),
            push: (value: any) => routerMock.state.router.push(value),
            navigate: vi.fn<Router['navigate']>(),
            replace: (value: any) => routerMock.state.router.replace(value),
            dismiss: vi.fn<Router['dismiss']>(),
            dismissTo: vi.fn<Router['dismissTo']>(),
            dismissAll: vi.fn<Router['dismissAll']>(),
            canDismiss: vi.fn(() => false),
            setParams: vi.fn() as any,
            reload: vi.fn<Router['reload']>(),
            prefetch: vi.fn<Router['prefetch']>(),
        } as unknown as Router;

        const hook = await renderHook(() => useNewSessionAgentInputPresentation({
            theme: {
                colors: {
                    state: {
                        success: { foreground: '#0f0' },
                        danger: { foreground: '#f00' },
                    },
                },
            },
            selectedMachine: null,
            automationFeatureEnabled: true,
            automationDraft: {
                enabled: false,
                name: '',
                description: '',
                triggers: [{
                    clientId: 'schedule-half-hourly',
                    definition: {
                        kind: 'schedule',
                        enabled: true,
                        schedule: { kind: 'interval', scheduleExpr: null, everyMs: 30 * 60_000, timezone: null },
                    },
                }],
            },
            onOpenAutomationEditor: vi.fn(),
            repoScmSnapshot: null,
            checkoutChipModel: {
                selectedOptionId: 'current_path',
                options: [{ id: 'current_path', kind: 'current_path', path: '/repo' }],
            },
            checkoutPickerOpen: false,
            setCheckoutPickerOpen: vi.fn(),
            checkoutCreationDraft: null,
            selectedMachineId: 'm1',
            selectedPath: '/repo',
            setSelectedPath: vi.fn(),
            setCheckoutCreationDraft: vi.fn(),
            pendingGitWorktreeBaseRefRef: { current: null },
            pendingGitWorktreeSourceKindRef: { current: 'current' },
            shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: false },
            router,
            promptStore: createNewSessionPromptStore('hello'),
            setSessionPrompt,
            handleCreateSession: vi.fn(),
            backendTarget: { kind: 'backend', backendId: 'claude' },
            agentType: 'claude',
            staticAgentId: 'claude',
            runtimeCarrierAgentId: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: false,
            showServerPickerChip: false,
            targetServerId: 'srv',
            targetServerName: 'Server A',
            capabilitiesChip: null,
            externalSessionsFeatureEnabled: false,
            supportsDirectTranscriptStorage: false,
            transcriptStorage: 'persisted',
            hasUserSelectedTranscriptStorageRef: { current: false },
            setTranscriptStorage: vi.fn(),
            selectedMachineIsWindows: false,
            effectiveWindowsRemoteSessionLaunchMode: null,
            windowsTerminalAvailable: false,
            setWindowsRemoteSessionLaunchModeOverride: vi.fn(),
        }));

        const chip = hook.getCurrent().agentInputExtraActionChips.find((c) => c.key === 'new-session-link-file');
        expect(chip).toBeTruthy();

        // New-session link-file must behave like the existing-session chip: it opens a popover with a file browser,
        // not a separate modal or an extra "Link file" button inside the popover.
        expect(chip?.collapsedAction).toBeUndefined();
        expect(chip?.collapsedContentPopover).toBeTruthy();
        if (!chip?.collapsedContentPopover) {
            throw new Error('Expected link-file chip to define collapsedContentPopover');
        }
        // The file browser owns its virtualized list scrolling; the outer popover must not add a ScrollView.
        expect(chip.collapsedContentPopover.scrollEnabled).toBe(false);
        const renderContent = chip.collapsedContentPopover.renderContent;
        if (typeof renderContent !== 'function') {
            throw new Error('Expected collapsedContentPopover.renderContent to be a function');
        }

        const contentNode = renderContent({ requestClose: vi.fn(), maxHeight: 300 });
        if (!React.isValidElement(contentNode)) {
            throw new Error('Expected link-file popover content to be a React element');
        }

        const { LinkFilePickerPopoverContent } = await import('@/components/sessions/linkedFiles/projectPicker/LinkFilePickerPopoverContent');
        expect(contentNode.type).toBe(LinkFilePickerPopoverContent);
        const { onPickPath } = contentNode.props as { onPickPath: (path: string) => void };
        expect(typeof onPickPath).toBe('function');

        onPickPath('/repo/file.ts');

        expect(setSessionPromptSpy).toHaveBeenCalled();
        const arg = setSessionPromptSpy.mock.calls.at(-1)?.[0];
        expect(typeof arg).toBe('string');
        expect(currentPrompt).toBe('hello @file.ts ');

        // The link-file chip must render a visible interactive chip in the action bar (not only an action-menu item).
        setSessionPromptSpy.mockClear();

        const toggleCollapsedPopover = vi.fn();
        const chipUi = chip!.render({
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: { current: null },
            popoverAnchorRef: { current: null },
            toggleCollapsedPopover,
        });
        if (!React.isValidElement(chipUi)) {
            throw new Error('Expected chip renderer to return an element');
        }
        const screen = await renderScreen(chipUi);
        expect(screen.findByTestId('new-session-link-file-chip')).toBeTruthy();

        await screen.pressByTestIdAsync('new-session-link-file-chip');
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-link-file');
    });

    it('keeps extra action chips stable when only the draft prompt changes', async () => {
        const { useNewSessionAgentInputPresentation } = await import('./useNewSessionAgentInputPresentation');
        const routerMock = createExpoRouterMock();
        const router = {
            back: () => routerMock.state.router.back(),
            canGoBack: vi.fn(() => false),
            push: (value: any) => routerMock.state.router.push(value),
            navigate: vi.fn<Router['navigate']>(),
            replace: (value: any) => routerMock.state.router.replace(value),
            dismiss: vi.fn<Router['dismiss']>(),
            dismissTo: vi.fn<Router['dismissTo']>(),
            dismissAll: vi.fn<Router['dismissAll']>(),
            canDismiss: vi.fn(() => false),
            setParams: vi.fn() as any,
            reload: vi.fn<Router['reload']>(),
            prefetch: vi.fn<Router['prefetch']>(),
        } as unknown as Router;
        const promptStore = createNewSessionPromptStore('');
        const setSessionPrompt = vi.fn((next: string | ((previous: string) => string)) => {
            promptStore.setPrompt(next);
        });

        // A prompt-only edit keeps the actual chip operands and callbacks stable.
        const presentationParams: Parameters<typeof useNewSessionAgentInputPresentation>[0] = {
            theme: sessionAgentInputTheme,
            selectedMachine: null,
            automationFeatureEnabled: false,
            automationDraft: {
                enabled: false,
                name: '',
                description: '',
                triggers: [{
                    clientId: 'schedule-half-hourly',
                    definition: {
                        kind: 'schedule',
                        enabled: true,
                        schedule: { kind: 'interval', scheduleExpr: null, everyMs: 30 * 60_000, timezone: null },
                    },
                }],
            },
            onOpenAutomationEditor: vi.fn(),
            repoScmSnapshot: null,
            checkoutChipModel: {
                selectedOptionId: 'current_path',
                options: [{ id: 'current_path', kind: 'current_path', path: '/repo' }],
            },
            checkoutPickerOpen: false,
            setCheckoutPickerOpen: vi.fn(),
            checkoutCreationDraft: null,
            selectedMachineId: 'm1',
            selectedPath: '/repo',
            setSelectedPath: vi.fn(),
            setCheckoutCreationDraft: vi.fn(),
            pendingGitWorktreeBaseRefRef: { current: null },
            pendingGitWorktreeSourceKindRef: { current: 'current' },
            shouldReconcileInitialHydratedCheckoutCreationDraftRef: { current: false },
            router,
            promptStore,
            setSessionPrompt,
            handleCreateSession: vi.fn(),
            backendTarget: { kind: 'backend', backendId: 'claude' },
            agentType: 'claude',
            staticAgentId: 'claude',
            runtimeCarrierAgentId: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: false,
            showServerPickerChip: false,
            targetServerId: 'srv',
            targetServerName: 'Server A',
            capabilitiesChip: null,
            externalSessionsFeatureEnabled: false,
            supportsDirectTranscriptStorage: false,
            transcriptStorage: 'persisted',
            hasUserSelectedTranscriptStorageRef: { current: false },
            setTranscriptStorage: vi.fn(),
            selectedMachineIsWindows: false,
            effectiveWindowsRemoteSessionLaunchMode: null,
            windowsTerminalAvailable: false,
            setWindowsRemoteSessionLaunchModeOverride: vi.fn(),
        };
        const renderPresentation = () => useNewSessionAgentInputPresentation(presentationParams);

        const hook = await renderHook(renderPresentation, {
            flushOptions: { cycles: 1, turns: 4 },
        });
        const firstChips = hook.getCurrent().agentInputExtraActionChips;

        promptStore.setPrompt('hello');
        await hook.rerender();

        expect(hook.getCurrent().agentInputExtraActionChips).toBe(firstChips);

        const linkFileChip = firstChips.find((chip) => chip.key === 'new-session-link-file');
        const renderContent = linkFileChip?.collapsedContentPopover?.renderContent;
        if (typeof renderContent !== 'function') {
            throw new Error('Expected link-file chip to expose popover content');
        }
        const contentNode = renderContent({
            requestClose: vi.fn(),
            maxHeight: 300,
        });
        if (!React.isValidElement(contentNode)) {
            throw new Error('Expected link-file popover content to be a React element');
        }
        const { onPickPath } = contentNode.props as { onPickPath: (path: string) => void };
        onPickPath('/repo/file.ts');

        expect(promptStore.getPrompt()).toBe('hello @file.ts ');
    });
});
