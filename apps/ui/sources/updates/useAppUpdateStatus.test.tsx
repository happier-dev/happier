import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type {
    AppUpdateStatusModel,
    VisibleAppUpdateStatusModel,
} from './updateStatusTypes';

const nativeUpdateState = vi.hoisted(() => ({
    updateUrl: null as string | null,
}));
const desktopUpdateState = vi.hoisted(() => ({
    status: 'idle' as 'idle' | 'checking' | 'available' | 'installing' | 'error' | 'dismissed' | 'upToDate',
    availableVersion: null as string | null,
    error: null as string | null,
    dismiss: vi.fn(),
    refresh: vi.fn(async () => {}),
    startInstall: vi.fn(async () => {}),
}));
const otaUpdateState = vi.hoisted(() => ({
    isUpdatePending: false,
    reloadApp: vi.fn(async () => {}),
}));
const changelogState = vi.hoisted(() => ({
    hasUnread: false,
    markAsRead: vi.fn(),
}));
const routerState = vi.hoisted(() => ({
    push: vi.fn(),
}));
const linkingState = vi.hoisted(() => ({
    canOpenURL: vi.fn<(url: string) => Promise<boolean>>(async () => true),
    openURL: vi.fn<(url: string) => Promise<void>>(async () => {}),
}));
const reactNativeState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));

const expoRouterMock = createExpoRouterMock({
    router: {
        push: routerState.push,
    },
});

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return reactNativeState.os;
            },
        },
        Linking: {
            canOpenURL: (url: string) => linkingState.canOpenURL(url),
            openURL: (url: string) => linkingState.openURL(url),
        },
    });
});

vi.mock('@/desktop/updates/useDesktopUpdater', () => ({
    useDesktopUpdater: () => ({
        status: desktopUpdateState.status,
        availableVersion: desktopUpdateState.availableVersion,
        error: desktopUpdateState.error,
        dismiss: desktopUpdateState.dismiss,
        refresh: desktopUpdateState.refresh,
        startInstall: desktopUpdateState.startInstall,
    }),
}));

vi.mock('@/hooks/inbox/useUpdates', () => ({
    useUpdates: () => ({
        isUpdatePending: otaUpdateState.isUpdatePending,
        reloadApp: otaUpdateState.reloadApp,
    }),
}));

vi.mock('@/hooks/inbox/useChangelog', () => ({
    useChangelog: () => ({
        hasUnread: changelogState.hasUnread,
        markAsRead: changelogState.markAsRead,
    }),
}));

vi.mock('@/hooks/ui/useNativeUpdate', () => ({
    useNativeUpdate: () => nativeUpdateState.updateUrl,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translateLoose: (key: string) => {
            const map: Record<string, string> = {
                'common.retry': 'Retry',
                'common.loading': 'Loading...',
                'common.cancel': 'Cancel',
                'navigation.whatsNew': "What's New",
                'updateBanner.nativeUpdateAvailable': 'Native update available',
                'updateBanner.tapToUpdateAppStore': 'Open the App Store update',
                'updateBanner.tapToUpdatePlayStore': 'Open the Play Store update',
                'updateBanner.updateAvailable': 'Update available',
                'updateBanner.pressToApply': 'Apply update',
                'updateBanner.seeLatest': 'See latest changes',
            };
            return map[key] ?? key;
        },
    });
});

function expectVisibleModel(model: AppUpdateStatusModel): VisibleAppUpdateStatusModel {
    expect(model.visible).toBe(true);
    if (!model.visible) {
        throw new Error('expected a visible app update model');
    }
    return model;
}

describe('useAppUpdateStatus', () => {
    beforeEach(() => {
        reactNativeState.os = 'web';
        nativeUpdateState.updateUrl = null;
        desktopUpdateState.status = 'idle';
        desktopUpdateState.availableVersion = null;
        desktopUpdateState.error = null;
        desktopUpdateState.dismiss.mockReset();
        desktopUpdateState.refresh.mockReset();
        desktopUpdateState.startInstall.mockReset();
        otaUpdateState.isUpdatePending = false;
        otaUpdateState.reloadApp.mockReset();
        changelogState.hasUnread = false;
        changelogState.markAsRead.mockReset();
        routerState.push.mockReset();
        linkingState.canOpenURL.mockReset();
        linkingState.canOpenURL.mockResolvedValue(true);
        linkingState.openURL.mockReset();
        vi.useRealTimers();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('starts the desktop install action and supports dismissal', async () => {
        desktopUpdateState.status = 'available';
        desktopUpdateState.availableVersion = '2.0.0';

        const { useAppUpdateStatus } = await import('./useAppUpdateStatus');
        const hook = await renderHook(() => useAppUpdateStatus());
        await flushHookEffects({ cycles: 1, turns: 2 });

        await hook.getCurrent().runPrimaryAction();
        hook.getCurrent().dismiss();

        const model = expectVisibleModel(hook.getCurrent().model);
        expect(model.kind).toBe('desktop');
        expect(desktopUpdateState.startInstall).toHaveBeenCalledTimes(1);
        expect(desktopUpdateState.refresh).not.toHaveBeenCalled();
        expect(desktopUpdateState.dismiss).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });

    it('retries desktop update checks when the desktop updater is in an error state', async () => {
        desktopUpdateState.status = 'error';
        desktopUpdateState.error = 'network timeout';

        const { useAppUpdateStatus } = await import('./useAppUpdateStatus');
        const hook = await renderHook(() => useAppUpdateStatus());
        await flushHookEffects({ cycles: 1, turns: 2 });

        await hook.getCurrent().runPrimaryAction();

        const model = expectVisibleModel(hook.getCurrent().model);
        expect(model.kind).toBe('desktop');
        expect(desktopUpdateState.refresh).toHaveBeenCalledTimes(1);
        expect(desktopUpdateState.startInstall).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('opens the native store for native update actions', async () => {
        reactNativeState.os = 'ios';
        nativeUpdateState.updateUrl = 'https://apps.apple.com/app/id123';

        const { useAppUpdateStatus } = await import('./useAppUpdateStatus');
        const hook = await renderHook(() => useAppUpdateStatus());
        await flushHookEffects({ cycles: 1, turns: 2 });

        await hook.getCurrent().runPrimaryAction();

        const model = expectVisibleModel(hook.getCurrent().model);
        expect(model.kind).toBe('native-store');
        expect(linkingState.canOpenURL).toHaveBeenCalledWith('https://apps.apple.com/app/id123');
        expect(linkingState.openURL).toHaveBeenCalledWith('https://apps.apple.com/app/id123');

        await hook.unmount();
    });

    it('applies OTA updates through the shared action surface', async () => {
        otaUpdateState.isUpdatePending = true;

        const { useAppUpdateStatus } = await import('./useAppUpdateStatus');
        const hook = await renderHook(() => useAppUpdateStatus());
        await flushHookEffects({ cycles: 1, turns: 2 });

        await hook.getCurrent().runPrimaryAction();

        const model = expectVisibleModel(hook.getCurrent().model);
        expect(model.kind).toBe('ota');
        expect(otaUpdateState.reloadApp).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });

    it('opens the changelog and marks it as read after navigation', async () => {
        changelogState.hasUnread = true;
        vi.useFakeTimers();

        const { useAppUpdateStatus } = await import('./useAppUpdateStatus');
        const hook = await renderHook(() => useAppUpdateStatus());
        await flushHookEffects({ cycles: 1, turns: 2 });

        await hook.getCurrent().runPrimaryAction();
        await vi.advanceTimersByTimeAsync(1000);

        const model = expectVisibleModel(hook.getCurrent().model);
        expect(model.kind).toBe('changelog');
        expect(routerState.push).toHaveBeenCalledWith('/changelog');
        expect(changelogState.markAsRead).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });
});
