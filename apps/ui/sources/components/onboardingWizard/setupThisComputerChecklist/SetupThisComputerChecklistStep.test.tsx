import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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
        activeTaskSnapshot: null as any,
        cancel: vi.fn(),
        start: vi.fn(async () => 'task-1'),
        startError: null as string | null,
        isStarting: false,
    },
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

vi.mock('./useThisComputerSetupPreflight', () => ({
    useThisComputerSetupPreflight: () => preflightMock.value,
}));

vi.mock('@/components/systemTasks/useThisComputerSetupTask', () => ({
    useThisComputerSetupTask: () => taskHookMock.value,
    resolveThisComputerSetupFollowUp: () => null,
}));

afterEach(() => {
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

        let primary: { label: string; disabled: boolean; onPress: () => void | Promise<void> } | null = null;
        await renderScreen(
            <SetupThisComputerChecklistStep
                testID="setup-this-computer"
                onRequestAdvance={onRequestAdvance}
                onWizardPrimaryChange={(state) => {
                    primary = state;
                }}
            />,
        );

        expect(primary?.label).toBe('common.continue');
        expect(primary?.disabled).toBe(false);

        await primary?.onPress?.();

        expect(taskHookMock.value.start).not.toHaveBeenCalled();
        expect(onRequestAdvance).toHaveBeenCalledTimes(1);
    });
});
