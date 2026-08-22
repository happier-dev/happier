import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createModalModuleMock, renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tauriDesktopState = vi.hoisted(() => ({ value: true }));
const capabilitiesState = vi.hoisted(() => ({
    invoke: vi.fn(async () => ({
        supported: true as const,
        response: { ok: true as const, result: null },
    })),
}));
const administrationTargetState = vi.hoisted(() => ({
    resolveExecutionTarget: vi.fn(() => ({
        target: { serverIdentityId: 'identity-target', machineId: 'machine-target' },
        serverId: 'server-target',
        machine: {
            id: 'machine-target',
            metadata: { displayName: 'Target Machine' },
        },
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

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauriDesktopState.value,
}));

const modalMock = createModalModuleMock({
    spies: {
        confirm: vi.fn(async () => true),
    },
});
vi.mock('@/modal', () => modalMock.module);

vi.mock('@/sync/ops', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops')>();
    return {
        ...original,
        machineCapabilitiesInvoke: capabilitiesState.invoke,
    };
});

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

vi.mock('../AgentCliInstallItem', () => ({
    AgentCliInstallItem: (props: Record<string, unknown>) => React.createElement('AgentCliInstallItem', props),
}));

vi.mock('../authentication/AgentAuthenticationCard', () => ({
    AgentAuthenticationCard: (props: Record<string, unknown>) => React.createElement('AgentAuthenticationCard', props),
}));

vi.mock('../authentication/AgentAuthenticationTerminalPane', () => ({
    AgentAuthenticationTerminalPane: (props: Record<string, unknown>) => React.createElement('AgentAuthenticationTerminalPane', props),
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Record<string, unknown>) => React.createElement('MachineAdministrationTargetSelector', props),
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({
        selectedTarget: { serverIdentityId: 'identity-target', machineId: 'machine-target' },
        candidates: [],
        pickerRows: [],
        state: { kind: 'unselected', candidates: [] },
        canExecute: true,
        selectTarget: vi.fn(),
        clearTarget: vi.fn(),
        resolveExecutionTarget: administrationTargetState.resolveExecutionTarget,
    }),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useMachine: () => ({
            id: 'machine-target',
            metadata: {
                displayName: 'Target Machine',
            },
        }),
    });
});

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

vi.mock('../authentication/useAgentAuthenticationState', () => ({
    useAgentAuthenticationState: () => ({
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

vi.mock('@/agents/catalog/localAuth/agentLocalAuthCatalog', () => ({
    getAgentLocalAuthPlugin: () => null,
}));

const onboardingComponentMocks = {
    AgentsLogoMultiSelect: (props: Record<string, unknown>) => React.createElement('AgentsLogoMultiSelect', props),
    WizardTerminalHandoff: (props: Record<string, unknown>) => React.createElement('WizardTerminalHandoff', props),
    WebDesktopDownloadCta: (props: Record<string, unknown>) => React.createElement('WebDesktopDownloadCta', props),
};

vi.mock('@/components/onboarding', () => onboardingComponentMocks);

vi.mock('@/components/onboarding/ui/WizardTerminalHandoff', () => ({
    WizardTerminalHandoff: onboardingComponentMocks.WizardTerminalHandoff,
}));

vi.mock('@/components/onboarding/steps/AgentsLogoMultiSelect', () => ({
    AgentsLogoMultiSelect: onboardingComponentMocks.AgentsLogoMultiSelect,
}));

vi.mock('@/components/onboarding/steps/webDesktop/WebDesktopDownloadCta', () => ({
    WebDesktopDownloadCta: onboardingComponentMocks.WebDesktopDownloadCta,
}));

describe('AgentSetupFlow', () => {
    beforeEach(() => {
        tauriDesktopState.value = true;
        modalMock.spies.confirm.mockClear();
        capabilitiesState.invoke.mockClear();
        administrationTargetState.resolveExecutionTarget.mockReset();
        administrationTargetState.resolveExecutionTarget.mockReturnValue({
            target: { serverIdentityId: 'identity-target', machineId: 'machine-target' },
            serverId: 'server-target',
            machine: {
                id: 'machine-target',
                metadata: { displayName: 'Target Machine' },
            },
        });
    });

    afterEach(() => {
        tauriDesktopState.value = true;
    });

    it('starts the queue from the providers that remain selected', async () => {
        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {
            agentIds: ['codex', 'claude'],
        }));

        await screen.pressByTestIdAsync('provider-setup-option-codex');
        await screen.pressByTestIdAsync('provider-setup-start-card');

        expect(screen.findByTestId('provider-setup-active-claude')).toBeTruthy();
        expect(screen.findAllByTestId('provider-setup-active-codex')).toHaveLength(0);
    });

    it('batch installs the selected providers with a single confirmation', async () => {
        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {
            agentIds: ['codex', 'claude'],
        }));

        await screen.pressByTestIdAsync('provider-setup-start-card');

        expect(modalMock.spies.confirm).toHaveBeenCalledTimes(1);
        expect(capabilitiesState.invoke).toHaveBeenCalledTimes(2);
    });

    it('keeps machine-backed setup controls available on browser web for the settings presentation', async () => {
        tauriDesktopState.value = false;

        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {
            agentIds: ['codex', 'claude'],
            presentation: 'settings',
        }));

        expect(screen.findByTestId('settings.agents.setup.desktopOnlyNotice')).toBeNull();
        expect(screen.findByTestId('setupWizard.providers.webHandoff')).toBeNull();
        expect(screen.findByTestId('provider-setup-start-card')).toBeTruthy();
        expect(screen.findByTestId('provider-setup-option-codex')).toBeTruthy();

        await screen.pressByTestIdAsync('provider-setup-start-card');

        expect(screen.findByTestId('provider-setup-active-codex')).toBeTruthy();
        expect(screen.findByType('AgentAuthenticationCard').props.showActions).toBe(false);
        expect(screen.findAllByType('AgentAuthenticationTerminalPane')).toHaveLength(0);
    });

    it('renders a wizard-friendly CLI handoff on web when running in wizard presentation', async () => {
        tauriDesktopState.value = false;

        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {
            agentIds: ['codex', 'claude'],
            presentation: 'wizard',
        }));

        expect(screen.findByTestId('setupWizard.providers.webHandoff')).toBeTruthy();
        expect(screen.findByTestId('settings.agents.setup.desktopOnlyNotice')).toBeNull();
    });

    it('does not render a misleading generic web handoff command when only headless plugin providers are selected', async () => {
        tauriDesktopState.value = false;

        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {
            presentation: 'wizard',
            agentEntries: [{
                agentId: 'acme.headless.provider',
                catalogAgentId: null,
                title: 'Acme Headless Provider',
                subtitle: 'Plugin provider',
                iconAgentId: 'claude',
                iconName: 'stack-simple',
            }],
        }));

        expect(screen.findByTestId('setupWizard.providers.webHandoff')).toBeTruthy();
        const select = screen.findByType('AgentsLogoMultiSelect' as never) as unknown as {
            props: { agentEntries?: Array<{ agentId: string }> };
        };
        expect(select.props.agentEntries?.map((entry) => entry.agentId)).toEqual(['acme.headless.provider']);
        expect(screen.findAllByType('WizardTerminalHandoff' as never)).toHaveLength(0);
    });

    it('preserves explicit provider entries instead of filtering them through the built-in setup recommendation list', async () => {
        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {
            agentEntries: [
                {
                    agentId: 'codex',
                    catalogAgentId: 'codex',
                    title: 'Codex',
                    iconAgentId: 'codex',
                    iconName: 'code',
                },
                {
                    agentId: 'claude',
                    catalogAgentId: 'claude',
                    title: 'Claude',
                    iconAgentId: 'claude',
                    iconName: 'sparkle',
                },
                {
                    agentId: 'acme.review.provider',
                    catalogAgentId: null,
                    title: 'Acme Review Provider',
                    subtitle: 'Plugin provider',
                    iconAgentId: null,
                    iconName: 'stack-simple',
                },
            ],
        }));

        expect(screen.findByTestId('provider-setup-option-claude')).toBeTruthy();
        expect(screen.findByTestId('provider-setup-option-codex')).toBeTruthy();
        expect(screen.findByTestId('provider-setup-option-acme.review.provider')).toBeTruthy();
        expect(screen.findByTestId('provider-setup-start-card')?.props.disabled).toBe(false);
    });

    it('renders projected plugin providers in setup with plugin identity preserved while using optional backing runtime capabilities', async () => {
        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {
            agentEntries: [{
                agentId: 'acme.review.provider',
                catalogAgentId: 'claude',
                title: 'Acme Review Provider',
                subtitle: 'Plugin provider',
                iconAgentId: 'claude',
                iconName: 'stack-simple',
            }],
        }));

        expect(screen.findByTestId('provider-setup-option-acme.review.provider')).toBeTruthy();

        await screen.pressByTestIdAsync('provider-setup-start-card');

        expect(capabilitiesState.invoke).toHaveBeenCalledWith(
            'machine-target',
            expect.objectContaining({ id: 'cli.claude' }),
            expect.objectContaining({ serverId: 'server-target' }),
        );
        expect(screen.findByTestId('provider-setup-active-acme.review.provider')).toBeTruthy();

        const authCard = screen.findByType('AgentAuthenticationCard' as never) as unknown as {
            props: { agentId: string; runtimeAgentId: string | null };
        };
        expect(authCard.props.agentId).toBe('acme.review.provider');
        expect(authCard.props.runtimeAgentId).toBe('claude');
    });

    it('keeps plugin providers in the setup flow even when they have no built-in runtime carrier', async () => {
        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {
            agentEntries: [{
                agentId: 'acme.headless.provider',
                catalogAgentId: null,
                title: 'Acme Headless Provider',
                subtitle: 'Plugin provider',
                iconAgentId: 'claude',
                iconName: 'stack-simple',
            }],
        }));

        expect(screen.findByTestId('provider-setup-option-acme.headless.provider')).toBeTruthy();
        expect(screen.findByTestId('provider-setup-start-card')?.props.disabled).toBe(true);
    });

    it('keeps explicit ACP-carried provider entries visible without treating them as runnable CLI setup targets', async () => {
        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {
            agentEntries: [{
                agentId: 'acme.acp.provider',
                catalogAgentId: null,
                title: 'Acme ACP Provider',
                subtitle: 'Plugin provider',
                iconAgentId: null,
                iconName: 'stack-simple',
            }],
        }));

        expect(screen.findByTestId('provider-setup-option-acme.acp.provider')).toBeTruthy();
        expect(screen.findByTestId('provider-setup-start-card')?.props.disabled).toBe(true);
    });

    it('defaults to the setup-supported provider set and excludes unsupported providers', async () => {
        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {}));

        expect(screen.findByTestId('provider-setup-option-claude')).toBeTruthy();
        expect(screen.findByTestId('provider-setup-option-codex')).toBeTruthy();
        expect(screen.findByTestId('provider-setup-option-customAcp')).toBeNull();
    });

    it('defaults to settings setup controls on browser web', async () => {
        tauriDesktopState.value = false;

        const { AgentSetupFlow } = await import('./AgentSetupFlow');
        const screen = await renderScreen(React.createElement(AgentSetupFlow, {
            agentIds: ['codex', 'claude'],
        }));

        expect(screen.findByTestId('setupWizard.providers.webHandoff')).toBeNull();
        expect(screen.findByTestId('settings.agents.setup.desktopOnlyNotice')).toBeNull();
        expect(screen.findByTestId('provider-setup-start-card')).toBeTruthy();
        expect(screen.findByTestId('provider-setup-option-codex')).toBeTruthy();
    });
});
