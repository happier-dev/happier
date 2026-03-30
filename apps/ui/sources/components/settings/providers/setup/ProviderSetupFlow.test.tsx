import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tauriDesktopState = vi.hoisted(() => ({ value: true }));
const modalState = vi.hoisted(() => ({
    confirm: vi.fn(async () => true),
}));
const capabilitiesState = vi.hoisted(() => ({
    invoke: vi.fn(async () => ({
        supported: true as const,
        response: { ok: true as const, result: null },
    })),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                textSecondary: 'gray',
                accent: {
                    blue: 'blue',
                },
            },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: modalState.confirm,
    },
}));

vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
    machineCapabilitiesInvoke: capabilitiesState.invoke,
}));

vi.mock('@/components/ui/cards/ActionCard', () => ({
    ActionCard: (props: Record<string, unknown> & { primaryAction?: { onPress?: () => void } }) =>
        React.createElement('ActionCard', {
            ...props,
            onPress: props.primaryAction?.onPress,
        }),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('../ProviderCliInstallItem', () => ({
    ProviderCliInstallItem: (props: Record<string, unknown>) => React.createElement('ProviderCliInstallItem', props),
}));

vi.mock('../authentication/ProviderAuthenticationCard', () => ({
    ProviderAuthenticationCard: (props: Record<string, unknown>) => React.createElement('ProviderAuthenticationCard', props),
}));

vi.mock('../authentication/ProviderAuthenticationTerminalPane', () => ({
    ProviderAuthenticationTerminalPane: (props: Record<string, unknown>) => React.createElement('ProviderAuthenticationTerminalPane', props),
}));

vi.mock('@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection', () => ({
    usePrimaryMachineFromActiveSelection: () => 'machine-1',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useMachine: () => ({
        id: 'machine-1',
        metadata: {
            displayName: 'Primary Machine',
        },
    }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => 'server-a',
    getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://relay.example.test', generation: 1 }),
    listServerProfiles: () => [],
}));

const cliRefresh = vi.fn();

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({
        available: { codex: false, claude: false },
        login: { codex: null, claude: null },
        authStatus: { codex: null, claude: null },
        resolvedPath: { codex: null, claude: null },
        resolvedCommand: { codex: null, claude: null },
        resolutionSource: { codex: null, claude: null },
        tmux: null,
        isDetecting: false,
        timestamp: 1,
        refresh: cliRefresh,
    }),
}));

vi.mock('@/hooks/machine/useCapabilityInstallability', () => ({
    useCapabilityInstallability: () => null,
}));

vi.mock('../authentication/useProviderAuthenticationState', () => ({
    useProviderAuthenticationState: () => ({
        authStatus: null,
        cliAvailable: false,
        machineId: 'machine-1',
        machineHomeDir: null,
        canCheckNow: false,
        supportsLoginTerminal: false,
        canLaunchLogin: false,
        loginLaunch: null,
        loginActionKind: 'login',
        docsUrl: null,
        support: 'unsupported',
        statusHelpText: null,
    }),
}));

vi.mock('@/agents/providers/registry/providerLocalAuthRegistry', () => ({
    getProviderLocalAuthPlugin: () => null,
}));

describe('ProviderSetupFlow', () => {
    beforeEach(() => {
        tauriDesktopState.value = true;
        modalState.confirm.mockClear();
        capabilitiesState.invoke.mockClear();
    });

    afterEach(() => {
        tauriDesktopState.value = true;
    });

    it('starts the queue from the providers that remain selected', async () => {
        const { ProviderSetupFlow } = await import('./ProviderSetupFlow');
        const screen = await renderScreen(React.createElement(ProviderSetupFlow, {
            providerIds: ['codex', 'claude'],
        }));

        await screen.pressByTestIdAsync('provider-setup-option-codex');
        await screen.pressByTestIdAsync('provider-setup-start-card');

        expect(screen.findByTestId('provider-setup-active-claude')).toBeTruthy();
        expect(screen.findAllByTestId('provider-setup-active-codex')).toHaveLength(0);
    });

    it('batch installs the selected providers with a single confirmation', async () => {
        const { ProviderSetupFlow } = await import('./ProviderSetupFlow');
        const screen = await renderScreen(React.createElement(ProviderSetupFlow, {
            providerIds: ['codex', 'claude'],
        }));

        await screen.pressByTestIdAsync('provider-setup-start-card');

        expect(modalState.confirm).toHaveBeenCalledTimes(1);
        expect(capabilitiesState.invoke).toHaveBeenCalledTimes(2);
    });

    it('shows a desktop-only notice on browser web instead of provider setup controls', async () => {
        tauriDesktopState.value = false;

        const { ProviderSetupFlow } = await import('./ProviderSetupFlow');
        const screen = await renderScreen(React.createElement(ProviderSetupFlow, {
            providerIds: ['codex', 'claude'],
        }));

        expect(screen.findByTestId('settings.providers.setup.desktopOnlyNotice')).toBeTruthy();
        expect(screen.findByTestId('provider-setup-start-card')).toBeNull();
        expect(screen.findByTestId('provider-setup-queue-card')).toBeNull();
        expect(screen.findByTestId('provider-setup-option-codex')).toBeNull();
    });
});
