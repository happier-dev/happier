import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    collectHostText,
    createSessionFixture,
    invokeTestInstanceHandler,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Settings } from '@/sync/domains/settings/settings';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

type PetAppShellCompanionTestState = {
    account: {
        petsEnabled: boolean;
        petsSelectedPetRef: Settings['petsSelectedPetRef'];
    };
    local: {
        petsEnabledOverride: LocalSettings['petsEnabledOverride'];
        petsSelectedPetOverride: LocalSettings['petsSelectedPetOverride'];
        petsCompanionSizeScale: number;
        petsDismissedCompanionTrayItemKeys: string[];
    };
};

const platformState = vi.hoisted(() => ({
    os: 'web',
    tauri: false,
}));
const featureState = vi.hoisted(() => ({
    companion: { state: 'enabled' },
    sync: { state: 'disabled' },
}));
const settingsState = vi.hoisted((): PetAppShellCompanionTestState => ({
    account: {
        petsEnabled: false,
        petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
    },
    local: {
        petsEnabledOverride: 'inherit',
        petsSelectedPetOverride: { kind: 'inherit' },
        petsCompanionSizeScale: 1,
        petsDismissedCompanionTrayItemKeys: [],
    },
}));
const applyLocalSettingsSpy = vi.hoisted(() => vi.fn());
const executePetCompanionActionSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const reducedMotionState = vi.hoisted(() => ({ enabled: false }));
const useActivityAttentionSourceSpy = vi.hoisted(() => vi.fn());
const activityState = vi.hoisted(() => ({
    sessions: [] as Session[],
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

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

function spriteTransform(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.root.findAllByType('Image')[0]?.props.style.transform;
}

function closestMascot(selector: string): object | null {
    return selector.includes('data-pet-mascot') ? {} : null;
}

function enableAccountPetsForTest(petId = 'milo') {
    settingsState.account = {
        petsEnabled: true,
        petsSelectedPetRef: { kind: 'builtIn', petId },
    };
}

function createActivitySource(sessions: readonly Session[]): ActivityAttentionSource {
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

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => platformState.tauri,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.enabled,
}));

vi.mock('@/activity/source/useActivityAttentionSource', () => ({
    useActivityAttentionSource: () => {
        useActivityAttentionSourceSpy();
        return activitySourceState.source;
    },
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => {
        if (featureId === 'pets.companion') return featureState.companion;
        if (featureId === 'pets.sync') return featureState.sync;
        return { state: 'disabled' };
    },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
    const readAccountSettings = (): typeof settingsDefaults => ({
        ...settingsDefaults,
        ...settingsState.account,
    });
    const readLocalSettings = (): typeof localSettingsDefaults => ({
        ...localSettingsDefaults,
        ...settingsState.local,
    });
    const createStorageSnapshot = (): StorageState => ({
        ...actual.storage.getInitialState(),
        sessionMessages: {},
        sessionPending: {},
        sessionListRowsByServerId: {
            'server-a': Object.fromEntries(
                activityState.sessions.map((session) => [
                    session.id,
                    buildSessionListRenderableFromSession(session),
                ]),
            ),
        },
        ordinarySessionListMembershipByServerId: {
            'server-a': activityState.sessions.map((session) => session.id),
        },
    });
    const storage = Object.assign(
        (selector?: (state: StorageState) => unknown) => {
            const snapshot = createStorageSnapshot();
            return typeof selector === 'function' ? selector(snapshot) : snapshot;
        },
        {
            getState: createStorageSnapshot,
            getInitialState: createStorageSnapshot,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    ) as typeof actual.storage;
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            ...actual,
            storage,
            useSettings: readAccountSettings,
            useSetting: ((name) => readAccountSettings()[name]) as typeof actual.useSetting,
            useLocalSettings: readLocalSettings,
            useLocalSetting: ((name) => readLocalSettings()[name]) as typeof actual.useLocalSetting,
            useAllSessions: () => activityState.sessions,
        },
    });
});

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => applyLocalSettingsSpy,
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: executePetCompanionActionSpy,
    }),
}));

describe('PetAppShellCompanionMount', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        standardCleanup();
        platformState.os = 'web';
        platformState.tauri = false;
        featureState.companion = { state: 'enabled' };
        featureState.sync = { state: 'disabled' };
        settingsState.account = {
            petsEnabled: false,
            petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
        };
        settingsState.local = {
            petsEnabledOverride: 'inherit',
            petsSelectedPetOverride: { kind: 'inherit' },
            petsCompanionSizeScale: 1,
            petsDismissedCompanionTrayItemKeys: [],
        };
        applyLocalSettingsSpy.mockReset();
        reducedMotionState.enabled = false;
        useActivityAttentionSourceSpy.mockClear();
        activityState.sessions = [];
        activitySourceState.source = createActivitySource([]);
        executePetCompanionActionSpy.mockClear();
        vi.unstubAllGlobals();
    });

    it('does not render from default account settings while the companion feature gate is enabled', async () => {
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('pet-app-shell-companion-root')).toBeNull();
        expect(useActivityAttentionSourceSpy).not.toHaveBeenCalled();
    });

    it('renders the selected built-in pet in the ordinary web app shell', async () => {
        enableAccountPetsForTest();
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('pet-app-shell-companion-root')).not.toBeNull();
        const rootStyle = flattenStyle(screen.findByTestId('pet-app-shell-companion-root')?.props.style);
        expect(rootStyle.position).toBe('fixed');
        expect(rootStyle.zIndex).toBeGreaterThan(100);
        const sprite = screen.findByTestId('pet-app-shell-companion-sprite');
        expect(sprite?.props['data-pet-state']).toBe('idle');
    });

    it('renders pet-attached activity bubbles in the ordinary web app shell', async () => {
        enableAccountPetsForTest();
        vi.spyOn(Date, 'now').mockReturnValue(3_000);
        activityState.sessions = [
            createSessionFixture({
                id: 'session-needs-user',
                serverId: 'server-a',
                active: true,
                seq: 2,
                createdAt: 1_000,
                updatedAt: 2_000,
                activeAt: 2_000,
                lastViewedSessionSeq: 0,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                thinking: true,
                thinkingAt: 2_000,
            }),
        ];
        activitySourceState.source = createActivitySource(activityState.sessions);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('desktop-pet-overlay-tray')).toBeTruthy();
        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-needs-user')).toBeTruthy();
        expect(collectHostText(screen.tree)).toEqual(expect.arrayContaining([
            'project',
            'Server A · project',
        ]));
    });

    it('persists dismissed web app-shell activity bubbles by dismiss key', async () => {
        enableAccountPetsForTest();
        vi.spyOn(Date, 'now').mockReturnValue(3_000);
        activityState.sessions = [
            createSessionFixture({
                id: 'session-dismiss-web',
                serverId: 'server-a',
                active: true,
                pendingPermissionRequestCount: 1,
                pendingRequestObservedAt: 2_000,
                updatedAt: 2_000,
                activeAt: 2_000,
            }),
        ];
        activitySourceState.source = createActivitySource(activityState.sessions);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-dismiss-session-dismiss-web'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });

        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-dismiss-web')).toBeNull();
        expect(applyLocalSettingsSpy).toHaveBeenCalledWith({
            petsDismissedCompanionTrayItemKeys: expect.arrayContaining([
                JSON.stringify(['waiting', 'server-a', 'session-dismiss-web', '1']),
            ]),
        });
    });

    it('opens and replies to a secondary-Home activity item with its exact Home context', async () => {
        enableAccountPetsForTest();
        vi.spyOn(Date, 'now').mockReturnValue(12_000);
        const activeHomeSession = createSessionFixture({
            id: 'duplicate-session',
            serverId: 'server-a',
            active: true,
            updatedAt: 10_000,
            activeAt: 10_000,
        });
        const secondaryHomeSession = createSessionFixture({
            id: 'duplicate-session',
            serverId: 'home-b',
            active: true,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 11_000,
            updatedAt: 11_000,
            activeAt: 11_000,
        });
        activityState.sessions = [activeHomeSession];
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
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');
        const screen = await renderScreen(<PetAppShellCompanionMount />);

        await screen.pressByTestIdAsync('desktop-pet-overlay-tray-item-duplicate-session');

        expect(executePetCompanionActionSpy).toHaveBeenCalledWith(
            'session.open',
            { sessionId: 'duplicate-session' },
            { defaultSessionId: 'duplicate-session', serverId: 'home-b' },
        );
        executePetCompanionActionSpy.mockClear();

        await screen.pressByTestIdAsync('desktop-pet-overlay-tray-reply-action-duplicate-session');
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-input-duplicate-session'),
                'onChangeText',
                '  Reply to Home B  ',
            );
        });
        await screen.pressByTestIdAsync('desktop-pet-overlay-tray-reply-send-duplicate-session');

        expect(executePetCompanionActionSpy).toHaveBeenCalledWith(
            'session.message.send',
            { sessionId: 'duplicate-session', message: 'Reply to Home B' },
            { defaultSessionId: 'duplicate-session', serverId: 'home-b' },
        );
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-duplicate-session')?.props.value).toBe('');
    });

    it('updates the rendered built-in pet when the selected pet changes', async () => {
        enableAccountPetsForTest();
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.root.findAllByType('Image')[0]?.props.source).toBe(
            resolveBuiltInPetPackage('milo').spritesheetSource,
        );

        settingsState.account = {
            petsEnabled: true,
            petsSelectedPetRef: { kind: 'builtIn', petId: 'fury' },
        };

        await act(async () => {
            screen.tree.update(<PetAppShellCompanionMount />);
        });

        expect(screen.root.findAllByType('Image')[0]?.props.source).toBe(
            resolveBuiltInPetPackage('fury').spritesheetSource,
        );
    });

    it('keeps idle pets still between ambient actions', async () => {
        enableAccountPetsForTest();
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(spriteTransform(screen)).toEqual([
            { translateX: -0 },
            { translateY: -0 },
        ]);

        await act(async () => {
            vi.advanceTimersByTime(300);
        });

        expect(spriteTransform(screen)).toEqual([
            { translateX: -0 },
            { translateY: -0 },
        ]);
    });

    it('plays a short ambient action after an idle delay', async () => {
        enableAccountPetsForTest();
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const randomSpy = vi.spyOn(Math, 'random')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        await act(async () => {
            vi.advanceTimersByTime(8_000);
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('waving');

        await act(async () => {
            vi.advanceTimersByTime(2_100);
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('idle');
        randomSpy.mockRestore();
    });

    it('holds the web companion still when the user prefers reduced motion', async () => {
        enableAccountPetsForTest();
        vi.useFakeTimers();
        vi.setSystemTime(0);
        reducedMotionState.enabled = true;
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        await act(async () => {
            vi.advanceTimersByTime(20_000);
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('idle');
        expect(spriteTransform(screen)).toEqual([
            { translateX: -0 },
            { translateY: -0 },
        ]);
        randomSpy.mockRestore();
    });

    it('stops the web companion frame loop while the document is hidden', async () => {
        enableAccountPetsForTest();
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
        vi.stubGlobal('document', {
            visibilityState: 'hidden',
            addEventListener: () => {},
            removeEventListener: () => {},
        });
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        await act(async () => {
            vi.advanceTimersByTime(20_000);
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('idle');
        expect(spriteTransform(screen)).toEqual([
            { translateX: -0 },
            { translateY: -0 },
        ]);
        randomSpy.mockRestore();
    });

    it('reacts to a tap with a bounded jumping animation', async () => {
        enableAccountPetsForTest();
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        await screen.pressByTestIdAsync('pet-app-shell-companion-hitbox');

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('jumping');
        expect(screen.findByTestId('pet-app-shell-companion-sprite')?.props['data-pet-state']).toBe('jumping');

        await act(async () => {
            vi.advanceTimersByTime(980);
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('idle');
    });

    it('applies the local companion size scale to web app-shell dimensions and drag bounds', async () => {
        enableAccountPetsForTest();
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;

            constructor(type: string, init: { clientX: number; clientY: number; screenX?: number; screenY?: number }) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX ?? init.clientX;
                this.screenY = init.screenY ?? init.clientY;
            }
        }
        settingsState.local = {
            ...settingsState.local,
            petsCompanionSizeScale: 1.5,
        };
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');
        const screen = await renderScreen(<PetAppShellCompanionMount />);

        const rootStyleBeforeDrag = flattenStyle(screen.findByTestId('pet-app-shell-companion-root')?.props.style);
        const spriteStyle = flattenStyle(screen.findByTestId('pet-app-shell-companion-sprite')?.props.style);

        expect(rootStyleBeforeDrag.width).toBeCloseTo(138, 4);
        expect(rootStyleBeforeDrag.height).toBeCloseTo(149.5, 4);
        expect(spriteStyle.width).toBeCloseTo(138, 4);
        expect(spriteStyle.height).toBeCloseTo(149.5, 4);

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('pet-app-shell-companion-hitbox'), 'onPointerDown', {
                button: 0,
                clientX: 220,
                clientY: 180,
                screenX: 220,
                screenY: 180,
                target: { closest: closestMascot },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: -200,
                clientY: -200,
                screenX: -200,
                screenY: -200,
            }));
        });

        const rootStyleAfterDrag = flattenStyle(screen.findByTestId('pet-app-shell-companion-root')?.props.style);
        expect(rootStyleAfterDrag.transform).toEqual([
            { translateX: -134 },
            { translateY: -62.5 },
        ]);
    });

    it('does not trigger the tap reaction after a web drag movement', async () => {
        enableAccountPetsForTest();
        vi.useFakeTimers();
        vi.setSystemTime(0);
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;

            constructor(type: string, init: { clientX: number; clientY: number; screenX?: number; screenY?: number }) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX ?? init.clientX;
                this.screenY = init.screenY ?? init.clientY;
            }
        }
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');
        const screen = await renderScreen(<PetAppShellCompanionMount />);
        const hitbox = screen.findByTestId('pet-app-shell-companion-hitbox');

        await act(async () => {
            invokeTestInstanceHandler(hitbox, 'onPointerDown', {
                button: 0,
                clientX: 220,
                clientY: 180,
                screenX: 220,
                screenY: 180,
                target: { closest: closestMascot },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 180,
                clientY: 180,
            }));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                clientX: 180,
                clientY: 180,
            }));
        });

        await act(async () => {
            invokeTestInstanceHandler(hitbox, 'onPress', {
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).not.toBe('jumping');
    });

    it('does not duplicate the Tauri desktop overlay', async () => {
        enableAccountPetsForTest();
        platformState.tauri = true;
        const { PetAppShellCompanionMount } = await import('./PetAppShellCompanionMount');

        const screen = await renderScreen(<PetAppShellCompanionMount />);

        expect(screen.findByTestId('pet-app-shell-companion-root')).toBeNull();
    });
});
