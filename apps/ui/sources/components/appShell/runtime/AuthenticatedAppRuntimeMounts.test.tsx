import * as React from 'react';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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
    releaseNotes: 0,
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

vi.mock('@/changelog/releaseNotes', () => ({
    ReleaseNotesAutoShowMount: () => {
        runtimeRenderCounts.releaseNotes += 1;
        return React.createElement('ReleaseNotesAutoShowMount');
    },
}));

afterEach(() => {
    Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value: 'node',
    });
    for (const key of Object.keys(runtimeRenderCounts) as Array<keyof typeof runtimeRenderCounts>) {
        runtimeRenderCounts[key] = 0;
    }
    standardCleanup();
});

function setPlatformOS(value: 'android' | 'ios' | 'node' | 'web'): void {
    Object.defineProperty(Platform, 'OS', {
        configurable: true,
        value,
    });
}

describe('AuthenticatedAppRuntimeMounts', () => {
    it('keeps runtime mount components stable across equivalent parent updates', async () => {
        const { AuthenticatedAppRuntimeMounts } = await import('./AuthenticatedAppRuntimeMounts');

        const screen = await renderScreen(
            <AuthenticatedAppRuntimeMounts isAuthenticated={true} isTauriDesktopHost={false} />,
        );
        const renderCountsAfterMount = { ...runtimeRenderCounts };

        await screen.update(
            <AuthenticatedAppRuntimeMounts isAuthenticated={true} isTauriDesktopHost={false} />,
        );

        expect(runtimeRenderCounts).toEqual(renderCountsAfterMount);
    });

    it('mounts desktop runtime components only for Tauri desktop hosts', async () => {
        const { AuthenticatedAppRuntimeMounts } = await import('./AuthenticatedAppRuntimeMounts');

        const screen = await renderScreen(
            <AuthenticatedAppRuntimeMounts isAuthenticated={true} isTauriDesktopHost={false} />,
        );
        expect(runtimeRenderCounts.desktopTray).toBe(0);
        expect(runtimeRenderCounts.desktopTrayDaemon).toBe(0);
        expect(runtimeRenderCounts.desktopActivityOverlay).toBe(0);

        await screen.update(
            <AuthenticatedAppRuntimeMounts isAuthenticated={true} isTauriDesktopHost={true} />,
        );

        expect(runtimeRenderCounts.desktopTray).toBe(1);
        expect(runtimeRenderCounts.desktopTrayDaemon).toBe(1);
        expect(runtimeRenderCounts.desktopActivityOverlay).toBe(1);
    });

    it('does not mount the iOS activity surface runtime on Android', async () => {
        setPlatformOS('android');
        const { AuthenticatedAppRuntimeMounts } = await import('./AuthenticatedAppRuntimeMounts');

        await renderScreen(
            <AuthenticatedAppRuntimeMounts isAuthenticated={true} isTauriDesktopHost={false} />,
        );

        expect(runtimeRenderCounts.activitySurfaces).toBe(0);
    });
});
