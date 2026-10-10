import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { invokeTestInstanceHandler, renderScreen as renderTestkitScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Settings } from '@/sync/domains/settings/settings';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

type PetNativeMountTestState = {
    account: {
        petsEnabled: boolean;
        petsSelectedPetRef: Settings['petsSelectedPetRef'];
    };
    local: Pick<LocalSettings, 'petsEnabledOverride' | 'petsSelectedPetOverride' | 'petsCompanionPosition'> & {
        petsCompanionSizeScale: number;
        petsDismissedCompanionTrayItemKeys: string[];
    };
};

const featureState = vi.hoisted(() => ({
    companion: { state: 'enabled' },
    sync: { state: 'disabled' },
}));
const settingsState = vi.hoisted((): PetNativeMountTestState => ({
    account: {
        petsEnabled: true,
        petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
    },
    local: {
        petsEnabledOverride: 'inherit',
        petsSelectedPetOverride: { kind: 'inherit' },
        petsCompanionSizeScale: 1,
        petsCompanionPosition: {
            schemaVersion: 1,
            surface: 'mobile-app-shell',
            normalizedX: 0.82,
            normalizedY: 0.72,
            lastViewport: null,
        },
        petsDismissedCompanionTrayItemKeys: [],
    },
}));
const applyLocalSettingsSpy = vi.hoisted(() => vi.fn());
const hapticsSpy = vi.hoisted(() => vi.fn(async () => {}));
const dimensionsState = vi.hoisted(() => ({ width: 390, height: 844 }));
const safeAreaState = vi.hoisted(() => ({
    top: 59,
    right: 0,
    bottom: 34,
    left: 0,
}));
const sessionsState = vi.hoisted(() => ({
    current: [] as ReturnType<typeof createSessionFixture>[],
}));
const activitySourceState = vi.hoisted(() => ({
    source: {
        isDataReady: true,
        sessionsById: {},
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        serverProfilesById: {},
        activeServer: null,
    } as ActivityAttentionSource,
}));
const executePetCompanionActionSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
/**
 * The host's app state, driveable. The pet's motion is gated on "is anyone looking?", so the
 * fixture has to be able to answer that question differently over time — a frozen `'active'`
 * constant cannot fail a gating test in either direction.
 */
const appStateHost = vi.hoisted(() => ({
    current: 'active' as string,
    listeners: new Set<(state: string) => void>(),
}));

function createActivitySource(sessions: readonly ReturnType<typeof createSessionFixture>[]): ActivityAttentionSource {
    return {
        isDataReady: true,
        sessionsById: Object.fromEntries(sessions.map((session) => [session.id, session])),
        sessionListRowsByServerId: {
            'server-a': Object.fromEntries(
                sessions.map((session) => [session.id, buildSessionListRenderableFromSession(session)]),
            ),
        },
        ordinarySessionListMembershipByServerId: {
            'server-a': sessions.map((session) => session.id),
        },
        sessionListIndexByServerId: {
            'server-a': sessions.map((session) => ({
                type: 'session' as const,
                sessionId: session.id,
                serverId: 'server-a',
                serverName: 'Server A',
            })),
        },
        concurrentSessionListCacheByServerId: {},
        serverProfilesById: {},
        activeServer: null,
    };
}

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(options: { ios?: T; android?: T; native?: T; default?: T }) =>
                options.ios ?? options.native ?? options.default ?? options.android,
        },
        useWindowDimensions: () => dimensionsState,
        AppState: {
            get currentState() {
                return appStateHost.current;
            },
            addEventListener: (event: string, listener: (state: string) => void) => {
                if (event !== 'change') return { remove: () => {} };
                appStateHost.listeners.add(listener);
                return { remove: () => appStateHost.listeners.delete(listener) };
            },
        },
        I18nManager: {
            isRTL: false,
        },
        Keyboard: {
            addListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => safeAreaState,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-haptics', () => ({
    ImpactFeedbackStyle: { Light: 'light' },
    impactAsync: hapticsSpy,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => {
        if (featureId === 'pets.companion') return featureState.companion;
        if (featureId === 'pets.sync') return featureState.sync;
        return { state: 'disabled' };
    },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => applyLocalSettingsSpy,
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: executePetCompanionActionSpy,
    }),
}));

const initialStorageState = storage.getState();

function seedPetsStorage() {
    const source = activitySourceState.source;
    storage.setState({
        settings: { ...settingsDefaults, ...settingsState.account },
        localSettings: { ...localSettingsDefaults, ...settingsState.local },
        isDataReady: source.isDataReady,
        sessions: source.sessionsById,
        sessionListRowsByServerId: source.sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId: source.ordinarySessionListMembershipByServerId,
        sessionListIndexByServerId: Object.fromEntries(Object.entries(source.sessionListIndexByServerId)
            .map(([serverId, index]) => [serverId, index == null ? index : [...index]])),
        concurrentSessionListCacheByServerId: source.concurrentSessionListCacheByServerId,
        sessionMessages: {},
        sessionPending: {},
    });
}

async function renderScreen(...args: Parameters<typeof renderTestkitScreen>) {
    seedPetsStorage();
    return renderTestkitScreen(...args);
}

describe('PetAppShellCompanionMount.native', () => {
    beforeEach(async () => {
        await upsertAndActivateServer({ serverUrl: 'https://server-a', scope: 'tab' });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        standardCleanup();
        storage.setState(initialStorageState, true);
        applyLocalSettingsSpy.mockReset();
        hapticsSpy.mockClear();
        featureState.companion = { state: 'enabled' };
        featureState.sync = { state: 'disabled' };
        settingsState.account = {
            petsEnabled: true,
            petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
        };
        settingsState.local = {
            petsEnabledOverride: 'inherit',
            petsSelectedPetOverride: { kind: 'inherit' },
            petsCompanionSizeScale: 1,
            petsCompanionPosition: {
                schemaVersion: 1,
                surface: 'mobile-app-shell',
                normalizedX: 0.82,
                normalizedY: 0.72,
                lastViewport: null,
            },
            petsDismissedCompanionTrayItemKeys: [],
        };
        sessionsState.current = [];
        activitySourceState.source = createActivitySource([]);
        executePetCompanionActionSpy.mockClear();
    });

    it('renders the selected pet in the native app shell with safe-area-aware positioning', async () => {
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('pet-app-shell-companion-root')).not.toBeNull();
        expect(screen.findByTestId('pet-app-shell-companion-sprite')?.props['data-pet-state']).toBe('idle');
        expect(screen.root.findAllByType('SkiaImage')[0]?.props.image).toBe(
            `skia-image:${String(resolveBuiltInPetPackage('milo').spritesheetSource)}`,
        );
        const rootStyle = StyleSheet.flatten(screen.findByTestId('pet-app-shell-companion-root')?.props.style);
        expect(rootStyle).toEqual(expect.objectContaining({
            position: 'absolute',
            left: 0,
            top: 0,
        }));
        expect(rootStyle.transform[0].translateX).toBeCloseTo(236.68, 2);
        expect(rootStyle.transform[1].translateY).toBeCloseTo(522.68, 2);
    });

    it('applies the local companion size scale to native root and sprite dimensions', async () => {
        settingsState.local = {
            ...settingsState.local,
            petsCompanionSizeScale: 1.5,
        };
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        const rootStyle = StyleSheet.flatten(screen.findByTestId('pet-app-shell-companion-root')?.props.style);
        const spriteStyle = StyleSheet.flatten(screen.findByTestId('pet-app-shell-companion-sprite')?.props.style);

        expect(rootStyle.width).toBeCloseTo(138, 4);
        expect(rootStyle.height).toBeCloseTo(149.5, 4);
        expect(spriteStyle.width).toBeCloseTo(138, 4);
        expect(spriteStyle.height).toBeCloseTo(149.5, 4);
    });

    it('persists normalized position and fires light haptics only for tap without drag', async () => {
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');
        const screen = await renderScreen(<PetAppShellCompanionMount />);
        const gesture = screen.root.findByType('GestureDetector').props.gesture;

        await act(async () => {
            gesture.__handlers.onBegin?.({
                absoluteX: 120,
                absoluteY: 200,
                translationX: 0,
                translationY: 0,
                velocityX: 0,
                velocityY: 0,
            });
            gesture.__handlers.onUpdate?.({
                absoluteX: 20,
                absoluteY: 400,
                translationX: -999,
                translationY: 999,
                velocityX: -900,
                velocityY: 200,
            });
            gesture.__handlers.onEnd?.({
                absoluteX: 20,
                absoluteY: 400,
                translationX: -999,
                translationY: 999,
                velocityX: -900,
                velocityY: 200,
            }, true);
        });

        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            petsCompanionPosition: expect.objectContaining({
                schemaVersion: 1,
                surface: 'mobile-app-shell',
                normalizedX: 0,
                normalizedY: 1,
            }),
        });
        expect(hapticsSpy).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('pet-app-shell-companion-hitbox');
        expect(hapticsSpy).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('pet-app-shell-companion-hitbox');

        expect(hapticsSpy).toHaveBeenCalledWith('light');
        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('jumping');
    });

    it('can enable the native companion after an initially disabled render', async () => {
        featureState.companion = { state: 'disabled' };
        settingsState.account.petsEnabled = false;
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');

        const screen = await renderScreen(<PetAppShellCompanionMount />);
        expect(screen.findByTestId('pet-app-shell-companion-root')).toBeNull();

        featureState.companion = { state: 'enabled' };
        settingsState.account.petsEnabled = true;
        await act(async () => {
            seedPetsStorage();
            screen.tree.update(<PetAppShellCompanionMount />);
        });

        expect(screen.findByTestId('pet-app-shell-companion-root')).not.toBeNull();
    });

    it('renders shared activity bubbles and keeps quick reply input taps out of session open handling', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(12_000);
        const activeHomeSession = createSessionFixture({
            id: 'native-pet-session',
            serverId: 'server-a',
            active: true,
            updatedAt: 10_000,
            activeAt: 10_000,
        });
        const secondaryHomeSession = createSessionFixture({
            id: 'native-pet-session',
            serverId: 'home-b',
            active: true,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 11_000,
            updatedAt: 11_000,
            activeAt: 11_000,
        });
        sessionsState.current = [activeHomeSession];
        activitySourceState.source = {
            ...createActivitySource([activeHomeSession]),
            sessionsById: {
                [secondaryHomeSession.id]: secondaryHomeSession,
            },
            sessionListRowsByServerId: {
                'server-a': {
                    [activeHomeSession.id]: buildSessionListRenderableFromSession(activeHomeSession),
                },
                'home-b': {
                    [secondaryHomeSession.id]: buildSessionListRenderableFromSession(secondaryHomeSession),
                },
            },
            ordinarySessionListMembershipByServerId: {
                'server-a': [activeHomeSession.id],
                'home-b': [secondaryHomeSession.id],
            },
            sessionListIndexByServerId: {
                'server-a': [{
                    type: 'session',
                    sessionId: activeHomeSession.id,
                    serverId: 'server-a',
                    serverName: 'Home A',
                }],
                'home-b': [{
                    type: 'session',
                    sessionId: secondaryHomeSession.id,
                    serverId: 'home-b',
                    serverName: 'Home B',
                }],
            },
            activeServer: {
                serverId: 'server-a',
                serverUrl: 'https://home-a.example.test',
                generation: 1,
            },
        };
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('desktop-pet-overlay-tray')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-tray-item-native-pet-session')).not.toBeNull();

        await screen.pressByTestIdAsync('desktop-pet-overlay-tray-item-native-pet-session');

        expect(executePetCompanionActionSpy).toHaveBeenCalledWith(
            'session.open',
            { sessionId: 'native-pet-session' },
            { defaultSessionId: 'native-pet-session', serverId: 'home-b' },
        );
        executePetCompanionActionSpy.mockClear();

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-action-native-pet-session'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });
        const input = screen.findByTestId('desktop-pet-overlay-tray-reply-input-native-pet-session');
        expect(input).not.toBeNull();
        const inputStyle = StyleSheet.flatten(input?.props.style);
        expect(input?.props.multiline).toBe(true);
        expect(input?.props.numberOfLines).toBe(1);
        expect(input?.props.onKeyPress).toEqual(expect.any(Function));
        expect(inputStyle?.height).toBe(30);
        expect(inputStyle?.minHeight).toBe(30);
        expect(inputStyle?.maxHeight).toBe(30);

        await act(async () => {
            invokeTestInstanceHandler(input, 'onPress', { stopPropagation: vi.fn() });
            invokeTestInstanceHandler(input, 'onPressIn', { stopPropagation: vi.fn() });
        });

        expect(executePetCompanionActionSpy).not.toHaveBeenCalledWith(
            'session.open',
            expect.objectContaining({ sessionId: 'native-pet-session' }),
            expect.anything(),
        );

        await act(async () => {
            invokeTestInstanceHandler(input, 'onChangeText', '  Reply from native\nwith detail  ');
        });
        const multilineInputStyle = StyleSheet.flatten(
            screen.findByTestId('desktop-pet-overlay-tray-reply-input-native-pet-session')?.props.style,
        );
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-native-pet-session')?.props.numberOfLines).toBe(2);
        expect(multilineInputStyle?.height).toBeGreaterThan(30);
        expect(multilineInputStyle?.maxHeight).toBe(multilineInputStyle?.height);

        const shiftEnterEvent = {
            nativeEvent: { key: 'Enter', shiftKey: true },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-input-native-pet-session'),
                'onKeyPress',
                shiftEnterEvent,
            );
        });
        expect(shiftEnterEvent.preventDefault).not.toHaveBeenCalled();

        const enterEvent = {
            nativeEvent: { key: 'Enter', shiftKey: false },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-input-native-pet-session'),
                'onKeyPress',
                enterEvent,
            );
        });
        expect(enterEvent.preventDefault).toHaveBeenCalled();
        expect(executePetCompanionActionSpy).toHaveBeenCalledWith(
            'session.message.send',
            { sessionId: 'native-pet-session', message: 'Reply from native\nwith detail' },
            { defaultSessionId: 'native-pet-session', serverId: 'home-b' },
        );
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-native-pet-session')?.props.value).toBe('');
        executePetCompanionActionSpy.mockClear();

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-input-native-pet-session'),
                'onChangeText',
                '  Reply from native  ',
            );
        });
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-send-native-pet-session'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });

        expect(executePetCompanionActionSpy).toHaveBeenCalledWith(
            'session.message.send',
            { sessionId: 'native-pet-session', message: 'Reply from native' },
            { defaultSessionId: 'native-pet-session', serverId: 'home-b' },
        );
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-native-pet-session')?.props.value).toBe('');
    });

    it('closes native quick reply before dismissing the activity bubble', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(12_000);
        sessionsState.current = [
            createSessionFixture({
                id: 'native-close-reply-session',
                serverId: 'server-a',
                active: true,
                pendingPermissionRequestCount: 1,
                pendingRequestObservedAt: 11_000,
                updatedAt: 11_000,
                activeAt: 11_000,
            }),
        ];
        activitySourceState.source = createActivitySource(sessionsState.current);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');

        const screen = await renderScreen(<PetAppShellCompanionMount />);
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-action-native-close-reply-session'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-native-close-reply-session')).not.toBeNull();

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-dismiss-native-close-reply-session'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });

        expect(screen.findByTestId('desktop-pet-overlay-tray-item-native-close-reply-session')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-native-close-reply-session')).toBeNull();
        expect(applyLocalSettingsSpy).not.toHaveBeenCalledWith(expect.objectContaining({
            petsDismissedCompanionTrayItemKeys: expect.anything(),
        }));
    });
});

/**
 * The pet only animates while someone is looking at it. That is a real product rule — a sprite
 * ticking at 20 Hz behind a backgrounded app is battery the user never sees — and it is invisible
 * in a screenshot, so it is pinned here rather than eyeballed.
 *
 * "Is anyone looking?" has one owner (`useHostActivelyViewed`). These assert the pet's *behaviour*
 * through the frame it paints, not which hook it calls, so the gate can be re-homed without
 * rewriting them — and so a re-homing that quietly changed the answer cannot pass.
 */
describe('PetAppShellCompanionMount.native motion gating', () => {
    afterEach(() => {
        vi.useRealTimers();
        appStateHost.current = 'active';
        appStateHost.listeners.clear();
        vi.resetModules();
    });

    /** The sprite's atlas offset: it moves only when the frame index does. */
    function readSpriteOffsetX(screen: Awaited<ReturnType<typeof renderScreen>>): number {
        return screen.root.findAllByType('SkiaImage')[0]?.props.x as number;
    }

    async function renderWithAppState(state: string) {
        appStateHost.current = state;
        appStateHost.listeners.clear();
        // The actively-viewed watch samples the host once and keeps that answer for the module's
        // lifetime, so the fixture has to be in place before the module is first loaded.
        vi.resetModules();
        vi.useFakeTimers();
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount.native');
        const screen = await renderScreen(<PetAppShellCompanionMount />);
        return screen;
    }

    async function advance(ms: number): Promise<void> {
        await act(async () => {
            vi.advanceTimersByTime(ms);
        });
    }

    function emitAppState(state: string): void {
        appStateHost.current = state;
        act(() => {
            for (const listener of [...appStateHost.listeners]) listener(state);
        });
    }

    it('animates on a host that has not reported an app state yet', async () => {
        // Android reports `unknown` until the first foreground transition arrives. Reading that as
        // "not being looked at" freezes the companion on the first frame for the whole of a cold
        // start — the pet is on screen, visibly dead, until the user backgrounds the app once.
        const screen = await renderWithAppState('unknown');
        const firstFrameOffsetX = readSpriteOffsetX(screen);

        await advance(2_000);

        expect(readSpriteOffsetX(screen)).not.toBe(firstFrameOffsetX);
    });

    it('stops animating when the app leaves the foreground and resumes when it returns', async () => {
        const screen = await renderWithAppState('active');
        await advance(2_000);
        const movedOffsetX = readSpriteOffsetX(screen);
        expect(movedOffsetX).not.toBe(0);

        emitAppState('background');
        // Backgrounded, the frame is pinned: further time buys no new frames.
        const backgroundedOffsetX = readSpriteOffsetX(screen);
        await advance(4_000);
        expect(readSpriteOffsetX(screen)).toBe(backgroundedOffsetX);

        emitAppState('active');
        await advance(2_000);
        expect(readSpriteOffsetX(screen)).not.toBe(backgroundedOffsetX);
    });
});
