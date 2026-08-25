import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runtimeRenderCounts = vi.hoisted(() => ({
    activityBadge: 0,
    activitySurfaces: 0,
    localNotifications: 0,
    desktopActivityOverlay: 0,
    desktopPetOverlay: 0,
    desktopTray: 0,
    desktopTrayDaemon: 0,
    petCompanion: 0,
    onboardingShowcase: 0,
    releaseNotes: 0,
}));
const reverseCaptureMockState = vi.hoisted(() => {
    const disposers = new Map<string, ReturnType<typeof vi.fn>>();
    return {
        disposers,
        installBrowserRecordingReverseCapture: vi.fn((machineId: string) => {
            const dispose = vi.fn();
            disposers.set(machineId, dispose);
            return dispose;
        }),
    };
});
const localDaemonControlMockState = vi.hoisted(() => ({
    status: {
        serviceInstalled: true,
        daemonRunning: true,
        needsAuth: false,
        machineId: null as string | null,
        daemonComparableKey: 'https://relay.example.test',
        daemonAccountId: 'account-local',
        daemonMachineRegistered: true,
    },
}));
const activeServerSnapshotMockState = vi.hoisted(() => ({
    current: {
        serverId: 'server-local',
        serverUrl: 'https://relay.example.test',
        generation: 0,
        activeLocalRelayUrl: null as string | null,
    },
}));

vi.mock('@/activity/badges/ActivityBadgeRuntime', () => ({
    ActivityBadgeRuntime: () => {
        runtimeRenderCounts.activityBadge += 1;
        return React.createElement('ActivityBadgeRuntime');
    },
}));

vi.mock('@/activity/adapters/ios/runtime/ActivitySurfacesRuntime', () => ({
    ActivitySurfacesRuntime: () => {
        runtimeRenderCounts.activitySurfaces += 1;
        return React.createElement('ActivitySurfacesRuntime');
    },
}));

vi.mock('@/activity/notifications/runtime/ActivityLocalNotificationRuntime', () => ({
    ActivityLocalNotificationRuntime: () => {
        runtimeRenderCounts.localNotifications += 1;
        return React.createElement('ActivityLocalNotificationRuntime');
    },
}));

vi.mock('@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime', () => ({
    DesktopActivityOverlayRuntime: () => {
        runtimeRenderCounts.desktopActivityOverlay += 1;
        return React.createElement('DesktopActivityOverlayRuntime');
    },
}));

vi.mock('@/desktop/tray/DesktopTrayRuntime', () => ({
    DesktopTrayRuntime: () => {
        runtimeRenderCounts.desktopTray += 1;
        return React.createElement('DesktopTrayRuntime');
    },
}));

vi.mock('@/desktop/tray/DesktopTrayDaemonLifecycleRuntime', () => ({
    DesktopTrayDaemonLifecycleRuntime: () => {
        runtimeRenderCounts.desktopTrayDaemon += 1;
        return React.createElement('DesktopTrayDaemonLifecycleRuntime');
    },
}));

vi.mock('@/components/pets/runtime/DesktopPetOverlayRuntimeMount', () => ({
    DesktopPetOverlayRuntimeMount: () => {
        runtimeRenderCounts.desktopPetOverlay += 1;
        return React.createElement('DesktopPetOverlayRuntimeMount');
    },
}));

vi.mock('@/components/pets/runtime/PetAppShellCompanionMount', () => ({
    PetAppShellCompanionMount: () => {
        runtimeRenderCounts.petCompanion += 1;
        return React.createElement('PetAppShellCompanionMount');
    },
}));

vi.mock('@/components/markdown/streaming/StreamingTextReveal', () => ({
    StreamingTextReveal: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('StreamingTextReveal', props, props.children),
}));

vi.mock('@/changelog/releaseNotes', () => ({
    ReleaseNotesAutoShowMount: () => {
        runtimeRenderCounts.releaseNotes += 1;
        return React.createElement('ReleaseNotesAutoShowMount');
    },
}));

vi.mock('@/onboarding/showcase', () => ({
    OnboardingShowcaseAutoShowMount: () => {
        runtimeRenderCounts.onboardingShowcase += 1;
        return React.createElement('OnboardingShowcaseAutoShowMount');
    },
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        installBrowserRecordingReverseCapture: reverseCaptureMockState.installBrowserRecordingReverseCapture,
    },
}));

vi.mock('@/components/settings/machines/localControl/useLocalDaemonControl', () => ({
    useLocalDaemonControl: () => ({
        status: localDaemonControlMockState.status,
    }),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshotMockState.current,
}));

afterEach(() => {
    Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: 'node',
    });
    for (const key of Object.keys(runtimeRenderCounts) as Array<keyof typeof runtimeRenderCounts>) {
        runtimeRenderCounts[key] = 0;
    }
    reverseCaptureMockState.installBrowserRecordingReverseCapture.mockClear();
    reverseCaptureMockState.disposers.clear();
    localDaemonControlMockState.status = {
        serviceInstalled: true,
        daemonRunning: true,
        needsAuth: false,
        machineId: null,
        daemonComparableKey: 'https://relay.example.test',
        daemonAccountId: 'account-local',
        daemonMachineRegistered: true,
    };
    activeServerSnapshotMockState.current = {
        serverId: 'server-local',
        serverUrl: 'https://relay.example.test',
        generation: 0,
        activeLocalRelayUrl: null,
    };
    standardCleanup();
});

function setPlatformOS(value: 'android' | 'ios' | 'node' | 'web'): void {
    Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value,
    });
}

describe('AuthenticatedAppRuntimeMounts', () => {
    it('mounts first-open onboarding before auth while keeping release notes authenticated-only', async () => {
        const { AuthenticatedAppRuntimeMounts } = await import('./AuthenticatedAppRuntimeMounts');

        await renderScreen(
            <AuthenticatedAppRuntimeMounts isAuthenticated={false} isDesktopShell={false} />,
        );

        expect(runtimeRenderCounts.onboardingShowcase).toBe(1);
        expect(runtimeRenderCounts.releaseNotes).toBe(0);
    });

    it('keeps runtime mount components stable across equivalent parent updates', async () => {
        const { AuthenticatedAppRuntimeMounts } = await import('./AuthenticatedAppRuntimeMounts');

        const screen = await renderScreen(
            <AuthenticatedAppRuntimeMounts isAuthenticated={true} isDesktopShell={false} />,
        );
        const renderCountsAfterMount = { ...runtimeRenderCounts };

        await screen.update(
            <AuthenticatedAppRuntimeMounts isAuthenticated={true} isDesktopShell={false} />,
        );

        expect(runtimeRenderCounts).toEqual(renderCountsAfterMount);
    });

    it('mounts desktop runtime components only for Tauri desktop hosts', async () => {
        const { AuthenticatedAppRuntimeMounts } = await import('./AuthenticatedAppRuntimeMounts');

        const screen = await renderScreen(
            <AuthenticatedAppRuntimeMounts isAuthenticated={true} isDesktopShell={false} />,
        );
        expect(runtimeRenderCounts.desktopTray).toBe(0);
        expect(runtimeRenderCounts.desktopTrayDaemon).toBe(0);
        expect(runtimeRenderCounts.desktopActivityOverlay).toBe(0);

        await screen.update(
            <AuthenticatedAppRuntimeMounts isAuthenticated={true} isDesktopShell={true} />,
        );

        expect(runtimeRenderCounts.desktopTray).toBe(1);
        expect(runtimeRenderCounts.desktopTrayDaemon).toBe(1);
        expect(runtimeRenderCounts.desktopActivityOverlay).toBe(1);
    });

    it('installs browser recording reverse capture from the authenticated desktop runtime', async () => {
        const previousState = storage.getState();
        const machine = createMachineFixture({
            id: 'machine-desktop-recording',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 1,
        });
        localDaemonControlMockState.status = {
            ...localDaemonControlMockState.status,
            machineId: machine.id,
        };
        try {
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    isDataReady: true,
                    profile: {
                        ...(state.profile ?? {}),
                        id: 'account-local',
                    },
                    machines: {
                        [machine.id]: machine,
                    },
                    machineListByServerId: {},
                }));
            });
            const { AuthenticatedAppRuntimeMounts } = await import('./AuthenticatedAppRuntimeMounts');

            const screen = await renderScreen(
                <AuthenticatedAppRuntimeMounts isAuthenticated={true} isDesktopShell={true} />,
            );

            expect(reverseCaptureMockState.installBrowserRecordingReverseCapture).toHaveBeenCalledWith(machine.id);
            const dispose = reverseCaptureMockState.disposers.get(machine.id);
            expect(dispose).toBeTypeOf('function');

            await screen.update(
                <AuthenticatedAppRuntimeMounts isAuthenticated={false} isDesktopShell={true} />,
            );

            expect(dispose).toHaveBeenCalledTimes(1);
        } finally {
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('installs browser recording reverse capture only for the verified local desktop daemon machine', async () => {
        const previousState = storage.getState();
        const localMachine = createMachineFixture({
            id: 'machine-local-desktop-recording',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 1,
        });
        const remoteMachine = createMachineFixture({
            id: 'machine-remote-desktop-recording',
            createdAt: 2,
            updatedAt: 2,
            activeAt: 2,
        });
        localDaemonControlMockState.status = {
            ...localDaemonControlMockState.status,
            machineId: localMachine.id,
        };
        try {
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    isDataReady: true,
                    profile: {
                        ...(state.profile ?? {}),
                        id: 'account-local',
                    },
                    machines: {
                        [localMachine.id]: localMachine,
                        [remoteMachine.id]: remoteMachine,
                    },
                    machineListByServerId: {},
                }));
            });
            const { AuthenticatedAppRuntimeMounts } = await import('./AuthenticatedAppRuntimeMounts');

            await renderScreen(
                <AuthenticatedAppRuntimeMounts isAuthenticated={true} isDesktopShell={true} />,
            );

            expect(reverseCaptureMockState.installBrowserRecordingReverseCapture).toHaveBeenCalledTimes(1);
            expect(reverseCaptureMockState.installBrowserRecordingReverseCapture).toHaveBeenCalledWith(localMachine.id);
            expect(reverseCaptureMockState.installBrowserRecordingReverseCapture).not.toHaveBeenCalledWith(remoteMachine.id);
        } finally {
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('does not install browser recording reverse capture when local daemon identity is not verified for the active server', async () => {
        const previousState = storage.getState();
        const localMachine = createMachineFixture({
            id: 'machine-local-desktop-recording',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 1,
        });
        localDaemonControlMockState.status = {
            ...localDaemonControlMockState.status,
            machineId: localMachine.id,
            daemonComparableKey: 'https://other-relay.example.test',
        };
        try {
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    isDataReady: true,
                    profile: {
                        ...(state.profile ?? {}),
                        id: 'account-local',
                    },
                    machines: {
                        [localMachine.id]: localMachine,
                    },
                    machineListByServerId: {},
                }));
            });
            const { AuthenticatedAppRuntimeMounts } = await import('./AuthenticatedAppRuntimeMounts');

            await renderScreen(
                <AuthenticatedAppRuntimeMounts isAuthenticated={true} isDesktopShell={true} />,
            );

            expect(reverseCaptureMockState.installBrowserRecordingReverseCapture).not.toHaveBeenCalled();
        } finally {
            await act(async () => {
                storage.setState(previousState);
            });
        }
    });

    it('does not mount the iOS activity surface runtime on Android', async () => {
        setPlatformOS('android');
        const { AuthenticatedAppRuntimeMounts } = await import('./AuthenticatedAppRuntimeMounts');

        await renderScreen(
            <AuthenticatedAppRuntimeMounts isAuthenticated={true} isDesktopShell={false} />,
        );

        expect(runtimeRenderCounts.activitySurfaces).toBe(0);
    });
});
