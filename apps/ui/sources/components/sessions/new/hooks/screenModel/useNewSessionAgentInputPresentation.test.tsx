import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, renderScreen, flushHookEffects } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { Router } from 'expo-router';

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

describe('useNewSessionAgentInputPresentation', () => {
    it('keeps automation editing inside the action chip popover instead of rendering an inline automation section', async () => {
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
                    success: '#0f0',
                    textDestructive: '#f00',
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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            agentType: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: true,
            showServerPickerChip: false,
            targetServerId: null,
            targetServerName: 'Server A',
            mcpChip: null,
            directSessionsFeatureEnabled: false,
            supportsDirectTranscriptStorage: false,
            transcriptStorage: 'persisted',
            hasUserSelectedTranscriptStorageRef: { current: false },
            setTranscriptStorage: vi.fn(),
            selectedMachineIsWindows: false,
            effectiveWindowsRemoteSessionLaunchMode: null,
            windowsTerminalAvailable: false,
            setWindowsRemoteSessionLaunchModeOverride: vi.fn(),
        }));

        expect(hook.getCurrent().automationSection).toBeNull();
        expect(hook.getCurrent().agentInputExtraActionChips.some((chip) => chip.key === 'new-session-automate')).toBe(true);
    });

    it('adds a link-file chip that appends the selected file path into the draft prompt', async () => {
        const { useNewSessionAgentInputPresentation } = await import('./useNewSessionAgentInputPresentation');
        const routerMock = createExpoRouterMock();
        const setSessionPrompt = vi.fn();

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
                    success: '#0f0',
                    textDestructive: '#f00',
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
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            agentType: 'claude',
            agentOptionState: null,
            setAgentOptionStateForCurrentAgent: vi.fn(),
            connectedServicesAuthChip: null,
            showAutomationActionChips: false,
            showServerPickerChip: false,
            targetServerId: 'srv',
            targetServerName: 'Server A',
            mcpChip: null,
            directSessionsFeatureEnabled: false,
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

        expect(chip?.collapsedContentPopover).toBeTruthy();
        const renderContent = chip?.collapsedContentPopover?.renderContent;
        expect(typeof renderContent).toBe('function');
        if (typeof renderContent !== 'function') {
            throw new Error('Expected link-file chip collapsedContentPopover.renderContent to be a function');
        }

        // Simulate selecting a file from the popover browser content.
        const rendered = renderContent({ requestClose: () => {}, maxHeight: 320 }) as any;
        expect(React.isValidElement(rendered)).toBe(true);
        const props = (rendered as any).props ?? {};
        expect(typeof props.onPickPath).toBe('function');
        await act(async () => {
            props.onPickPath('/repo/file.ts');
        });

        const arg = setSessionPrompt.mock.calls.at(-1)?.[0];
        expect(typeof arg).toBe('function');
        expect(arg('hello')).toBe('hello @/repo/file.ts ');

        // The link-file chip must render a visible interactive chip in the action bar (not only an action-menu item).
        setSessionPrompt.mockClear();

        const chipUi = chip!.render({
            chipStyle: () => ({}),
            showLabel: true,
            iconColor: '#000',
            textStyle: {},
            countTextStyle: {},
            chipAnchorRef: { current: null },
            popoverAnchorRef: { current: null },
            toggleCollapsedPopover: vi.fn(),
        });
        if (!React.isValidElement(chipUi)) {
            throw new Error('Expected chip renderer to return an element');
        }
        const screen = await renderScreen(chipUi);
        expect(screen.findByTestId('new-session-link-file-chip')).toBeTruthy();

        await screen.pressByTestIdAsync('new-session-link-file-chip');
        await flushHookEffects({ cycles: 1, turns: 1 });
        // In the unified popover flow, pressing the chip toggles the central collapsed popover.
        // (Selection is handled through the popover content callback above.)
    });
});
