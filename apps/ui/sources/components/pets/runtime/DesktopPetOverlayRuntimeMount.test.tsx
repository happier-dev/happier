import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { PetCompanionActivityModel } from '@/components/pets/activity';
import type { Settings } from '@/sync/domains/settings/settings';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import * as overlayPolicy from '@/components/pets/desktop/policy/resolveDesktopPetOverlayPolicy';
import { DesktopPetOverlayRuntimeMount } from './DesktopPetOverlayRuntimeMount';

type AccountPetsSettingsSubset = Pick<
    Settings,
    'petsEnabled' | 'petsDesktopOverlayDefaultEnabled'
>;

type LocalPetsSettingsSubset = Pick<
    LocalSettings,
    | 'petsEnabledOverride'
    | 'desktopPetOverlayEnabledOverride'
    | 'desktopPetOverlayAnchor'
    | 'desktopPetOverlayLocked'
> & { petsCompanionSizeScale: number };

const desktopRuntimeProps = vi.hoisted(() => ({
    calls: [] as Record<string, unknown>[],
}));
const listenDesktopPetOverlayShowMainWindowRequestedMock = vi.hoisted(() =>
    vi.fn(async (_handler: (payload: { targetServerId?: string; targetSessionId?: string }) => void | Promise<void>) => () => {}),
);
const executePetOverlayMainWindowActionMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const createDefaultActionExecutorMock = vi.hoisted(() =>
    vi.fn(() => ({
        execute: executePetOverlayMainWindowActionMock,
    })),
);
const featureState = vi.hoisted(() => ({
    companionEnabled: true,
}));
const platformState = vi.hoisted(() => ({
    os: 'web',
    tauri: true,
    pending: false,
}));
const activityState = vi.hoisted((): { current: PetCompanionActivityModel } => ({
    current: {
        state: 'working',
        address: { serverId: 'server-a', sessionId: 'session-running' },
        sessionId: 'session-running',
        trayItems: [
            {
                id: 'running:session-running:live',
                dismissKey: 'running:session-running:live',
                address: { serverId: 'server-a', sessionId: 'session-running' },
                sessionId: 'session-running',
                contextLine: 'Home A',
                accessibilityContext: null,
                activity: 'working',
                title: 'Running session',
                subtitle: null,
                actions: {
                    open: true,
                    dismiss: true,
                    quickReply: true,
                },
            },
        ],
    },
}));
const accountSettingsState = vi.hoisted((): { current: AccountPetsSettingsSubset } => ({
    current: {
        petsEnabled: true,
        petsDesktopOverlayDefaultEnabled: true,
    },
}));
const localSettingsState = vi.hoisted((): { current: LocalPetsSettingsSubset } => ({
    current: {
        petsEnabledOverride: 'inherit',
        desktopPetOverlayEnabledOverride: 'inherit',
        desktopPetOverlayAnchor: 'bottomRight',
        desktopPetOverlayLocked: false,
        petsCompanionSizeScale: 1,
    },
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => platformState.tauri,
    useDesktopHostRoleAvailability: () => platformState.pending ? null : platformState.tauri
        ? { kind: 'available' } : { kind: 'unavailable', reason: 'electron_overlay_unavailable' },
}));

vi.mock('@/components/pets/desktop/runtime/DesktopPetOverlayRuntime', () => ({
    DesktopPetOverlayRuntime: (props: Record<string, unknown>) => {
        desktopRuntimeProps.calls.push(props);
        return React.createElement('DesktopPetOverlayRuntime', props);
    },
}));

vi.mock('@/components/pets/desktop/bridge/desktopPetOverlayBridge', () => ({
    listenDesktopPetOverlayShowMainWindowRequested: listenDesktopPetOverlayShowMainWindowRequestedMock,
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: createDefaultActionExecutorMock,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => (sessionId === 'session-from-tray' ? 'server-pets' : null),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'pets.companion' && featureState.companionEnabled,
}));

vi.mock('@/components/pets/activity', () => ({
    usePetCompanionActivityModel: () => activityState.current,
}));

vi.mock('@/components/pets/source/useSelectedPetPackage', () => ({
    useSelectedPetPackage: () => ({
        enabled: true,
        source: { kind: 'builtIn', petId: 'happier-cat' },
        fallback: null,
    }),
}));

describe('DesktopPetOverlayRuntimeMount', () => {
    beforeEach(async () => {
        getPersistenceStorage().clearAll();
        await storage.getState().activateSettingsScope({ serverId: 'pets-home', accountId: 'pets-account' });
        storage.getState().applySettings({ ...settingsDefaults, ...accountSettingsState.current }, 1);
        storage.getState().applyLocalSettings({ ...localSettingsDefaults, ...localSettingsState.current }, { persist: false });
        vi.useFakeTimers();
        vi.setSystemTime(12_000);
        activityState.current = {
            state: 'working',
            address: { serverId: 'server-a', sessionId: 'session-running' },
            sessionId: 'session-running',
            trayItems: [
                {
                    id: 'running:session-running:live',
                    dismissKey: 'running:session-running:live',
                    address: { serverId: 'server-a', sessionId: 'session-running' },
                    sessionId: 'session-running',
                    contextLine: 'Home A',
                    accessibilityContext: null,
                    activity: 'working',
                    title: 'Running session',
                    subtitle: null,
                    actions: {
                        open: true,
                        dismiss: true,
                        quickReply: true,
                    },
                },
            ],
        };
        listenDesktopPetOverlayShowMainWindowRequestedMock.mockResolvedValue(() => {});
        executePetOverlayMainWindowActionMock.mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
        desktopRuntimeProps.calls = [];
        listenDesktopPetOverlayShowMainWindowRequestedMock.mockReset();
        executePetOverlayMainWindowActionMock.mockReset();
        createDefaultActionExecutorMock.mockClear();
        featureState.companionEnabled = true;
        activityState.current = {
            state: 'working',
            address: { serverId: 'server-a', sessionId: 'session-running' },
            sessionId: 'session-running',
            trayItems: [
                {
                    id: 'running:session-running:live',
                    dismissKey: 'running:session-running:live',
                    address: { serverId: 'server-a', sessionId: 'session-running' },
                    sessionId: 'session-running',
                    contextLine: 'Home A',
                    accessibilityContext: null,
                    activity: 'working',
                    title: 'Running session',
                    subtitle: null,
                    actions: {
                        open: true,
                        dismiss: true,
                        quickReply: true,
                    },
                },
            ],
        };
        accountSettingsState.current = {
            petsEnabled: true,
            petsDesktopOverlayDefaultEnabled: true,
        };
        localSettingsState.current = {
            petsEnabledOverride: 'inherit',
            desktopPetOverlayEnabledOverride: 'inherit',
            desktopPetOverlayAnchor: 'bottomRight',
            desktopPetOverlayLocked: false,
            petsCompanionSizeScale: 1,
        };
        platformState.os = 'web';
        platformState.tauri = true;
        platformState.pending = false;
        delete (globalThis as Partial<{ window: unknown }>).window;
    });

    it('mounts the desktop runtime without a hidden duplicate companion surface in the main app tree', async () => {

        const screen = await renderScreen(<DesktopPetOverlayRuntimeMount />);

        expect(screen.findByTestId('pet-companion-state')).toBeNull();
        expect(desktopRuntimeProps.calls[0]).toMatchObject({
            visible: true,
            expanded: true,
            policy: {
                enabled: true,
                alwaysOnTop: true,
                inputLocked: false,
                anchor: 'bottomRight',
            },
        });
        expect(desktopRuntimeProps.calls[0]?.window).toEqual({
            width: expect.any(Number),
            height: expect.any(Number),
        });
        expect((desktopRuntimeProps.calls[0]?.window as { width: number }).width).toBeGreaterThanOrEqual(320);
        expect((desktopRuntimeProps.calls[0]?.window as { height: number }).height).toBeGreaterThanOrEqual(280);
    });

    it('opens tray target sessions from native main-window requests in the main app runtime', async () => {
        let requestHandler: ((payload: { targetServerId?: string; targetSessionId?: string }) => void | Promise<void>) | null = null;
        listenDesktopPetOverlayShowMainWindowRequestedMock.mockImplementation(async (handler) => {
            requestHandler = handler;
            return () => {};
        });

        await renderScreen(<DesktopPetOverlayRuntimeMount />);

        expect(listenDesktopPetOverlayShowMainWindowRequestedMock).toHaveBeenCalledTimes(1);
        expect(createDefaultActionExecutorMock).toHaveBeenCalledWith(expect.objectContaining({
            resolveServerIdForSessionId: expect.any(Function),
            openSession: expect.any(Function),
        }));
        expect(requestHandler).not.toBeNull();

        await act(async () => {
            await requestHandler?.({
                targetServerId: 'server-pets',
                targetSessionId: 'session-from-tray',
            });
        });

        expect(executePetOverlayMainWindowActionMock).toHaveBeenCalledWith(
            'session.open',
            { sessionId: 'session-from-tray' },
            {
                defaultSessionId: 'session-from-tray',
                serverId: 'server-pets',
            },
        );
    });

    it('shows the desktop pet overlay when enabled even if the companion is idle', async () => {
        activityState.current = {
            state: 'quiet',
            address: null,
            sessionId: null,
            trayItems: [],
        };

        const screen = await renderScreen(<DesktopPetOverlayRuntimeMount />);

        expect(screen.findByTestId('pet-companion-state')).toBeNull();
        expect(desktopRuntimeProps.calls[0]).toMatchObject({
            visible: true,
            expanded: false,
            policy: {
                enabled: true,
            },
        });
        expect((desktopRuntimeProps.calls[0]?.window as { width: number }).width).toBeLessThan(192);
        expect((desktopRuntimeProps.calls[0]?.window as { height: number }).height).toBeLessThan(208);
    });

    it('sizes the compact desktop overlay window from the local companion size scale', async () => {
        activityState.current = {
            state: 'quiet',
            address: null,
            sessionId: null,
            trayItems: [],
        };
        localSettingsState.current = {
            ...localSettingsState.current,
            petsCompanionSizeScale: 1.5,
        };
        storage.getState().applyLocalSettings(localSettingsState.current, { persist: false });

        await renderScreen(<DesktopPetOverlayRuntimeMount />);

        expect(desktopRuntimeProps.calls[0]?.window).toEqual({
            width: 162,
            height: 174,
        });
    });

    it('keeps the enabled pet visible for an active idle session', async () => {
        activityState.current = {
            state: 'quiet',
            address: { serverId: 'server-a', sessionId: 'session-active-idle' },
            sessionId: 'session-active-idle',
            trayItems: [],
        };

        const screen = await renderScreen(<DesktopPetOverlayRuntimeMount />);

        expect(screen.findByTestId('pet-companion-state')).toBeNull();
        expect(desktopRuntimeProps.calls[0]).toMatchObject({
            visible: true,
            expanded: false,
            policy: {
                enabled: true,
            },
        });
    });

    it('unmounts the source and its native requests when the pet overlay preference is disabled', async () => {
        activityState.current = {
            state: 'quiet',
            address: null,
            sessionId: null,
            trayItems: [],
        };
        accountSettingsState.current = {
            ...accountSettingsState.current,
            petsDesktopOverlayDefaultEnabled: false,
        };
        storage.getState().applySettingsLocal(accountSettingsState.current);

        await renderScreen(<DesktopPetOverlayRuntimeMount />);

        expect(desktopRuntimeProps.calls).toHaveLength(0);
        expect(listenDesktopPetOverlayShowMainWindowRequestedMock).not.toHaveBeenCalled();
    });

    it('does not sync overlay state from inside the pet overlay window route', async () => {
        Object.defineProperty(globalThis, 'window', {
            value: {
                location: {
                    href: 'http://localhost:8081/desktop/pet-overlay?desktopPetOverlayWindow=1',
                },
            },
            configurable: true,
            writable: true,
        });

        const screen = await renderScreen(<DesktopPetOverlayRuntimeMount />);

        expect(screen.findByTestId('pet-companion-state')).toBeNull();
        expect(desktopRuntimeProps.calls).toHaveLength(0);
    });

    it('does not mount activity or native request subscriptions while host availability is pending', async () => {
        platformState.pending = true;
        await renderScreen(<DesktopPetOverlayRuntimeMount />);
        expect(desktopRuntimeProps.calls).toHaveLength(0);
        expect(listenDesktopPetOverlayShowMainWindowRequestedMock).not.toHaveBeenCalled();
    });

    it('does not mount the desktop overlay runtime in ordinary browser web', async () => {
        platformState.tauri = false;

        const screen = await renderScreen(<DesktopPetOverlayRuntimeMount />);

        expect(screen.findByTestId('pet-companion-state')).toBeNull();
        expect(desktopRuntimeProps.calls).toHaveLength(0);
    });

    it('ignores unrelated settings and changes the overlay when its account preference changes', async () => {
        const commits = vi.fn();
        const resolvePolicy = vi.spyOn(overlayPolicy, 'resolveDesktopPetOverlayPolicy');
        await renderScreen(
            <React.Profiler id="desktop-pet" onRender={commits}>
                <DesktopPetOverlayRuntimeMount />
            </React.Profiler>,
        );
        const baseline = commits.mock.calls.length;
        const runtimeBaseline = desktopRuntimeProps.calls.length;
        const computationBaseline = resolvePolicy.mock.calls.length;
        await act(async () => {
            storage.getState().applySettingsLocal({ favoriteDirectories: ['~/code'] });
        });
        expect(commits.mock.calls.length).toBe(baseline);
        expect(desktopRuntimeProps.calls.length).toBe(runtimeBaseline);
        expect(resolvePolicy.mock.calls.length).toBe(computationBaseline);
        await act(async () => {
            storage.getState().applySettingsLocal({ petsDesktopOverlayDefaultEnabled: false });
        });
        expect(commits.mock.calls.length).toBe(baseline + 1);
        expect(resolvePolicy.mock.calls.length).toBe(computationBaseline + 1);
        expect(desktopRuntimeProps.calls.length).toBe(runtimeBaseline);
        await act(async () => {
            storage.getState().applyLocalSettings({ uiFontScale: 1.25 }, { persist: false });
        });
        expect(commits.mock.calls.length).toBe(baseline + 1);
        expect(resolvePolicy.mock.calls.length).toBe(computationBaseline + 1);
        await act(async () => {
            storage.getState().applyLocalSettings({ desktopPetOverlayLocked: true }, { persist: false });
        });
        expect(commits.mock.calls.length).toBe(baseline + 2);
        expect(resolvePolicy.mock.calls.length).toBe(computationBaseline + 2);
        expect(desktopRuntimeProps.calls.length).toBe(runtimeBaseline);
    });
});
