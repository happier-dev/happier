import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, renderScreen, standardCleanup } from '@/dev/testkit';

const expoRouterMock = createExpoRouterMock({
    router: {
        push: vi.fn(),
        replace: vi.fn(),
    },
});
const activeServerSnapshotMock = vi.hoisted(() => ({
    serverId: 'relay-profile',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));

vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshotMock,
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
vi.mock('@/components/settings/providers/setup/ProviderSetupFlow', () => ({
    ProviderSetupFlow: (props: Record<string, unknown>) => React.createElement('ProviderSetupFlow', props),
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

        const localDaemonControl = screen.findByType('LocalDaemonControlSection' as never);
        expect(localDaemonControl).toBeTruthy();

        expect(screen.findByType('LocalDaemonControlSection' as never)).toBeTruthy();
    });

    it('requires an explicit relay switch confirmation when local relay hosting reports a relay url', async () => {
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

        const setupContinueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = setupContinueButton?.props.action ?? setupContinueButton?.props.onPress;
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

        const setupContinueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = setupContinueButton?.props.action ?? setupContinueButton?.props.onPress;
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

        expect(screen.findByType('ProviderSetupFlow' as never)).toBeTruthy();
    });

    it('switches to the hosted relay when the user confirms switching', async () => {
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

        const setupContinueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = setupContinueButton?.props.action ?? setupContinueButton?.props.onPress;
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

        const introContinueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = introContinueButton?.props.action ?? introContinueButton?.props.onPress;
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

        const introContinueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = introContinueButton?.props.action ?? introContinueButton?.props.onPress;
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
});
