import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
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

const setupThisComputerWizardStepMock = vi.hoisted(() => ({
    forceBackHidden: false,
}));

vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshotMock,
    subscribeActiveServer: () => () => {},
    upsertServerProfileOnly: (profile: { serverUrl: string }) => ({
        id: `profile:${profile.serverUrl}`,
        name: profile.serverUrl,
        serverUrl: profile.serverUrl,
    }),
}));
vi.mock('../steps/SetupThisComputerWizardStep', () => ({
    SetupThisComputerWizardStep: (props: Record<string, unknown>) => {
        React.useEffect(() => {
            if (!setupThisComputerWizardStepMock.forceBackHidden) return;
            const onWizardBackChange = props.onWizardBackChange as undefined | ((next: { hidden?: boolean }) => void);
            onWizardBackChange?.({ hidden: true });
        }, [props]);
        return React.createElement('SetupThisComputerWizardStep', props);
    },
}));
vi.mock('@/components/settings/machines/localControl/LocalDaemonControlSection', () => ({
    LocalDaemonControlSection: (props: Record<string, unknown>) => React.createElement('LocalDaemonControlSection', props),
}));
vi.mock('../checklists/relayHostLocal/RelayHostLocalChecklistStep', () => ({
    RelayHostLocalChecklistStep: (props: Record<string, unknown>) => React.createElement('RelayHostLocalChecklistStep', props),
}));
vi.mock('../checklists/remoteSsh/RemoteSshChecklistStep', () => ({
    RemoteSshChecklistStep: (props: Record<string, unknown>) => React.createElement('RemoteSshChecklistStep', props),
}));
vi.mock('../ui/WizardTerminalHandoff', () => ({
    WizardTerminalHandoff: (props: Record<string, unknown>) => React.createElement('WizardTerminalHandoff', props),
}));
vi.mock('../steps/ProvidersLogoMultiSelect', () => ({
    ProvidersLogoMultiSelect: (props: Record<string, unknown>) => React.createElement('ProvidersLogoMultiSelect', props),
}));
vi.mock('../steps/relayAccess/RelayAccessPrerequisitesStep', () => ({
    RelayAccessPrerequisitesStep: (props: Record<string, unknown>) => React.createElement('RelayAccessPrerequisitesStep', props),
}));
vi.mock('../steps/WizardProviderSetupStep', () => ({
    WizardProviderSetupStep: (props: Record<string, unknown>) => React.createElement('WizardProviderSetupStep', props),
}));
vi.mock('@/components/settings/providers/setup/ProviderSetupFlow', () => ({
    ProviderSetupFlow: (props: Record<string, unknown>) => React.createElement('ProviderSetupFlow', props),
}));
vi.mock('@/modal/portal/ModalPortalTarget', () => ({
    ModalPortalTargetProvider: (props: Record<string, unknown>) =>
        React.createElement(React.Fragment, null, props.children as React.ReactNode),
    useModalPortalTarget: () => null,
    useHasModalPortalTargetProvider: () => false,
}));
const relayDriftBannerMock = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => relayDriftBannerMock.value,
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: Record<string, unknown>) => React.createElement('RelayDriftActionCard', props),
}));
vi.mock('@/components/settings/server/localControl/LocalRelayAccessControlSection', () => ({
    LocalRelayAccessControlSection: (props: Record<string, unknown>) => React.createElement('LocalRelayAccessControlSection', props),
}));
const activeServerSwitchMocks = vi.hoisted(() => ({
    upsertActivateAndSwitchServer: vi.fn(async () => true),
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => activeServerSwitchMocks);

const pendingSetupIntentMocks = vi.hoisted(() => ({
    getPendingSetupIntent: vi.fn(),
    setPendingSetupIntent: vi.fn(),
}));
vi.mock('@/sync/domains/pending/pendingSetupIntent', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/pending/pendingSetupIntent')>(
        '@/sync/domains/pending/pendingSetupIntent',
    );
    return {
        ...actual,
        getPendingSetupIntent: pendingSetupIntentMocks.getPendingSetupIntent,
        setPendingSetupIntent: pendingSetupIntentMocks.setPendingSetupIntent,
    };
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
}));

describe('SetupWizardSurface', () => {
    beforeEach(() => {
        expoRouterMock.spies.push.mockReset();
        expoRouterMock.spies.replace.mockReset();
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';
        activeServerSwitchMocks.upsertActivateAndSwitchServer.mockClear();
        pendingSetupIntentMocks.getPendingSetupIntent.mockReset();
        pendingSetupIntentMocks.setPendingSetupIntent.mockClear();
        relayDriftBannerMock.value = null;
        setupThisComputerWizardStepMock.forceBackHidden = false;
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

    it('hides the back button when the active step requests it', async () => {
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

        expect(screen.findByType('RemoteSshChecklistStep' as never)).toBeTruthy();
        await act(async () => {
            const step = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
                props: { onWizardBackChange?: (next: { hidden?: boolean }) => void };
            };
            step.props.onWizardBackChange?.({ hidden: true });
            await flushHookEffects();
        });
        expect(screen.findByTestId('setupWizard.surface-back')).toBeFalsy();
    });

    it('hides local relay hosting when setup surface policy denies it', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowLocalRelayHost';
        try {
            const { SetupWizardSurface } = await import('./SetupWizardSurface');
            const screen = await renderScreen(React.createElement(SetupWizardSurface, { isDesktopShell: true }));

            expect(screen.findByTestId('setupWizard-branch:relayLocal')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('hides remote SSH setup when setup surface policy denies it', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY =
            'setup.relay.allowRemoteSshRelayHost,setup.machine.allowRemoteSshMachineSetup';
        try {
            const { SetupWizardSurface } = await import('./SetupWizardSurface');
            const screen = await renderScreen(React.createElement(SetupWizardSurface, { isDesktopShell: true }));

            expect(screen.findByTestId('setupWizard-branch:remote')).toBeNull();
            expect(screen.findByTestId('setupWizard-branch:remoteRelay')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('persists the remote machine branch as soon as it is selected', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledWith(expect.objectContaining({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
            machineId: null,
            remoteSetupIntent: 'remoteMachine',
        }));
    });

    it('persists the remote relay-host branch as soon as it is selected', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteRelayBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteRelayBranch?.props.action ?? remoteRelayBranch?.props.onPress;
            await handler?.();
        });

        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledWith(expect.objectContaining({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
            machineId: null,
            remoteSetupIntent: 'remoteRelayHost',
        }));
    });

    it('surfaces a relay drift repair banner inside the wizard chooser when present', async () => {
        relayDriftBannerMock.value = { title: 'Drift', description: 'd', actionLabel: 'Repair' };

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        expect(screen.findByType('RelayDriftActionCard' as never)).toBeTruthy();
    });

    it('filters the chooser to relay-related options when scope=relay', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
            scope: 'relay',
        }));

        expect(screen.findByTestId('setupWizard-branch:local')).toBeFalsy();
        expect(screen.findByTestId('setupWizard-branch:remote')).toBeFalsy();
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

        const localSetup = screen.findByType('SetupThisComputerWizardStep' as never);
        expect(localSetup).toBeTruthy();
        expect((localSetup.props as { autoStart?: unknown }).autoStart).toBeUndefined();

        await act(async () => {
            await (localSetup.props.onSucceeded as any)?.('machine-1');
        });

        const continueFromLocalSetup = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueFromLocalSetup?.props.action ?? continueFromLocalSetup?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('WizardProviderSetupStep' as never)).toBeTruthy();
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
    });

    it('propagates the local machine id to the providers wizard step after local setup completes', async () => {
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

        const localSetup = screen.findByType('SetupThisComputerWizardStep' as never) as unknown as {
            props: { onSucceeded?: (machineId: string | null) => void };
        };
        await act(async () => {
            localSetup.props.onSucceeded?.('mach-local');
        });

        const continueFromLocalSetup = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueFromLocalSetup?.props.action ?? continueFromLocalSetup?.props.onPress;
            await handler?.();
        });

        const providersStep = screen.findByType('WizardProviderSetupStep' as never);
        expect(providersStep.props.machineId).toBe('mach-local');
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

        expect(screen.findByType('RelayHostLocalChecklistStep' as never)).toBeTruthy();
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

        expect(screen.findByTestId('setupWizard-web-machine-setup-handoff-terminal')).toBeTruthy();
        expect(screen.findAllByType('LocalDaemonControlSection' as never)).toHaveLength(0);

        const handoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown; windowsCode?: unknown }> };
        };
        const codes = (handoff.props.steps ?? [])
            .map((step) => (typeof step.code === 'string' ? step.code : ''))
            .join('\n');
        expect(codes).toContain('--run setup');
        expect(codes).toContain('--relay-url https://relay.example.test');
        expect(codes).not.toContain('happier auth login');
        expect(codes).not.toContain('happier daemon install');
        expect(codes).toContain('curl -fsSL');
        const windowsCodes = (handoff.props.steps ?? [])
            .map((step) => (typeof step.windowsCode === 'string' ? step.windowsCode : ''))
            .join('\n');
        expect(windowsCodes).toContain('install.ps1');

        vi.resetModules();
    });

    it('guides native users to continue setup on a desktop instead of starting system tasks locally', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'ios' } }));

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

        expect(screen.findByTestId('setupWizard-web-machine-setup-handoff-terminal')).toBeTruthy();
        expect(screen.findAllByType('SetupThisComputerWizardStep' as never)).toHaveLength(0);

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
        expect(screen.findAllByType('RemoteSshChecklistStep' as never)).toHaveLength(0);

        const handoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const sshStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && step.code.includes('happier machine setup --ssh'));
        expect(sshStep).toBeTruthy();
        expect(String(sshStep?.code)).not.toContain('--install-relay-runtime');

        const setupPrereqStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && String(step.code).includes('--run setup')) as
            | { code?: unknown; windowsCode?: unknown }
            | undefined;
        expect(setupPrereqStep).toBeTruthy();
        expect(String(setupPrereqStep?.windowsCode ?? '')).toContain('install.ps1');
        expect(String(setupPrereqStep?.code)).not.toContain('--skip-daemon');

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

    it('allows web users to fill SSH credentials and reflects them in the CLI handoff command', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
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

        const usernameInput = screen.findByTestId('setupWizard-web-remote-ssh-sshUsernameInput');
        const hostInput = screen.findByTestId('setupWizard-web-remote-ssh-sshHostInput');
        const portInput = screen.findByTestId('setupWizard-web-remote-ssh-sshPortInput');
        if (!usernameInput || !hostInput || !portInput) {
            throw new Error('Expected SSH fields to be rendered for the remote setup handoff.');
        }

        await act(async () => {
            usernameInput.props.onChangeText?.('dev');
            hostInput.props.onChangeText?.('example.test');
            portInput.props.onChangeText?.('2222');
        });

        const handoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const sshStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && step.code.includes('happier machine setup'));
        expect(sshStep).toBeTruthy();
        expect(String(sshStep?.code)).toContain('--ssh-user dev');
        expect(String(sshStep?.code)).toContain('--ssh-host example.test');
        expect(String(sshStep?.code)).toContain('--ssh-port 2222');
        expect(String(sshStep?.code)).toContain('--ssh-auth agent');

        vi.resetModules();
    });

    it('includes password auth in the web remote SSH handoff without retaining the password itself', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
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

        await act(async () => {
            screen.changeTextByTestId('setupWizard-web-remote-ssh-sshUsernameInput', 'dev');
            screen.changeTextByTestId('setupWizard-web-remote-ssh-sshHostInput', 'relay.example.test');
            screen.changeTextByTestId('setupWizard-web-remote-ssh-sshPortInput', '2222');
        });

        const passwordAuth = screen.findByTestId('setupWizard-web-remote-ssh-sshAuthMethod:password')!;
        await act(async () => {
            await passwordAuth.props.onPress?.();
        });

        await act(async () => {
            screen.changeTextByTestId('setupWizard-web-remote-ssh-sshPasswordInput', 'super-secret');
        });

        const handoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const sshStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && step.code.includes('happier machine setup'));
        expect(sshStep).toBeTruthy();
        expect(String(sshStep?.code)).toContain('--ssh-user dev');
        expect(String(sshStep?.code)).toContain('--ssh-host relay.example.test');
        expect(String(sshStep?.code)).toContain('--ssh-port 2222');
        expect(String(sshStep?.code)).toContain('--ssh-auth password');
        expect(String(sshStep?.code)).not.toContain('--identity-file');

        const backButton = screen.findByTestId('setupWizard.back') ?? screen.findByTestId('setupWizard.surface-back');
        await act(async () => {
            await backButton?.props.action?.();
            await backButton?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteRelayBranchAgain = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteRelayBranchAgain?.props.action ?? remoteRelayBranchAgain?.props.onPress;
            await handler?.();
        });
        const continueAgain = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAgain?.props.action ?? continueAgain?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-web-remote-ssh-sshPasswordInput')?.props.value).toBe('');

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
        expect(screen.findByTestId('setupWizard-web-machine-setup-handoff')).toBeTruthy();

        // advance to providers step
        const continueToProviders = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueToProviders?.props.action ?? continueToProviders?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-web-providers-handoff')).toBeTruthy();
        expect(screen.findAllByType('ProviderSetupFlow' as never)).toHaveLength(0);
        const providersHandoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const codes = (providersHandoff.props.steps ?? [])
            .map((step) => (typeof step.code === 'string' ? step.code : ''))
            .join('\n');
        expect(codes).toContain('curl -fsSL https://happier.dev/install | bash');
        expect(codes).toContain('--run providers-setup');
        expect(codes).not.toContain('happier auth login');
        expect(codes).not.toContain('happier providers setup');

        const providersSelect = screen.findByType('ProvidersLogoMultiSelect' as never) as unknown as {
            props: { providerIds?: readonly string[]; onToggleProvider?: (providerId: string) => void };
        };
        await act(async () => {
            providersSelect.props.onToggleProvider?.('claude');
            providersSelect.props.onToggleProvider?.('codex');
        });

        const updatedProvidersHandoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const updatedCodes = (updatedProvidersHandoff.props.steps ?? [])
            .map((step) => (typeof step.code === 'string' ? step.code : ''))
            .join('\n');
        expect(updatedCodes).toContain('--run providers-setup');
        expect(updatedCodes).toContain('--providers claude,codex');

        vi.resetModules();
    });

    it('shows only setup-supported providers in the web provider selector', async () => {
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

        await act(async () => {
            const handler = screen.findByTestId('setupWizard.surface-primary')?.props.action
                ?? screen.findByTestId('setupWizard.surface-primary')?.props.onPress;
            await handler?.();
        });

        const providersSelect = screen.findByType('ProvidersLogoMultiSelect' as never) as unknown as {
            props: { providerIds?: readonly string[] };
        };
        expect(providersSelect.props.providerIds).toContain('claude');
        expect(providersSelect.props.providerIds).toContain('codex');
        expect(providersSelect.props.providerIds).not.toContain('customAcp');

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

        const remoteSshSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: { initialInstallRelayRuntime?: unknown };
        };
        expect(remoteSshSection.props.initialInstallRelayRuntime).toBe(true);

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

        expect(screen.findByTestId('setupWizard-web-relay-access-handoff')).toBeTruthy();

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
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

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
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

        expect(screen.findByType('LocalRelayAccessControlSection' as never)).toBeTruthy();

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();
    });

    it('inserts a relay access step before switching to a newly hosted relay', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const relayBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = relayBranch?.props.action ?? relayBranch?.props.onPress;
            await handler?.();
        });

        const continueToHost = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueToHost?.props.action ?? continueToHost?.props.onPress;
            await handler?.();
        });

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };
        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl: 'https://local-relay.example.test',
            });
        });

        const continueAfterHosted = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterHosted?.props.action ?? continueAfterHosted?.props.onPress;
            await handler?.();
        });

        const relayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: Record<string, unknown>;
        };
        expect(relayAccessSection).toBeTruthy();
        expect(relayAccessSection.props.presentation).toBe('wizard');
        expect(relayAccessSection.props.serverProfileId).toEqual(expect.any(String));
        expect(typeof relayAccessSection.props.onWizardPrimaryChange).toBe('function');
        expect(typeof relayAccessSection.props.onRequestAdvance).toBe('function');
        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeNull();

        const continueAfterAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterAccess?.props.action ?? continueAfterAccess?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();
    });

    it.each([
        ['lan', 'https://local-relay.example.test'],
    ] as const)('routes %s relay access requests to the prerequisites step', async (providerId, relayUrl) => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const relayBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = relayBranch?.props.action ?? relayBranch?.props.onPress;
            await handler?.();
        });

        const continueToHost = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueToHost?.props.action ?? continueToHost?.props.onPress;
            await handler?.();
        });

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };
        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl,
            });
        });

        const continueAfterHosted = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterHosted?.props.action ?? continueAfterHosted?.props.onPress;
            await handler?.();
        });

        const relayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: {
                onWizardRequestProviderDetails?: (nextProviderId: 'lan' | 'cloudflareNamed') => void;
                target?: Readonly<{ kind: 'local' }> | Readonly<{
                    kind: 'ssh';
                    ssh: Readonly<{
                        target: string;
                        auth: 'agent' | 'keyfile' | 'password';
                    }>;
                }>;
            };
        };
        expect(relayAccessSection.props.target).toEqual({ kind: 'local' });
        await act(async () => {
            relayAccessSection.props.onWizardRequestProviderDetails?.(providerId);
        });

        const prereqsStep = screen.findByType('RelayAccessPrerequisitesStep' as never) as unknown as {
            props: {
                providerId?: string;
                upstreamUrl?: string | null;
                target?: Readonly<{ kind: 'local' }> | Readonly<{
                    kind: 'ssh';
                    ssh: Readonly<{
                        target: string;
                        auth: 'agent' | 'keyfile' | 'password';
                    }>;
                }>;
            };
        };
        expect(prereqsStep.props.providerId).toBe(providerId);
        expect(prereqsStep.props.upstreamUrl).toBe(relayUrl);
        expect(prereqsStep.props.target).toEqual({ kind: 'local' });
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

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
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

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
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

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
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

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
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

        expect(screen.findByType('RemoteSshChecklistStep' as never)).toBeTruthy();
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

        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: {
                onCompleted?: (payload: {
                    machineId: string | null;
                    relayRuntimeUrl: string | null;
                    relayAccessTarget?: {
                        kind: 'ssh';
                        ssh: {
                            target: string;
                            auth: 'agent' | 'keyfile' | 'password';
                        };
                    } | null;
                    mode: string;
                }) => void;
            };
        };

        await act(async () => {
            remoteSection.props.onCompleted?.({
                machineId: 'mach-1',
                relayRuntimeUrl: 'https://remote-relay.example.test',
                relayAccessTarget: {
                    kind: 'ssh',
                    ssh: {
                        target: 'root@remote.example.test',
                        auth: 'agent',
                    },
                },
                mode: 'remoteRelayHost',
            });
        });

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        const relayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: {
                target?: Readonly<{ kind: 'local' }> | Readonly<{
                    kind: 'ssh';
                    ssh: Readonly<{
                        target: string;
                        auth: 'agent' | 'keyfile' | 'password';
                    }>;
                }>;
            };
        };
        expect(relayAccessSection.props.target).toEqual({
            kind: 'ssh',
            ssh: {
                target: 'root@remote.example.test',
                auth: 'agent',
            },
        });

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
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
            remoteSetupIntent: 'remoteRelayHost',
        }));
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('restores the remote relay-host branch when resuming from a pending intent', async () => {
        pendingSetupIntentMocks.setPendingSetupIntent.mockImplementation(() => undefined);
        pendingSetupIntentMocks.getPendingSetupIntent.mockReturnValue({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://remote-relay.example.test',
            machineId: 'mach-1',
            remoteSetupIntent: 'remoteRelayHost',
        });

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        expect(screen.findByType('RemoteSshChecklistStep' as never)).toBeTruthy();
        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: { initialInstallRelayRuntime?: unknown };
        };
        expect(remoteSection.props.initialInstallRelayRuntime).toBe(true);
    });

    it('propagates the remote machine id to the providers wizard step after remote SSH bootstrap completes', async () => {
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

        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: {
                onCompleted?: (payload: {
                    machineId: string | null;
                    relayRuntimeUrl: string | null;
                    relayAccessTarget?: {
                        kind: 'ssh';
                        ssh: {
                            target: string;
                            auth: 'agent' | 'keyfile' | 'password';
                        };
                    } | null;
                    mode: string;
                }) => void;
            };
        };

        await act(async () => {
            remoteSection.props.onCompleted?.({
                machineId: 'mach-remote',
                relayRuntimeUrl: null,
                relayAccessTarget: null,
                mode: 'remoteMachine',
            });
        });

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        const providersStep = screen.findByType('WizardProviderSetupStep' as never);
        expect(providersStep).toBeTruthy();
        expect(providersStep.props.machineId).toBe('mach-remote');
    });
});
