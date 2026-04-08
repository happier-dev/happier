import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SetupThisComputerWizardPrimaryState } from './SetupThisComputerChecklistStep';

const preflightMock = vi.hoisted(() => ({
    value: {
        activeRelayUrl: 'https://relay.example.test',
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
        relayDriftBanner: null as null | {
            kind: 'warning';
            title: string;
            description: string;
            actionLabel: string;
            isRepairStarting: boolean;
            repairTaskSnapshot: null;
            onPress: () => void;
        },
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

vi.mock('@/modal', () => ({
    Modal: {
        show: vi.fn(() => 'modal-id'),
        hide: vi.fn(),
        update: vi.fn(),
        hideAll: vi.fn(),
        alert: vi.fn(),
        alertAsync: vi.fn(async () => undefined),
        prompt: vi.fn(async () => null),
        confirm: modalSpies.confirm,
    },
    ModalProvider: ({ children }: { children?: React.ReactNode }) => React.createElement('ModalProvider', null, children ?? null),
}));

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
    it('renders the checklist rows and expands logs for the active execution step', async () => {
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
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.configureRelay')).toBeTruthy();
        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.configureRelay-details')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Connecting to relay');
    });

    it('includes the tailscale recommendation when the active relay is tailnet-based', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');

        preflightMock.value = {
            ...preflightMock.value,
            activeRelayUrl: 'https://relay.example.ts.net',
        };
        taskHookMock.value.activeTaskSnapshot = null;

        const screen = await renderScreen(
            <SetupThisComputerChecklistStep testID="setup-this-computer" />,
        );

        expect(screen.findByTestId('setup-this-computer-checklist-row-setup.thisComputer.installTailscale')).toBeTruthy();
        expect(screen.getTextContent()).toContain('setupOnboarding.recommendedBadge');
    });

    it('advances without starting the system task when this computer is already ready', async () => {
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');
        const onRequestAdvance = vi.fn();

        preflightMock.value = {
            ...preflightMock.value,
            activeRelayUrl: 'https://relay.example.test',
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

        const statusIcons = screen.findAllByType('Ionicons' as never).map((icon) => icon.props.name);
        expect(statusIcons).toContain('ellipse-outline');
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

});
