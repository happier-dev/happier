import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
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
        const router: Router = {
            back: () => routerMock.state.router.back(),
            canGoBack: vi.fn(() => false),
            push: (value) => routerMock.state.router.push(value),
            navigate: vi.fn<Router['navigate']>(),
            replace: (value) => routerMock.state.router.replace(value),
            dismiss: vi.fn<Router['dismiss']>(),
            dismissTo: vi.fn<Router['dismissTo']>(),
            dismissAll: vi.fn<Router['dismissAll']>(),
            canDismiss: vi.fn(() => false),
            setParams: ((params) => {
                routerMock.spies.setParams(params as Record<string, string | string[] | undefined>);
            }) as Router['setParams'],
            reload: vi.fn<Router['reload']>(),
            prefetch: vi.fn<Router['prefetch']>(),
        };

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
});
