import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

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
        const status = {
            installed: false,
            version: null,
            relayUrl: 'http://localhost:53288',
            healthy: false,
            service: { active: false, enabled: false },
        };
        return { status };
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'relay-1',
        serverUrl: 'http://localhost:53288',
        activeShareableServerUrl: null,
        activeLocalRelayUrl: null,
        generation: 1,
    }),
}));

describe('RelayHostLocalChecklistStep', () => {
    it('renders the relay host checklist rows and footer actions', async () => {
        const { RelayHostLocalChecklistStep } = await import('./RelayHostLocalChecklistStep');
        const runner = {
            mode: 'dev',
            start: vi.fn(async () => 'task_1'),
            cancel: vi.fn(async () => {}),
            respond: vi.fn(async () => {}),
            getSnapshot: vi.fn(() => null),
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

        expect(screen.findByTestId('relay-host-local-checklist-row-installRelayRuntime')).toBeTruthy();
        expect(screen.findByTestId('relay-host-local-checklist-row-startRelayRuntime')).toBeTruthy();
        expect(primary?.label).toBe('common.continue');

        await act(async () => {
            await primary?.onPress?.();
        });
        expect(runner.start).toHaveBeenCalled();
    });
});
