import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import type { RelayDriftBanner } from '@/components/settings/server/relayDriftTypes';
import type { SetupThisComputerWizardPrimaryState } from './SetupThisComputerChecklistStep';

const preflightMock = vi.hoisted(() => ({
    value: {
        activeRelayUrl: 'https://relay.example.test',
        activeWebappUrl: 'https://app.example.test',
        activeLocalRelayUrl: 'http://127.0.0.1:53288',
        localCliReady: false,
        serviceInstalled: false,
        daemonRunning: false,
        machineId: null as string | null,
        needsAuth: true,
        daemonServerUrl: 'https://relay.example.test',
        daemonComparableKey: 'https://relay.example.test',
        daemonAccountId: null as string | null,
        daemonMachineRegistered: false as boolean | null,
        uiAccountId: 'acct_ui',
        serverMismatch: false,
        accountMismatch: false,
        pairingRequired: true,
        relayDriftBanner: null as RelayDriftBanner | null,
    },
}));

const taskHookMock = vi.hoisted(() => ({
    value: {
        activeTaskId: null as string | null,
        activeTaskSnapshot: null as any,
        cancel: vi.fn(),
        runner: {
            respond: vi.fn(async () => undefined),
        },
        start: vi.fn(async () => 'task-1'),
        startError: null as string | null,
        isStarting: false,
    },
}));

const modalSpies = vi.hoisted(() => ({
    confirm: vi.fn(async () => true),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        ScrollView: 'ScrollView',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            borderRadius: { modalCard: 14 },
            colors: {
                text: '#111',
                textSecondary: '#666',
                textTertiary: '#999',
                surface: '#fff',
                surfaceHigh: '#f9f9f9',
                surfacePressed: '#f2f2f2',
                surfacePressedOverlay: '#fafafa',
                surfaceSelected: '#f8f8f8',
                divider: '#ddd',
                accent: { blue: '#007aff' },
                success: '#34c759',
                warningCritical: '#ff3b30',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/code/blocks/CodeBlockViewFrame', () => ({
    CodeBlockViewFrame: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('CodeBlockViewFrame', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const modalMock = createModalModuleMock({
    spies: {
        confirm: modalSpies.confirm,
    },
});

vi.mock('@/modal', () => modalMock.module);

vi.mock('./useThisComputerSetupPreflight', () => ({
    useThisComputerSetupPreflight: () => preflightMock.value,
}));

vi.mock('@/components/systemTasks/useThisComputerSetupTask', () => ({
    useThisComputerSetupTask: () => taskHookMock.value,
    resolveThisComputerSetupFollowUp: () => null,
}));

afterEach(() => {
    taskHookMock.value.activeTaskId = null;
    taskHookMock.value.activeTaskSnapshot = null;
    taskHookMock.value.cancel.mockReset();
    taskHookMock.value.runner.respond.mockReset();
    taskHookMock.value.start.mockReset();
    modalSpies.confirm.mockReset();
    modalSpies.confirm.mockResolvedValue(true);
    standardCleanup();
});

describe('SetupThisComputerChecklistStep', () => {
    it('renders the checklist rows without auto-expanding the active execution stage', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');
        taskHookMock.value.activeTaskSnapshot = {
            taskId: 'task-1',
            status: 'running',
            currentStepId: 'setup.thisComputer.configureRelay',
            latestMessage: 'Connecting to relay',
            awaitingInput: false,
            cancelRequested: false,
            events: [
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 10,
                    type: 'step',
                    stepId: 'setup.thisComputer.resolveRelay',
                    message: 'Checking existing components',
                },
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 20,
                    type: 'progress',
                    stepId: 'setup.thisComputer.configureRelay',
                    message: 'Connecting to relay',
                },
            ],
            result: null,
        };
        const screen = await renderScreen(
            <SetupThisComputerChecklistStep testID="setup-this-computer" />,
        );

        expect(screen.findByTestId('setup-this-computer-checklist')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.registerComputer')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.useRelay')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.configureRelay')).toBeNull();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.useRelay-details')).toBeNull();
        expect(screen.getTextContent()).toContain('setupOnboarding.thisComputerStages.registerComputerTitle');
    });

    it('renders high-level setup stages instead of low-level bootstrap rows', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');

        preflightMock.value = {
            ...preflightMock.value,
            activeRelayUrl: 'https://relay.example.ts.net',
        };
        taskHookMock.value.activeTaskSnapshot = null;

        const screen = await renderScreen(
            <SetupThisComputerChecklistStep testID="setup-this-computer" />,
        );

        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.installTools')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.useRelay')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.registerComputer')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.backgroundService')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.checkAuth')).toBeNull();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.auth.wait')).toBeNull();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.preflight.releaseChannel')).toBeNull();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.preflight.serviceConflict')).toBeNull();
    });

    it('shows explanatory details and nested substeps when a setup stage is expanded', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');

        const screen = await renderScreen(
            <SetupThisComputerChecklistStep testID="setup-this-computer" />,
        );

        await screen.pressByTestIdAsync('setup-this-computer-checklist-row-setup.thisComputer.stage.installTools-details-toggle');
        await screen.pressByTestIdAsync('setup-this-computer-checklist-row-setup.thisComputer.stage.installTools-children-row-setup.thisComputer.ensureCli');

        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.installTools-details')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.installTools-children-row-setup.thisComputer.ensureCli')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.installTools-children-row-setup.thisComputer.ensureCli-details')).toBeTruthy();
        expect(screen.getTextContent()).toContain('setupOnboarding.thisComputerStages.installToolsDetails');
    });

    it('shows dynamic substep details for the sign-in check', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');

        preflightMock.value = {
            ...preflightMock.value,
            needsAuth: true,
        };

        const screen = await renderScreen(
            <SetupThisComputerChecklistStep testID="setup-this-computer" />,
        );

        await screen.pressByTestIdAsync('setup-this-computer-checklist-row-setup.thisComputer.stage.useRelay-details-toggle');
        await screen.pressByTestIdAsync('setup-this-computer-checklist-row-setup.thisComputer.stage.useRelay-children-row-setup.thisComputer.checkAuth');

        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.useRelay-children-row-setup.thisComputer.checkAuth-details')).toBeTruthy();
        expect(screen.getTextContent()).toContain('setupOnboarding.thisComputerStages.useRelayNeedsAuthSubtitle');
    });

    it('shows the running child step, logs, and failure details inside the expanded setup stage', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');

        taskHookMock.value.activeTaskSnapshot = {
            taskId: 'task-1',
            status: 'failed',
            currentStepId: 'setup.thisComputer.installService',
            latestMessage: 'Installing background service',
            awaitingInput: false,
            cancelRequested: false,
            events: [
                {
                    protocolVersion: 1,
                    taskId: 'task-1',
                    tsMs: 30,
                    type: 'progress',
                    stepId: 'setup.thisComputer.installService',
                    message: 'Installing background service',
                },
            ],
            result: {
                ok: false,
                protocolVersion: 1,
                taskId: 'task-1',
                error: {
                    code: 'cli_command_failed',
                    message: '',
                },
            },
        };

        const screen = await renderScreen(
            <SetupThisComputerChecklistStep testID="setup-this-computer" />,
        );

        await screen.pressByTestIdAsync('setup-this-computer-checklist-row-setup.thisComputer.stage.backgroundService-details-toggle');
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.backgroundService')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.backgroundService-children-row-setup.thisComputer.installService')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Installing background service');
        expect(screen.getTextContent()).toContain('cli_command_failed');
        expect(screen.getTextContent()).toContain('common.error');
    });

    it('advances without starting the system task when this computer is already ready', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');
        const onRequestAdvance = vi.fn();

        preflightMock.value = {
            ...preflightMock.value,
            activeRelayUrl: 'https://relay.example.test',
            localCliReady: true,
            serviceInstalled: true,
            daemonRunning: true,
            machineId: 'machine-1',
            needsAuth: false,
            daemonServerUrl: 'https://relay.example.test',
            daemonComparableKey: 'https://relay.example.test',
            daemonAccountId: 'acct_ui',
            daemonMachineRegistered: true,
            uiAccountId: 'acct_ui',
            serverMismatch: false,
            accountMismatch: false,
            pairingRequired: false,
            relayDriftBanner: null,
        };
        taskHookMock.value.activeTaskSnapshot = null;
        taskHookMock.value.start.mockClear();

        const primaryRef: { current: SetupThisComputerWizardPrimaryState | null } = { current: null };
        await renderScreen(
            <SetupThisComputerChecklistStep
                testID="setup-this-computer"
                onRequestAdvance={onRequestAdvance}
                onWizardPrimaryChange={(state) => {
                    primaryRef.current = state;
                }}
            />,
        );

        expect(primaryRef.current?.label).toBe('common.continue');
        expect(primaryRef.current?.disabled).toBe(false);

        await act(async () => {
            await primaryRef.current?.onPress?.();
        });

        expect(taskHookMock.value.start).not.toHaveBeenCalled();
        expect(onRequestAdvance).toHaveBeenCalledTimes(1);
    });

    it('keeps the checklist in setup mode when relay drift repair is still needed', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');
        const onRequestAdvance = vi.fn();

        preflightMock.value = {
            ...preflightMock.value,
            activeRelayUrl: 'https://relay.example.test',
            localCliReady: true,
            serviceInstalled: true,
            daemonRunning: true,
            machineId: 'machine-1',
            needsAuth: false,
            daemonServerUrl: 'https://relay.example.test',
            daemonComparableKey: 'https://relay.example.test',
            daemonAccountId: 'acct_ui',
            daemonMachineRegistered: true,
            uiAccountId: 'acct_ui',
            serverMismatch: false,
            accountMismatch: false,
            pairingRequired: false,
            relayDriftBanner: {
                kind: 'warning',
                title: 'Relay drift',
                description: 'The background service is not connected to this server yet.',
                actionLabel: 'Reconnect background service',
                actionDisabled: true,
                actionHint: 'settings.systemTaskBridgeUnavailable',
                onPress: async () => undefined,
                isRepairStarting: false,
                repairTaskSnapshot: null,
            },
        };
        taskHookMock.value.activeTaskSnapshot = null;
        taskHookMock.value.start.mockClear();

        const primaryRef: { current: SetupThisComputerWizardPrimaryState | null } = { current: null };
        await renderScreen(
            <SetupThisComputerChecklistStep
                testID="setup-this-computer"
                onRequestAdvance={onRequestAdvance}
                onWizardPrimaryChange={(state) => {
                    primaryRef.current = state;
                }}
            />,
        );

        expect(primaryRef.current?.label).toBe('common.continue');
        expect(primaryRef.current?.disabled).toBe(false);

        await act(async () => {
            await primaryRef.current?.onPress?.();
        });

        expect(taskHookMock.value.start).toHaveBeenCalledTimes(1);
        expect(onRequestAdvance).not.toHaveBeenCalled();
    });

    it('keeps the checklist in setup mode until local CLI readiness is confirmed', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');
        const onRequestAdvance = vi.fn();

        preflightMock.value = {
            ...preflightMock.value,
            activeRelayUrl: 'https://relay.example.test',
            localCliReady: false,
            serviceInstalled: true,
            daemonRunning: true,
            machineId: 'machine-1',
            needsAuth: false,
            daemonServerUrl: 'https://relay.example.test',
            daemonComparableKey: 'https://relay.example.test',
            daemonAccountId: 'acct_ui',
            daemonMachineRegistered: true,
            uiAccountId: 'acct_ui',
            serverMismatch: false,
            accountMismatch: false,
            pairingRequired: false,
            relayDriftBanner: null,
        };
        taskHookMock.value.activeTaskSnapshot = null;
        taskHookMock.value.start.mockClear();

        const primaryRef: { current: SetupThisComputerWizardPrimaryState | null } = { current: null };
        await renderScreen(
            <SetupThisComputerChecklistStep
                testID="setup-this-computer"
                onRequestAdvance={onRequestAdvance}
                onWizardPrimaryChange={(state) => {
                    primaryRef.current = state;
                }}
            />,
        );

        expect(primaryRef.current?.label).toBe('common.continue');
        expect(primaryRef.current?.disabled).toBe(false);

        await act(async () => {
            await primaryRef.current?.onPress?.();
        });

        expect(taskHookMock.value.start).toHaveBeenCalledTimes(1);
        expect(onRequestAdvance).not.toHaveBeenCalled();
    });

    it('starts setup with the relay selected in the UI instead of relying on CLI current-relay state', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');

        preflightMock.value = {
            ...preflightMock.value,
            activeRelayUrl: 'https://relay-from-ui.example.test',
            activeWebappUrl: 'https://app-from-ui.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:55321',
            localCliReady: false,
            serviceInstalled: false,
            daemonRunning: false,
            machineId: null,
            needsAuth: true,
            pairingRequired: true,
        };
        taskHookMock.value.activeTaskSnapshot = null;
        taskHookMock.value.start.mockClear();

        const primaryRef: { current: SetupThisComputerWizardPrimaryState | null } = { current: null };
        await renderScreen(
            <SetupThisComputerChecklistStep
                testID="setup-this-computer"
                onWizardPrimaryChange={(state) => {
                    primaryRef.current = state;
                }}
            />,
        );

        await act(async () => {
            await primaryRef.current?.onPress?.();
        });

        expect(taskHookMock.value.start).toHaveBeenCalledWith(expect.objectContaining({
            params: expect.objectContaining({
                activeRelayUrl: 'https://relay-from-ui.example.test',
                activeWebappUrl: 'https://app-from-ui.example.test',
                activeLocalRelayUrl: 'http://127.0.0.1:55321',
            }),
        }));
    });

    it('disables the wizard primary CTA after starting execution until the task snapshot is available', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');

        preflightMock.value = {
            ...preflightMock.value,
            activeRelayUrl: 'https://relay.example.test',
            serviceInstalled: false,
            daemonRunning: false,
            machineId: null,
            needsAuth: true,
            pairingRequired: true,
        };
        taskHookMock.value.activeTaskSnapshot = null;
        taskHookMock.value.start.mockClear();

        const primaryRef: { current: SetupThisComputerWizardPrimaryState | null } = { current: null };
        const screen = await renderScreen(
            <SetupThisComputerChecklistStep
                testID="setup-this-computer"
                onWizardPrimaryChange={(state) => {
                    primaryRef.current = state;
                }}
            />,
        );

        expect(primaryRef.current?.label).toBe('common.continue');
        expect(primaryRef.current?.disabled).toBe(false);

        await act(async () => {
            await primaryRef.current?.onPress?.();
        });

        expect(taskHookMock.value.start).toHaveBeenCalledTimes(1);
        expect(primaryRef.current?.disabled).toBe(true);

        const pendingNode = screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.stage.installTools-status-slot');
        expect(pendingNode?.findAll((node) => node.children.includes('1'))).toHaveLength(1);
        const statusIcons = screen.findAllByType('Ionicons' as never).map((icon) => icon.props.name);
        expect(statusIcons).not.toContain('ellipse-outline');
    });

    it('does not trigger an infinite update loop when onWizardPrimaryChange updates state', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');

        preflightMock.value = {
            ...preflightMock.value,
            activeRelayUrl: 'https://relay.example.test',
            serviceInstalled: false,
            daemonRunning: false,
            machineId: null,
            needsAuth: true,
            pairingRequired: true,
        };
        taskHookMock.value.activeTaskSnapshot = null;

        function Wrapper() {
            const [, setPrimary] = React.useState<SetupThisComputerWizardPrimaryState | null>(null);
            return (
                <SetupThisComputerChecklistStep
                    testID="setup-this-computer"
                    onWizardPrimaryChange={setPrimary}
                />
            );
        }

        await expect(renderScreen(<Wrapper />)).resolves.toBeTruthy();
    });

    it('lets the user skip background-service setup and forwards that choice to the system task', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');

        preflightMock.value = {
            ...preflightMock.value,
            activeRelayUrl: 'https://relay.example.test',
            serviceInstalled: false,
            daemonRunning: false,
            machineId: null,
            needsAuth: true,
            pairingRequired: true,
        };
        taskHookMock.value.activeTaskSnapshot = null;
        taskHookMock.value.start.mockClear();

        const primaryRef: { current: SetupThisComputerWizardPrimaryState | null } = { current: null };
        const screen = await renderScreen(
            <SetupThisComputerChecklistStep
                testID="setup-this-computer"
                onWizardPrimaryChange={(state) => {
                    primaryRef.current = state;
                }}
            />,
        );

        await screen.pressByTestIdAsync('setup-this-computer-checklist-row-setup.thisComputer.stage.backgroundService-details-toggle');
        await screen.pressByTestIdAsync('setup-this-computer-checklist-row-setup.thisComputer.stage.backgroundService-children-row-setup.thisComputer.installService');

        await act(async () => {
            await primaryRef.current?.onPress?.();
        });

        expect(taskHookMock.value.start).toHaveBeenCalledWith(expect.objectContaining({
            params: expect.objectContaining({
                installService: false,
                startService: false,
                verifyService: false,
            }),
        }));
    });

});
