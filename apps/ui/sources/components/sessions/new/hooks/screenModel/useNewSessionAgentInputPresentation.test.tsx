import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, flushHookEffects } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { Router } from 'expo-router';
import type { Machine } from '@/sync/domains/state/storageTypes';

vi.mock('react-native-reanimated', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module/index.js', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module/index', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module/publicGlobals', () => ({ __esModule: true }));
vi.mock('react-native-reanimated/lib/module/publicGlobals.js', () => ({ __esModule: true }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => ({}),
        },
    });
});

vi.mock('@/components/sessions/linkedFiles/projectPicker/LinkFilePickerPopoverContent', () => ({
    LinkFilePickerPopoverContent: (props: Record<string, unknown>) => React.createElement('LinkFilePickerPopoverContent', props),
}));

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: (props: Record<string, unknown>) => React.createElement('OptionPickerOverlay', props),
}));

const sessionAgentInputTheme = {
    colors: {
        state: {
            success: { foreground: '#0f0' },
            danger: { foreground: '#f00' },
        },
    },
} as const;

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

    it('keeps connection status online while exact spawn readiness is unknown for an online machine', async () => {
        const { useNewSessionAgentInputPresentation } = await import('./useNewSessionAgentInputPresentation');
        const machine: Machine = {
            id: 'm1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: Date.now(),
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
        };

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
            selectedMachineSpawnReadiness: { status: 'unknown', machineId: 'm1' },
            automationFeatureEnabled: false,
            automationDraft: {
                enabled: false,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            },
            effectiveAutomationDraft: {
                enabled: false,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            },
            setAutomationDraft: vi.fn(),
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
            router: createRouter(),
            sessionPrompt: '',
            setSessionPrompt: vi.fn(),
            handleCreateSession: vi.fn(),
            backendTarget: { kind: 'backend', backendId: 'claude' },
            agentType: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: false,
            showServerPickerChip: false,
            targetServerId: 'srv',
            targetServerName: 'Server A',
            mcpChip: null,
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

        expect(hook.getCurrent().connectionStatus).toMatchObject({
            text: 'status.online',
            color: 'success',
            dotColor: 'success',
            isPulsing: true,
        });
    });

    it('keeps connection status stable when only machine heartbeat timestamps change', async () => {
        const { useNewSessionAgentInputPresentation } = await import('./useNewSessionAgentInputPresentation');
        const router = createRouter();
        let activeAt = Date.now();
        const renderPresentation = () => useNewSessionAgentInputPresentation({
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
            selectedMachineSpawnReadiness: { status: 'unknown', machineId: 'm1' },
            automationFeatureEnabled: false,
            automationDraft: {
                enabled: false,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            },
            effectiveAutomationDraft: {
                enabled: false,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            },
            setAutomationDraft: vi.fn(),
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
            sessionPrompt: '',
            setSessionPrompt: vi.fn(),
            handleCreateSession: vi.fn(),
            backendTarget: { kind: 'backend', backendId: 'claude' },
            agentType: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: false,
            showServerPickerChip: false,
            targetServerId: 'srv',
            targetServerName: 'Server A',
            mcpChip: null,
            externalSessionsFeatureEnabled: false,
            supportsDirectTranscriptStorage: false,
            transcriptStorage: 'persisted',
            hasUserSelectedTranscriptStorageRef: { current: false },
            setTranscriptStorage: vi.fn(),
            selectedMachineIsWindows: false,
            effectiveWindowsRemoteSessionLaunchMode: null,
            windowsTerminalAvailable: false,
            setWindowsRemoteSessionLaunchModeOverride: vi.fn(),
        });

        const hook = await renderHook(renderPresentation, {
            flushOptions: { cycles: 1, turns: 4 },
        });
        const firstConnectionStatus = hook.getCurrent().connectionStatus;

        activeAt += 1000;
        await hook.rerender();

        expect(hook.getCurrent().connectionStatus).toBe(firstConnectionStatus);
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
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            },
            effectiveAutomationDraft: {
                enabled: true,
                name: 'Nightly',
                description: 'Run nightly work',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            },
            setAutomationDraft: vi.fn(),
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
            sessionPrompt: '',
            setSessionPrompt: vi.fn(),
            handleCreateSession: vi.fn(),
            backendTarget: { kind: 'backend', backendId: 'claude' },
            agentType: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: true,
            showServerPickerChip: false,
            targetServerId: null,
            targetServerName: 'Server A',
            mcpChip: null,
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
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            },
            effectiveAutomationDraft: {
                enabled: false,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            },
            setAutomationDraft: vi.fn(),
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
            sessionPrompt: 'hello',
            setSessionPrompt,
            handleCreateSession: vi.fn(),
            backendTarget: { kind: 'backend', backendId: 'claude' },
            agentType: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: false,
            showServerPickerChip: false,
            targetServerId: 'srv',
            targetServerName: 'Server A',
            mcpChip: null,
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
        let sessionPrompt = '';
        const setSessionPrompt = vi.fn((next: string | ((previous: string) => string)) => {
            sessionPrompt = typeof next === 'function' ? next(sessionPrompt) : next;
        });

        const renderPresentation = () => useNewSessionAgentInputPresentation({
            theme: sessionAgentInputTheme,
            selectedMachine: null,
            automationFeatureEnabled: false,
            automationDraft: {
                enabled: false,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            },
            effectiveAutomationDraft: {
                enabled: false,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            },
            setAutomationDraft: vi.fn(),
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
            sessionPrompt,
            setSessionPrompt,
            handleCreateSession: vi.fn(),
            backendTarget: { kind: 'backend', backendId: 'claude' },
            agentType: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: false,
            showServerPickerChip: false,
            targetServerId: 'srv',
            targetServerName: 'Server A',
            mcpChip: null,
            externalSessionsFeatureEnabled: false,
            supportsDirectTranscriptStorage: false,
            transcriptStorage: 'persisted',
            hasUserSelectedTranscriptStorageRef: { current: false },
            setTranscriptStorage: vi.fn(),
            selectedMachineIsWindows: false,
            effectiveWindowsRemoteSessionLaunchMode: null,
            windowsTerminalAvailable: false,
            setWindowsRemoteSessionLaunchModeOverride: vi.fn(),
        });

        const hook = await renderHook(renderPresentation, {
            flushOptions: { cycles: 1, turns: 4 },
        });
        const firstChips = hook.getCurrent().agentInputExtraActionChips;

        sessionPrompt = 'hello';
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

        expect(sessionPrompt).toBe('hello @file.ts ');
    });
});
