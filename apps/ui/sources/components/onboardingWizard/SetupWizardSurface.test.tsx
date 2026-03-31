import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

const expoRouterMock = vi.hoisted(() => {
    const push = vi.fn();
    const replace = vi.fn();
    const back = vi.fn();
    const router = { push, replace, back };
    return {
        spies: { push, replace, back },
        module: {
            router,
            useRouter: () => router,
            useNavigation: () => null,
            useSegments: () => [],
            usePathname: () => '/',
            useLocalSearchParams: () => ({}),
            useGlobalSearchParams: () => ({}),
            Stack: Object.assign(
                function Stack(props: { children?: React.ReactNode }) {
                    return React.createElement(React.Fragment, null, props.children ?? null);
                },
                {
                    Screen: (props: Record<string, unknown>) => React.createElement('StackScreen', props),
                },
            ),
            Link: 'Link' as any,
            Redirect: (props: Record<string, unknown>) => React.createElement('Redirect', props),
        },
    };
});
const activeServerSnapshotMock = vi.hoisted(() => ({
    serverId: 'relay-profile',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));

vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>();
    return {
        ...actual,
        getActiveServerSnapshot: () => activeServerSnapshotMock,
    };
});
vi.mock('@/components/settings/machines/MachineSetupFlowScreen', () => ({
    MachineSetupFlowScreen: (props: Record<string, unknown>) => React.createElement('MachineSetupFlowScreen', props),
}));
vi.mock('@/components/settings/machines/localControl/LocalDaemonControlSection', () => ({
    LocalDaemonControlSection: (props: Record<string, unknown>) => React.createElement('LocalDaemonControlSection', props),
}));
vi.mock('@/components/settings/server/localControl/LocalRelayRuntimeControlSection', () => ({
    LocalRelayRuntimeControlSection: (props: Record<string, unknown>) => React.createElement('LocalRelayRuntimeControlSection', props),
}));
vi.mock('@/components/settings/machines/RemoteSshMachineSetupSection', () => ({
    RemoteSshMachineSetupSection: (props: Record<string, unknown>) => React.createElement('RemoteSshMachineSetupSection', props),
}));
vi.mock('./WizardTerminalHandoff', () => ({
    WizardTerminalHandoff: (props: Record<string, unknown>) => React.createElement('WizardTerminalHandoff', props),
}));
vi.mock('@/components/settings/providers/setup/ProviderSetupFlow', () => ({
    ProviderSetupFlow: (props: Record<string, unknown>) => React.createElement('ProviderSetupFlow', props),
}));
const relayDriftBannerMock = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => relayDriftBannerMock.value,
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: Record<string, unknown>) => React.createElement('RelayDriftActionCard', props),
}));
vi.mock('@/components/settings/server/localControl/LocalTailscaleSecureAccessSection', () => ({
    LocalTailscaleSecureAccessSection: (props: Record<string, unknown>) => React.createElement('LocalTailscaleSecureAccessSection', props),
}));
const activeServerSwitchMocks = vi.hoisted(() => ({
    upsertActivateAndSwitchServer: vi.fn(async () => true),
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => activeServerSwitchMocks);

const pendingSetupIntentMocks = vi.hoisted(() => ({
    setPendingSetupIntent: vi.fn(),
}));
vi.mock('@/sync/domains/pending/pendingSetupIntent', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/pending/pendingSetupIntent')>(
        '@/sync/domains/pending/pendingSetupIntent',
    );
    return {
        ...actual,
        setPendingSetupIntent: pendingSetupIntentMocks.setPendingSetupIntent,
    };
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('SetupWizardSurface', () => {
    beforeEach(() => {
        expoRouterMock.spies.push.mockReset();
        expoRouterMock.spies.replace.mockReset();
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';
        activeServerSwitchMocks.upsertActivateAndSwitchServer.mockClear();
        pendingSetupIntentMocks.setPendingSetupIntent.mockClear();
        relayDriftBannerMock.value = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('shows a back button on the first step and returns to /setup', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const backButton = screen.findByTestId('setupWizard.surface-back');
        expect(backButton).toBeTruthy();

        await act(async () => {
            const handler = backButton?.props.action ?? backButton?.props.onPress;
            await handler?.();
        });

        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/setup');
    });

    it('surfaces a relay drift repair banner inside the wizard chooser when present', async () => {
        relayDriftBannerMock.value = { title: 'Drift', description: 'd', actionLabel: 'Repair' };

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        expect(screen.findByType('RelayDriftActionCard' as never)).toBeTruthy();
    });

    it('guides the user from branch selection into the local setup step', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:local');
        expect(localBranch).toBeTruthy();

        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        expect(continueButton).toBeTruthy();

        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('MachineSetupFlowScreen' as never)).toBeTruthy();

        const continueFromLocalSetup = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueFromLocalSetup?.props.action ?? continueFromLocalSetup?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('ProviderSetupFlow' as never)).toBeTruthy();
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
    });

    it('propagates the local machine id to ProviderSetupFlow after local setup completes', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:local');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const localSetup = screen.findByType('MachineSetupFlowScreen' as never) as unknown as {
            props: { onLocalSetupSucceeded?: (machineId: string | null) => void };
        };
        await act(async () => {
            localSetup.props.onLocalSetupSucceeded?.('mach-local');
        });

        const continueFromLocalSetup = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueFromLocalSetup?.props.action ?? continueFromLocalSetup?.props.onPress;
            await handler?.();
        });

        const providerFlow = screen.findByType('ProviderSetupFlow' as never);
        expect(providerFlow.props.machineId).toBe('mach-local');
    });

    it('guides the user from relay hosting branch into the relay runtime step', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const relayBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        expect(relayBranch).toBeTruthy();

        await act(async () => {
            const handler = relayBranch?.props.action ?? relayBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('LocalRelayRuntimeControlSection' as never)).toBeTruthy();
    });

    it('guides web users to continue setup in the terminal or desktop app', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:local');
        expect(localBranch).toBeTruthy();

        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        expect(continueButton).toBeTruthy();

        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-terminal-handoff')).toBeTruthy();
        expect(screen.findAllByType('LocalDaemonControlSection' as never)).toHaveLength(0);

        vi.resetModules();
    });

    it('guides web users selecting remote setup to run the SSH flow from the CLI', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        expect(remoteBranch).toBeTruthy();

        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-terminal-handoff')).toBeTruthy();
        expect(screen.findAllByType('RemoteSshMachineSetupSection' as never)).toHaveLength(0);

        const handoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const sshStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && step.code.includes('happier machine setup --ssh'));
        expect(sshStep).toBeTruthy();
        expect(String(sshStep?.code)).not.toContain('--install-relay-runtime');

        vi.resetModules();
    });

    it('guides web users selecting remote relay hosting to include relay runtime install in the SSH command', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const remoteRelayBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        expect(remoteRelayBranch).toBeTruthy();

        await act(async () => {
            const handler = remoteRelayBranch?.props.action ?? remoteRelayBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-terminal-handoff')).toBeTruthy();

        const handoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const sshStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && step.code.includes('happier machine setup --ssh'));
        expect(sshStep).toBeTruthy();
        expect(String(sshStep?.code)).toContain('--install-relay-runtime');

        vi.resetModules();
    });

    it('guides web users to continue provider setup in the terminal or desktop app', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:local');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        // setup_this_computer handoff (already covered elsewhere)
        expect(screen.findByTestId('setupWizard-terminal-handoff')).toBeTruthy();

        // advance to providers step
        const continueToProviders = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueToProviders?.props.action ?? continueToProviders?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-terminal-handoff')).toBeTruthy();
        expect(screen.findAllByType('ProviderSetupFlow' as never)).toHaveLength(0);
        const providersHandoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const codes = (providersHandoff.props.steps ?? [])
            .map((step) => (typeof step.code === 'string' ? step.code : ''))
            .join('\n');
        expect(codes).toContain('happier providers setup');
        expect(codes).not.toContain('happier auth login');
        expect(codes).not.toContain('curl -fsSL');

        vi.resetModules();
    });

    it('allows users to skip the setup-this-computer step after authentication', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:local');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard.surface-skip')).toBeTruthy();

        vi.resetModules();
    });

    it('preselects relay runtime install when remote relay hosting is chosen on desktop', async () => {
        vi.resetModules();

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteRelayBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteRelayBranch?.props.action ?? remoteRelayBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const remoteSshSection = screen.findByType('RemoteSshMachineSetupSection' as never) as unknown as {
            props: { initialInstallRelayRuntime?: unknown };
        };
        expect(remoteSshSection.props.initialInstallRelayRuntime).toBe(true);

        vi.resetModules();
    });

    it('guides web users selecting secure access (Tailscale) to continue on desktop', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const tailscaleBranch = screen.findByTestId('setupWizard-branch:tailscale');
        await act(async () => {
            const handler = tailscaleBranch?.props.action ?? tailscaleBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-web-tailscale-handoff')).toBeTruthy();
        expect(screen.findAllByType('LocalTailscaleSecureAccessSection' as never)).toHaveLength(0);

        vi.resetModules();
    });

    it('guides web users through local relay hosting via terminal handoff and explicit relay URL paste', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueIntoSetup = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueIntoSetup?.props.action ?? continueIntoSetup?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-web-relay-host-handoff')).toBeTruthy();
        expect(screen.findByTestId('setupWizard-web-relay-download-desktop')).toBeTruthy();
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);

        const relayUrlInput = screen.findByTestId('setupWizard-relay-url-input');
        if (!relayUrlInput) {
            throw new Error('Expected relay url input to be present.');
        }
        await act(async () => {
            relayUrlInput.props.onChangeText?.('https://local-relay.example.test');
        });

        const continueAfterRelayHost = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayHost?.props.action ?? continueAfterRelayHost?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();

        vi.resetModules();
    });

    it('requires an explicit relay switch confirmation when local relay hosting reports a relay url', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const localRelaySection = screen.findByType('LocalRelayRuntimeControlSection' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };

        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl: 'https://local-relay.example.test',
            });
        });

        const proceedAfterRelayHosting = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRelayHosting?.props.action ?? proceedAfterRelayHosting?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();
    });

    it('keeps the current relay by default on the confirmation step', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const localRelaySection = screen.findByType('LocalRelayRuntimeControlSection' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };

        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl: 'https://local-relay.example.test',
            });
        });

        const proceedAfterRelayHosting = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRelayHosting?.props.action ?? proceedAfterRelayHosting?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();
        expect(screen.findByTestId('setupWizard-confirmSwitchRelay.choice:keep')).toBeTruthy();
        expect(screen.findByTestId('setupWizard-confirmSwitchRelay.choice:switch')).toBeTruthy();

        const confirmButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = confirmButton?.props.action ?? confirmButton?.props.onPress;
            await handler?.();
        });

        expect(activeServerSwitchMocks.upsertActivateAndSwitchServer).toHaveBeenCalledTimes(0);
        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledTimes(0);
        expect(expoRouterMock.spies.replace).toHaveBeenCalledTimes(0);

        expect(screen.findAllByType('ProviderSetupFlow' as never)).toHaveLength(0);
    });

    it('switches to the hosted relay when the user confirms switching', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const localRelaySection = screen.findByType('LocalRelayRuntimeControlSection' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };

        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl: 'https://local-relay.example.test',
            });
        });

        const proceedAfterRelayHosting = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRelayHosting?.props.action ?? proceedAfterRelayHosting?.props.onPress;
            await handler?.();
        });

        const switchChoice = screen.findByTestId('setupWizard-confirmSwitchRelay.choice:switch');
        await act(async () => {
            const handler = switchChoice?.props.action ?? switchChoice?.props.onPress;
            await handler?.();
        });

        const confirmButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = confirmButton?.props.action ?? confirmButton?.props.onPress;
            await handler?.();
        });

        expect(activeServerSwitchMocks.upsertActivateAndSwitchServer).toHaveBeenCalledTimes(1);
        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledTimes(1);
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('guides the user from remote setup into the remote SSH step', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        expect(remoteBranch).toBeTruthy();

        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('RemoteSshMachineSetupSection' as never)).toBeTruthy();
    });

    it('requires an explicit relay switch confirmation when remote relay hosting completes', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const remoteSection = screen.findByType('RemoteSshMachineSetupSection' as never) as unknown as {
            props: { onCompletedChange?: (payload: { machineId: string | null; serverId: string | null; relayRuntimeUrl: string | null }) => void };
        };

        await act(async () => {
            remoteSection.props.onCompletedChange?.({
                machineId: 'mach-1',
                serverId: 'relay-profile',
                relayRuntimeUrl: 'https://remote-relay.example.test',
            });
        });

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();

        const switchChoice = screen.findByTestId('setupWizard-confirmSwitchRelay.choice:switch');
        await act(async () => {
            const handler = switchChoice?.props.action ?? switchChoice?.props.onPress;
            await handler?.();
        });

        const confirmButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = confirmButton?.props.action ?? confirmButton?.props.onPress;
            await handler?.();
        });

        expect(activeServerSwitchMocks.upsertActivateAndSwitchServer).toHaveBeenCalledTimes(1);
        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledWith(expect.objectContaining({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://remote-relay.example.test',
            machineId: 'mach-1',
        }));
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('propagates the remote machine id to ProviderSetupFlow after remote SSH bootstrap completes', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const remoteSection = screen.findByType('RemoteSshMachineSetupSection' as never) as unknown as {
            props: { onCompletedChange?: (payload: { machineId: string | null; serverId: string | null; relayRuntimeUrl: string | null }) => void };
        };

        await act(async () => {
            remoteSection.props.onCompletedChange?.({
                machineId: 'mach-remote',
                serverId: 'relay-profile',
                relayRuntimeUrl: null,
            });
        });

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        const providerFlow = screen.findByType('ProviderSetupFlow' as never);
        expect(providerFlow).toBeTruthy();
        expect(providerFlow.props.machineId).toBe('mach-remote');
    });
});
