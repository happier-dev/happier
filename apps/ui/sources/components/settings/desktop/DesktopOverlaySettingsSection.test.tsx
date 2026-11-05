/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createSecretSettingsTestHarness, type SecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { flushHookEffects, renderSettingsView, standardCleanup } from '@/dev/testkit';
import type { DesktopActivityOverlayWindowStatePayload } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { resolveDesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import type { DesktopHostAvailability } from '@/utils/platform/desktopHost';

const getDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<() => Promise<DesktopActivityOverlayWindowStatePayload | null>>(async () => null),
);
const listenDesktopActivityOverlayWindowStateMock = vi.hoisted(
    () => vi.fn<(handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) => Promise<() => void>>(async () => () => {}),
);
/** The overlay window state the section reads for display facts (whether this is a MacBook camera notch). */
function createDesktopOverlayWindowStatePayload(
    display: 'camera_notch' | 'plain',
): DesktopActivityOverlayWindowStatePayload {
    return {
        visible: true,
        model: {
            visible: true,
            generatedAt: Date.now(),
            collapsed: {
                title: 'Needs you',
                statusText: null,
                defaultTarget: 'open-primary-session',
                sessionCount: 1,
                activity: 'needsYou',
            },
            expanded: { title: 'Active sessions', rows: [] },
        },
        policy: resolveDesktopOverlayPolicy({ desktopOverlayEnabled: true }),
        placementDiagnostics: {
            displayContext: {
                isMacos: display === 'camera_notch',
                isBuiltinDisplay: display === 'camera_notch',
                hasPhysicalNotch: display === 'camera_notch',
                safeAreaTop: 0,
                physicalNotchSize: display === 'camera_notch' ? { width: 184, height: 32 } : null,
                screenFrame: { x: 0, y: 0, width: 1512, height: 982 },
                visibleFrame: { x: 0, y: 32, width: 1512, height: 950 },
            },
        },
    } as unknown as DesktopActivityOverlayWindowStatePayload;
}

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ segments: [] }).module);
// React's native test renderer cannot mount a browser DOM portal container.
vi.mock('@/utils/web/reactDomCjs', () => ({
    requireReactDOM: () => ({
        createPortal: (children: React.ReactNode) => React.createElement(React.Fragment, null, children),
    }),
}));

vi.mock('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge', () => ({
    getDesktopActivityOverlayWindowState: () => getDesktopActivityOverlayWindowStateMock(),
    listenDesktopActivityOverlayWindowState: (handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        listenDesktopActivityOverlayWindowStateMock(handler),
}));

// The display inventory is a native read behind the desktop host boundary.
const listDesktopDisplaysMock = vi.hoisted(() => vi.fn(async () => ({
    displays: [
        { storageKey: 'lg', name: 'LG UltraFine 27"', builtIn: false, primary: false, connected: true, inUse: false },
        { storageKey: 'studio', name: 'Studio Display', builtIn: false, primary: false, connected: false, inUse: false },
        { storageKey: 'builtin', name: 'Built-in Retina Display', builtIn: true, primary: true, connected: true, inUse: true },
    ],
    automaticResolvesTo: 'builtin',
})));
vi.mock('@/activity/adapters/desktop/runtime/desktopDisplays', () => ({
    listDesktopDisplays: () => listDesktopDisplaysMock(),
}));

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DesktopOverlaySettingsSection } = await import('./DesktopOverlaySettingsSection');

const availableHost: DesktopHostAvailability = {
    activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
};
const nativeAvailability = vi.fn<() => Promise<DesktopHostAvailability>>();
const nativeCallbacks = new Map<number, (event: unknown) => void>();
const nativeEventHandlers = new Map<string, number>();
let nextNativeCallback = 0;
function publishNativeAvailability(value: DesktopHostAvailability) {
    const id = nativeEventHandlers.get('activityOverlay://state');
    if (id !== undefined) nativeCallbacks.get(id)?.({ event: 'activityOverlay://state', id, payload: { availability: value } });
}
const originalState = storage.getState();
const originalAuth = getCurrentAuth();

describe('DesktopOverlaySettingsSection', () => {
    let account: SecretSettingsTestHarness;
    beforeEach(async () => {
        const secureStorage = createDesktopSecureStorageBoundary();
        let callbackId = 0;
        nativeAvailability.mockReset();
        nativeAvailability.mockResolvedValue(availableHost);
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
                if (command === 'desktop_host_get_availability') return nativeAvailability();
                if (command === 'plugin:event|listen') {
                    if (typeof args?.event !== 'string' || typeof args.handler !== 'number') throw new TypeError('Expected native event registration');
                    nativeEventHandlers.set(args.event, args.handler);
                    return ++callbackId;
                }
                return secureStorage.invoke(command, args);
            },
            transformCallback: (callback: (event: unknown) => void) => {
                const id = ++nextNativeCallback;
                nativeCallbacks.set(id, callback);
                return id;
            },
        });
        getDesktopActivityOverlayWindowStateMock.mockReset();
        listenDesktopActivityOverlayWindowStateMock.mockReset();
        listDesktopDisplaysMock.mockClear();
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createDesktopOverlayWindowStatePayload('plain'));
        listenDesktopActivityOverlayWindowStateMock.mockResolvedValue(() => {});
        account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        getPersistenceStorage().set('local-settings', JSON.stringify({
            ...localSettingsDefaults, desktopOverlayEnabled: true, desktopOverlayDock: 'top', desktopOverlayIdle: 'tip',
        }));
        storage.setState({ localSettings: loadLocalSettings() });
    });
    afterEach(async () => {
        standardCleanup();
        await account?.dispose();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        setCurrentAuth(originalAuth);
        storage.setState(originalState, true);
    });
    const render = () => renderSettingsView(<InjectedAuthProvider credentials={account.credentials}>
        <DesktopOverlaySettingsSection />
    </InjectedAuthProvider>);

    it('shows loading and unavailable role states without changing the enabled preference, then recovers through native push', async () => {
        let rejectAvailability!: (reason?: unknown) => void;
        nativeAvailability.mockReturnValue(new Promise<DesktopHostAvailability>((_resolve, reject) => { rejectAvailability = reject; }));
        const screen = await render();
        expect(screen.findRow('settings-desktop-overlay-loading')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-enabled')).toBeNull();
        expect(getDesktopActivityOverlayWindowStateMock).not.toHaveBeenCalled();
        expect(storage.getState().localSettings.desktopOverlayEnabled).toBe(true);
        await act(async () => { rejectAvailability(new Error('Native host acquisition failed')); });
        await flushHookEffects();
        const unavailable = screen.findRow('settings-desktop-overlay-unavailable');
        expect(unavailable?.props.subtitle).toBe('host_availability_unavailable');
        expect(screen.findRow('settings-desktop-overlay-enabled')).toBeNull();
        expect(getDesktopActivityOverlayWindowStateMock).not.toHaveBeenCalled();
        expect(storage.getState().localSettings.desktopOverlayEnabled).toBe(true);
        expect(account.settingsWrites).toEqual([]);
        await act(async () => { publishNativeAvailability(availableHost); });
        await flushHookEffects();
        expect(screen.findRow('settings-desktop-overlay-loading')).toBeNull();
        expect(screen.findRow('settings-desktop-overlay-unavailable')).toBeNull();
        for (const key of ['enabled', 'dock', 'display', 'idle', 'visibilityMode', 'alwaysOnTop', 'botConversationPresentation']) {
            expect(screen.findRowByTitle(`settingsDesktop.overlay.${key}Title`)).toBeTruthy();
        }
    });

    it('shows the current destination choice and retires trigger, auto-hide and experimental controls', async () => {
        const screen = await render();
        expect(screen.findGroup('settingsDesktop.overlay.title')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-enabled')).toBeTruthy();
        expect(screen.findAll(node => node.props.testID === 'settings-desktop-bot-conversation-presentation').length).toBeGreaterThan(0);
        for (const key of ['showWhenRunning', 'showWhenAttentionRequired', 'showWhenReady', 'autoHideEnabled',
            'autoHideDelay', 'interactiveCollapsed', 'collapsedClickAction', 'expandedBehavior', 'density',
            'compactStyle', 'showSessionCount', 'placementMode', 'anchorPreset', 'allowRepositioning', 'lockPosition', 'resetPosition']) {
            expect(screen.findRowByTitle(`settingsDesktop.overlay.${key}Title`)).toBeNull();
        }
        expect(account.settingsWrites).toEqual([]);
    });

    it('reads no display inventory on mount, reads once on open, and preserves a named unplugged display', async () => {
        const payload = createDesktopOverlayWindowStatePayload('plain');
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue({ ...payload, placementDiagnostics: {
            ...payload.placementDiagnostics!,
            display: { storageKey: 'builtin', name: 'Built-in Retina Display', source: 'automatic', fellBack: true, requestedName: 'Studio Display' },
        } });
        storage.getState().applyLocalSettings({ desktopOverlayDisplayMode: 'named:studio' });
        const screen = await render();
        const displayMenu = () => screen.findAll(node => node.props.itemTrigger?.title === 'settingsDesktop.overlay.displayTitle'
            && typeof node.props.onOpenChange === 'function')[0]!;
        expect(listDesktopDisplaysMock).not.toHaveBeenCalled();
        expect(displayMenu().props.selectedId).toBe('named:studio');
        await act(async () => { displayMenu().props.onOpenChange(true); });
        await flushHookEffects();
        expect(listDesktopDisplaysMock).toHaveBeenCalledTimes(1);
        expect(displayMenu().props.items.map((item: { id: string }) => item.id))
            .toEqual(['automatic', 'built_in', 'main', 'named:lg', 'named:studio', 'named:builtin']);
        const studio = displayMenu().props.items.find((item: { id: string }) => item.id === 'named:studio');
        expect(studio.title).toBe('Studio Display');
        expect(displayMenu().props.itemTrigger.subtitle).toBe('settingsDesktop.overlay.displayUnplugged');
        await act(async () => { displayMenu().props.onSelect('named:lg'); });
        await vi.waitFor(() => expect(storage.getState().localSettings.desktopOverlayDisplayMode).toBe('named:lg'));
        expect(account.settingsWrites).toEqual([]);
    });

    it('hides dependent rows while the desktop overlay is off', async () => {
        storage.getState().applyLocalSettings({ desktopOverlayEnabled: false });
        const screen = await render();
        expect(screen.findRow('settings-desktop-overlay-enabled')).toBeTruthy();
        for (const key of ['dock', 'idle', 'display', 'visibilityMode', 'alwaysOnTop', 'botConversationPresentation']) {
            expect(screen.findRowByTitle(`settingsDesktop.overlay.${key}Title`)).toBeNull();
        }
    });

    it.each([
        ['camera_notch', 'top', 'dockSubtitleCamera', 'idleSubtitleCamera'],
        ['plain', 'top', 'dockSubtitleEdge', 'idleSubtitleTip'],
        ['camera_notch', 'floating', 'dockSubtitleFloating', 'idleSubtitleTip'],
    ] as const)('explains the %s display with %s docking', async (display, dock, dockHelp, idleHelp) => {
        getDesktopActivityOverlayWindowStateMock.mockResolvedValue(createDesktopOverlayWindowStatePayload(display));
        storage.getState().applyLocalSettings({ desktopOverlayDock: dock });
        const screen = await render();
        await flushHookEffects();
        expect(screen.findRowByTitle('settingsDesktop.overlay.dockTitle')?.props.subtitle).toBe(`settingsDesktop.overlay.${dockHelp}`);
        expect(screen.findRowByTitle('settingsDesktop.overlay.idleTitle')?.props.subtitle).toBe(`settingsDesktop.overlay.${idleHelp}`);
    });

    it('keeps retired placement rows absent after hydrating legacy custom placement', async () => {
        getPersistenceStorage().set('local-settings', JSON.stringify({ ...localSettingsDefaults,
            desktopOverlayEnabled: true, desktopOverlayPlacementMode: 'custom', desktopOverlayAnchor: 'bottom_right',
            desktopOverlayOffsetX: 24, desktopOverlayOffsetY: -18, desktopOverlayEnableDragReposition: true,
            desktopOverlayLockPosition: false, desktopOverlayAutoHideEnabled: true, desktopOverlayShowWhenReady: true,
        }));
        storage.setState({ localSettings: loadLocalSettings() });
        const screen = await render();
        for (const key of ['placementMode', 'anchorPreset', 'allowRepositioning', 'lockPosition', 'resetPosition',
            'autoHideEnabled', 'showWhenReady']) {
            expect(screen.findRowByTitle(`settingsDesktop.overlay.${key}Title`)).toBeNull();
        }
    });
});
