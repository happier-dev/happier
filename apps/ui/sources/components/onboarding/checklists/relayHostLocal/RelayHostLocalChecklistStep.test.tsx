import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('expo-clipboard', () => ({
    getStringAsync: vi.fn(async () => ''),
    setStringAsync: vi.fn(async () => {}),
}));

const relayRuntimeStatus = Object.freeze({
    installed: true,
    version: '1.2.3',
    relayUrl: 'http://localhost:53288',
    healthy: true,
    service: { active: true, enabled: true },
});

type WizardPrimaryState = {
    label: string;
    disabled: boolean;
    onPress: () => void | Promise<void>;
};

const localRelayRuntimeControlMockState: {
    status: typeof relayRuntimeStatus | null;
    isBusy: boolean;
} = {
    status: relayRuntimeStatus,
    isBusy: false,
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: 'surface',
                divider: 'divider',
                text: 'text',
                textSecondary: 'textSecondary',
                textTertiary: 'textTertiary',
                warningCritical: 'warningCritical',
                success: 'success',
                surfacePressedOverlay: 'surfacePressedOverlay',
                accent: {
                    blue: 'accentBlue',
                },
            },
        },
    });
});

vi.mock('@/components/settings/server/localControl/useLocalRelayRuntimeControl', () => ({
    useLocalRelayRuntimeControl: () => {
        return {
            status: localRelayRuntimeControlMockState.status,
            isBusy: localRelayRuntimeControlMockState.isBusy,
        };
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'relay-1',
        serverUrl: 'https://cloud.example.test',
        activeShareableServerUrl: null,
        activeLocalRelayUrl: null,
        generation: 1,
    }),
    subscribeActiveServer: (_listener: unknown) => () => {},
}));

describe('RelayHostLocalChecklistStep', () => {
    function flattenStyle(style: unknown): Record<string, unknown> {
        return Array.isArray(style)
            ? Object.assign({}, ...style.filter(Boolean) as Array<Record<string, unknown>>)
            : (style as Record<string, unknown>);
    }

    it('disables the wizard continue action while the initial relay status is still loading', async () => {
        localRelayRuntimeControlMockState.status = null;
        localRelayRuntimeControlMockState.isBusy = true;

        const { RelayHostLocalChecklistStep } = await import('./RelayHostLocalChecklistStep');

        let primary: WizardPrimaryState | null = null;
        await renderScreen(React.createElement(RelayHostLocalChecklistStep, {
            testID: 'relay-host-local',
            onWizardPrimaryChange: (state) => {
                primary = state;
            },
        }));

        expect(primary).toMatchObject({
            label: 'common.continue',
            disabled: true,
        });
    });

    it('keeps the checklist focused on relay runtime tasks when the relay is already installed', async () => {
        localRelayRuntimeControlMockState.status = relayRuntimeStatus;
        localRelayRuntimeControlMockState.isBusy = false;

        const { RelayHostLocalChecklistStep } = await import('./RelayHostLocalChecklistStep');
        const stableSnapshot = {
            taskId: 'task_1',
            status: 'succeeded',
            currentStepId: 'relay.status.health',
            latestMessage: null,
            awaitingInput: false,
            cancelRequested: false,
            events: [],
            result: { ok: true, data: {}, protocolVersion: 1, taskId: 'task_1' },
        } as any;
        const runner = {
            mode: 'dev',
            start: vi.fn(async (_spec: unknown) => 'task_1'),
            cancel: vi.fn(async () => {}),
            respond: vi.fn(async () => {}),
            getSnapshot: vi.fn(() => stableSnapshot),
            subscribe: vi.fn(() => () => {}),
        } as const;

        let primary: WizardPrimaryState | null = null;
        const screen = await renderScreen(React.createElement(RelayHostLocalChecklistStep, {
            testID: 'relay-host-local',
            runner: runner as never,
            onWizardPrimaryChange: (state) => {
                primary = state;
            },
        }));
        if (!primary) {
            throw new Error('Expected wizard primary override');
        }
        const primaryState: WizardPrimaryState = primary;

        expect(screen.findByTestId('relay-host-local-checklist-row-installRelayRuntime')).toBeTruthy();
        expect(screen.findByTestId('relay-host-local-checklist-row-startRelayRuntime')).toBeTruthy();
        expect(screen.findByTestId('relay-host-local-checklist-row-enableSecureAccess')).toBeNull();
        const installStatusSlot = screen.findByTestId('relay-host-local-checklist-row-installRelayRuntime-status-slot');
        if (!installStatusSlot) {
            throw new Error('Expected install relay runtime status slot');
        }
        const flattenedStyle = flattenStyle(installStatusSlot.props.style);
        expect(flattenedStyle.borderWidth).toBe(1);
        expect(Number(flattenedStyle.width)).toBeGreaterThan(26);
        expect(Number(flattenedStyle.height)).toBeGreaterThan(26);
        expect(primaryState.label).toBe('common.continue');

        await act(async () => {
            await primaryState.onPress();
        });
        expect(runner.start).toHaveBeenCalledTimes(0);
    });

    it('refreshes the wizard continue action when the parent advance handler changes', async () => {
        localRelayRuntimeControlMockState.status = relayRuntimeStatus;
        localRelayRuntimeControlMockState.isBusy = false;

        const { RelayHostLocalChecklistStep } = await import('./RelayHostLocalChecklistStep');

        const initialAdvance = vi.fn();
        const nextAdvance = vi.fn();
        let primary: WizardPrimaryState | null = null;
        const handleWizardPrimaryChange = (state: typeof primary) => {
            primary = state;
        };

        const screen = await renderScreen(React.createElement(RelayHostLocalChecklistStep, {
            testID: 'relay-host-local',
            onRequestAdvance: initialAdvance,
            onWizardPrimaryChange: handleWizardPrimaryChange,
        }));

        await screen.update(React.createElement(RelayHostLocalChecklistStep, {
            testID: 'relay-host-local',
            onRequestAdvance: nextAdvance,
            onWizardPrimaryChange: handleWizardPrimaryChange,
        }));

        if (!primary) {
            throw new Error('Expected wizard primary override');
        }

        await act(async () => {
            await primary?.onPress();
        });

        expect(initialAdvance).toHaveBeenCalledTimes(0);
        expect(nextAdvance).toHaveBeenCalledTimes(1);
        expect(nextAdvance).toHaveBeenCalledWith(relayRuntimeStatus);
    });

    it('advances when a previously captured continue handler becomes stale after relay status settles', async () => {
        localRelayRuntimeControlMockState.status = null;
        localRelayRuntimeControlMockState.isBusy = false;

        const { RelayHostLocalChecklistStep } = await import('./RelayHostLocalChecklistStep');

        const advance = vi.fn();
        let primary: WizardPrimaryState | null = null;
        const handleWizardPrimaryChange = (state: typeof primary) => {
            primary = state;
        };

        const screen = await renderScreen(React.createElement(RelayHostLocalChecklistStep, {
            testID: 'relay-host-local',
            onRequestAdvance: advance,
            onWizardPrimaryChange: handleWizardPrimaryChange,
        }));

        if (!primary) {
            throw new Error('Expected initial wizard primary override');
        }

        const stalePrimary: WizardPrimaryState = primary;

        localRelayRuntimeControlMockState.status = relayRuntimeStatus;
        await screen.update(React.createElement(RelayHostLocalChecklistStep, {
            testID: 'relay-host-local',
            onRequestAdvance: advance,
            onWizardPrimaryChange: handleWizardPrimaryChange,
        }));

        await act(async () => {
            await stalePrimary.onPress();
        });

        expect(advance).toHaveBeenCalledTimes(1);
        expect(advance).toHaveBeenCalledWith(relayRuntimeStatus);
    });
});
