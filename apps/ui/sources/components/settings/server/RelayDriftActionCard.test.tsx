import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { installServerSettingsHooksCommonModuleMocks } from './hooks/serverSettingsHooksTestHelpers';

installServerSettingsHooksCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                warningCritical: 'warning',
                accent: {
                    blue: 'blue',
                },
                divider: 'divider',
                surface: 'surface',
                text: 'text',
                textSecondary: 'textSecondary',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/cards/ActionCard', () => ({
    ActionCard: (props: Record<string, unknown>) => React.createElement('ActionCard', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

function createSnapshot(overrides: Partial<SystemTaskRunState> = {}): SystemTaskRunState {
    return {
        taskId: 'task_1',
        status: 'running',
        currentStepId: 'relay.connectBackgroundService.configureRelay',
        latestMessage: 'executor message',
        awaitingInput: false,
        cancelRequested: false,
        events: [],
        result: null,
        ...overrides,
    };
}

describe('RelayDriftActionCard', () => {
    it('renders live repair progress with the canonical relay progress title and localized step label', async () => {
        const { RelayDriftActionCard } = await import('./RelayDriftActionCard');
        const screen = await renderScreen(
            React.createElement(RelayDriftActionCard, {
                banner: {
                    kind: 'warning',
                    title: 'server.relayDrift.bannerDifferentRelayTitle',
                    description: 'server.relayDrift.bannerDifferentRelayDescription',
                    actionLabel: 'server.relayDrift.repairAction',
                    onPress: vi.fn(),
                    repairTaskSnapshot: createSnapshot(),
                    onCancelRepair: vi.fn(),
                    isRepairStarting: false,
                },
            }),
        );

        expect(screen.findByTestId('relay-drift-banner')).toBeTruthy();
        expect(screen.findByTestId('system-task-progress-card')).toBeTruthy();
        expect(screen.findByTestId('system-task-step-label')?.props.children).toBe('server.relayDrift.progressStepConfigureRelay');
        expect(screen.findByTestId('system-task-message')?.props.children).toBe('executor message');
        const textNodes = screen.tree.findAllByType('Text' as any);
        expect(textNodes.some((node: any) => node.props.children === 'server.relayDrift.progressTitle')).toBe(true);
    });

    it('disables the repair action and shows the unavailable hint when repair cannot run', async () => {
        const { RelayDriftActionCard } = await import('./RelayDriftActionCard');
        const screen = await renderScreen(
            React.createElement(RelayDriftActionCard, {
                banner: {
                    kind: 'warning',
                    title: 'server.relayDrift.bannerDifferentRelayTitle',
                    description: 'server.relayDrift.bannerDifferentRelayDescription',
                    actionLabel: 'server.relayDrift.repairAction',
                    actionDisabled: true,
                    actionHint: 'settings.systemTaskBridgeUnavailable',
                    onPress: vi.fn(),
                    repairTaskSnapshot: null,
                    isRepairStarting: false,
                },
            }),
        );

        const banner = screen.findByTestId('relay-drift-banner');
        expect(banner?.props.disabled).toBe(true);
        expect(banner?.props.description).toContain('settings.systemTaskBridgeUnavailable');
    });
});
