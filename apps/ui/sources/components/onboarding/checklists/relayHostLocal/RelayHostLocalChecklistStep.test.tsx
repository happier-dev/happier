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
        return { status: relayRuntimeStatus };
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
    it('runs secure access setup against the local relay runtime URL (not the active cloud relay)', async () => {
        const { RelayHostLocalChecklistStep } = await import('./RelayHostLocalChecklistStep');
        const stableSnapshot = {
            taskId: 'task_1',
            status: 'succeeded',
            currentStepId: 'tailscale.verifyUrl',
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

        let primary: { label: string; disabled: boolean; onPress: () => void | Promise<void> } | null = null;
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
        const primaryState = primary as { label: string; disabled: boolean; onPress: () => void | Promise<void> };

        expect(screen.findByTestId('relay-host-local-checklist-row-installRelayRuntime')).toBeTruthy();
        expect(screen.findByTestId('relay-host-local-checklist-row-startRelayRuntime')).toBeTruthy();
        expect(screen.findByTestId('relay-host-local-checklist-row-enableSecureAccess')).toBeTruthy();
        expect(primaryState.label).toBe('common.continue');

        await act(async () => {
            await primaryState.onPress();
        });
        expect(runner.start).toHaveBeenCalledTimes(1);
        const spec = runner.start.mock.calls[0]?.[0] as any;
        expect(spec?.params?.upstreamUrl).toBe('http://localhost:53288');
    });
});
