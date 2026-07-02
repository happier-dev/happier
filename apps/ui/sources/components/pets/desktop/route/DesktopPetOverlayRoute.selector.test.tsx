import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi, UseBoundStore } from 'zustand';

import {
    createDeferred,
    createSessionFixture,
    flushHookEffects,
    invokeTestInstanceHandler,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import type { StorageState } from '@/sync/store/types';
import type { LocalPetSourceMetadata } from '@/sync/domains/pets/localPetSourceTypes';
import { createReducer } from '@/sync/reducer/reducer';
import type { AccountPetLibraryEntryV1 } from '@happier-dev/protocol';
import { PET_DAEMON_RPC_METHODS } from '@happier-dev/protocol';

const settingsState = vi.hoisted(() => ({
    current: {
        petsEnabled: true,
        petsSelectedPetRef: { kind: 'builtIn', petId: 'blink' },
    },
} as {
    current: {
        petsEnabled: boolean;
        petsSelectedPetRef:
            | { kind: 'builtIn'; petId: string }
            | { kind: 'accountPet'; accountPetId: string };
    };
}));
const localSettingsState = vi.hoisted(() => ({
    current: {
        petsEnabledOverride: 'inherit',
        petsSelectedPetOverride: { kind: 'inherit' },
        petsCompanionSizeScale: 1,
    },
} as {
    current: {
        petsEnabledOverride: 'inherit' | 'enabled' | 'disabled';
        petsSelectedPetOverride:
            | { kind: 'inherit' }
            | { kind: 'detectedCodexHome'; sourceKey: string }
            | { kind: 'happierManagedLocal'; sourceKey: string };
        petsCompanionSizeScale: number;
        petsDismissedCompanionTrayItemKeys?: string[];
    };
}));
const featureDecisionState = vi.hoisted(() => ({
    companion: { state: 'enabled' },
    sync: { state: 'enabled' },
}));
const accountPetsState = vi.hoisted(() => ({
    current: {} as Record<string, AccountPetLibraryEntryV1>,
}));
const localPetSourcesState = vi.hoisted(() => ({
    current: {} as Record<string, LocalPetSourceMetadata>,
}));
const sessionsState = vi.hoisted(() => ({
    current: [] as ReturnType<typeof createSessionFixture>[],
}));
const sessionSignalsState = vi.hoisted(() => ({
    current: {} as Record<string, {
        hasUnreadMessages?: boolean;
        latestThinkingActivityAtMs?: number | null;
        latestMeaningfulActivityAtMs?: number | null;
        latestMessageText?: string | null;
    }>,
}));
type TestDesktopPetOverlayWindowStatePayload = Readonly<{
    visible: boolean;
    inputLocked: boolean;
    monitorId: string | null;
    logicalPosition: Readonly<{ x: number; y: number }>;
    logicalSize: Readonly<{ width: number; height: number }>;
    scaleFactor: number;
    lastPlacementRecoveryCode: string | null;
    activity?: unknown;
    layout?: unknown;
}>;
const serverFetchMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const startDesktopPetOverlayDragSessionMock = vi.hoisted(() => vi.fn());
const applyDesktopPetOverlayDragDeltaMock = vi.hoisted(() => vi.fn());
const releaseDesktopPetOverlayDragVelocityMock = vi.hoisted(() => vi.fn());
const endDesktopPetOverlayDragSessionMock = vi.hoisted(() => vi.fn());
const showMainWindowFromDesktopPetOverlayMock = vi.hoisted(() => vi.fn());
const syncDesktopPetOverlayElementMetricsMock = vi.hoisted(() => vi.fn());
const getDesktopPetOverlayWindowStateMock = vi.hoisted(() =>
    vi.fn(async (): Promise<TestDesktopPetOverlayWindowStatePayload | null> => null),
);
const listenDesktopPetOverlayWindowStateMock = vi.hoisted(() =>
    vi.fn(async (_handler: (payload: TestDesktopPetOverlayWindowStatePayload) => void) => () => {}),
);
const listenDesktopPetOverlayNativeMouseMock = vi.hoisted(() =>
    vi.fn(async (_handler: (payload: { inside: boolean; x: number; y: number }) => void) => () => {}),
);
const executePetOverlayActionMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const applyLocalSettingsMock = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({
    os: 'web',
}));
const activeServerSnapshotState = vi.hoisted(() => ({
    current: {
        serverId: 'server-pets',
        serverUrl: 'https://pets.example.test',
        generation: 1,
    },
}));

const accountPet = {
    accountPetId: 'account-pet-1',
    packageFormat: 'codex-compatible-atlas-v1',
    manifest: {
        id: 'account-blink',
        displayName: 'Account Blink',
        description: 'Account pet',
        spritesheetPath: 'spritesheet.webp',
    },
    spritesheetAssetRef: {
        assetId: 'asset-pet-1',
        mediaType: 'image/webp',
        digest: 'sha256:account-asset',
        sizeBytes: 3,
    },
    digest: 'sha256:account-package',
    sizeBytes: 128,
    createdAt: 1,
    updatedAt: 2,
    origin: { kind: 'manualImport' },
} satisfies AccountPetLibraryEntryV1;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        I18nManager: {
            ...actual.I18nManager,
            isRTL: false,
        },
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => {
        if (featureId === 'pets.companion') return featureDecisionState.companion;
        if (featureId === 'pets.sync') return featureDecisionState.sync;
        return { state: 'disabled', blockedBy: 'server', blockerCode: 'feature_disabled' };
    },
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerSnapshotState.current,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchMock,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/components/pets/desktop/bridge/desktopPetOverlayBridge', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/pets/desktop/bridge/desktopPetOverlayBridge')>();
    return {
        ...actual,
        startDesktopPetOverlayDragSession: startDesktopPetOverlayDragSessionMock,
        applyDesktopPetOverlayDragDelta: applyDesktopPetOverlayDragDeltaMock,
        releaseDesktopPetOverlayDragVelocity: releaseDesktopPetOverlayDragVelocityMock,
        endDesktopPetOverlayDragSession: endDesktopPetOverlayDragSessionMock,
        showMainWindowFromDesktopPetOverlay: showMainWindowFromDesktopPetOverlayMock,
        syncDesktopPetOverlayElementMetrics: syncDesktopPetOverlayElementMetricsMock,
        getDesktopPetOverlayWindowState: getDesktopPetOverlayWindowStateMock,
        listenDesktopPetOverlayWindowState: listenDesktopPetOverlayWindowStateMock,
        listenDesktopPetOverlayNativeMouse: listenDesktopPetOverlayNativeMouseMock,
    };
});

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: executePetOverlayActionMock,
    }),
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => applyLocalSettingsMock,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    const readAccountSettings = (): typeof settingsDefaults => ({
        ...settingsDefaults,
        ...settingsState.current,
    });
    const readLocalSettings = (): typeof localSettingsDefaults => ({
        ...localSettingsDefaults,
        ...localSettingsState.current,
    });

    const createPetsStorageStore = () =>
        createStorageStoreMock({
            isDataReady: true,
            sessions: Object.fromEntries(sessionsState.current.map((session) => {
                const signals = sessionSignalsState.current[session.id];
                return [session.id, signals?.hasUnreadMessages === true
                    ? {
                        ...session,
                        seq: Math.max(1, session.seq ?? 0),
                        lastViewedSessionSeq: 0,
                    }
                    : session];
            })),
            sessionListIndexByServerId: {
                [activeServerSnapshotState.current.serverId]: sessionsState.current.map((session) => ({
                    type: 'session' as const,
                    sessionId: session.id,
                    serverId: activeServerSnapshotState.current.serverId,
                })),
            },
            sessionListRenderables: {},
            concurrentSessionListCacheByServerId: {},
            sessionMessages: Object.fromEntries(
                Object.entries(sessionSignalsState.current).map(([sessionId, signals]) => [sessionId, {
                    messageIdsOldestFirst: signals.latestMessageText ? [`message-${sessionId}`] : [],
                    messagesById: signals.latestMessageText ? {
                        [`message-${sessionId}`]: {
                            id: `message-${sessionId}`,
                            localId: `message-${sessionId}`,
                            kind: 'agent-text',
                            text: signals.latestMessageText,
                            createdAt: signals.latestMeaningfulActivityAtMs ?? 1,
                        },
                    } : {},
                    messagesMap: {},
                    reducerState: createReducer(),
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: signals.latestThinkingActivityAtMs ?? null,
                    messagesVersion: 1,
                    isLoaded: true,
                }]),
            ),
            sessionPending: {},
            accountPetsById: accountPetsState.current,
            localPetSourcesBySourceKey: localPetSourcesState.current,
        });
    function storageStub(): StorageState;
    function storageStub<U>(selector: (state: StorageState) => U): U;
    function storageStub<U>(selector?: (state: StorageState) => U): StorageState | U {
        const store = createPetsStorageStore();
        return selector ? store(selector) : store();
    }
    const storage = Object.assign(storageStub, {
        getState: () => createPetsStorageStore().getState(),
        getInitialState: () => createPetsStorageStore().getInitialState(),
        setState: () => undefined,
        subscribe: () => () => undefined,
        destroy: () => undefined,
    }) satisfies UseBoundStore<StoreApi<StorageState>>;

    return createStorageModuleMock({
        importOriginal,
        overrides: {
            ...actual,
            useSettings: readAccountSettings,
            useSetting: ((name) => readAccountSettings()[name]) as typeof actual.useSetting,
            useLocalSettings: readLocalSettings,
            useLocalSetting: ((name) => readLocalSettings()[name]) as typeof actual.useLocalSetting,
            useAllMachines: () => [createMachineFixture({ id: 'machine-pets' })],
            useAllSessions: () => sessionsState.current,
            useHasUnreadMessages: (sessionId: string) =>
                sessionSignalsState.current[sessionId]?.hasUnreadMessages === true,
            useSessionLatestThinkingMessageActivityAtMs: (sessionId: string) =>
                sessionSignalsState.current[sessionId]?.latestThinkingActivityAtMs ?? null,
            useSessionListMeaningfulActivityAt: (sessionId: string) =>
                sessionSignalsState.current[sessionId]?.latestMeaningfulActivityAtMs ?? null,
            useSessionPendingMessages: () => ({
                messages: [],
                discarded: [],
                isLoaded: true,
            }),
            storage,
        },
    });
});

function responseWithAsset(mediaType: string, bytes: readonly number[]) {
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': mediaType }),
        arrayBuffer: async () => Uint8Array.from(bytes).buffer,
    };
}

function resolvePressableStyle(style: unknown): Record<string, unknown> {
    const styleValue = typeof style === 'function'
        ? style({ pressed: false, hovered: false, focused: false })
        : style;
    return StyleSheet.flatten(styleValue) ?? {};
}

type TestMeasuredElementId = 'root' | 'mascot' | 'tray' | 'controls';

type TestRect = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
}>;

function createMeasuredElement(rect: TestRect): Element {
    const element = {
        getBoundingClientRect: () => ({
            ...rect,
            top: rect.y,
            left: rect.x,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height,
            toJSON: () => rect,
        }),
    };
    return element as unknown as Element;
}

function installDesktopPetOverlayMeasurementHarness() {
    const frameCallbacks = [] as FrameRequestCallback[];
    const observers = [] as Array<{
        observe: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
        flush: () => void;
    }>;

    class TestResizeObserver {
        private readonly callback: ResizeObserverCallback;
        readonly observe = vi.fn();
        readonly disconnect = vi.fn();

        constructor(callback: ResizeObserverCallback) {
            this.callback = callback;
            observers.push({
                observe: this.observe,
                disconnect: this.disconnect,
                flush: () => {
                    this.callback([], this as unknown as ResizeObserver);
                },
            });
        }
    }

    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    return {
        observers,
        flushFrame: async () => {
            const callback = frameCallbacks.shift();
            await act(async () => {
                callback?.(0);
            });
        },
    };
}

describe('DesktopPetOverlayRoute selectors', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(12_000);
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
        settingsState.current = {
            petsEnabled: true,
            petsSelectedPetRef: { kind: 'builtIn', petId: 'blink' },
        };
        localSettingsState.current = {
            petsEnabledOverride: 'inherit',
            petsSelectedPetOverride: { kind: 'inherit' },
            petsCompanionSizeScale: 1,
        };
        featureDecisionState.companion = { state: 'enabled' };
        featureDecisionState.sync = { state: 'enabled' };
        accountPetsState.current = {};
        localPetSourcesState.current = {};
        sessionsState.current = [];
        sessionSignalsState.current = {};
        serverFetchMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        startDesktopPetOverlayDragSessionMock.mockReset();
        applyDesktopPetOverlayDragDeltaMock.mockReset();
        releaseDesktopPetOverlayDragVelocityMock.mockReset();
        endDesktopPetOverlayDragSessionMock.mockReset();
        showMainWindowFromDesktopPetOverlayMock.mockReset();
        syncDesktopPetOverlayElementMetricsMock.mockReset();
        getDesktopPetOverlayWindowStateMock.mockReset();
        getDesktopPetOverlayWindowStateMock.mockResolvedValue(null);
        listenDesktopPetOverlayWindowStateMock.mockReset();
        listenDesktopPetOverlayWindowStateMock.mockResolvedValue(() => {});
        listenDesktopPetOverlayNativeMouseMock.mockReset();
        listenDesktopPetOverlayNativeMouseMock.mockResolvedValue(() => {});
        executePetOverlayActionMock.mockReset();
        executePetOverlayActionMock.mockResolvedValue({ ok: true });
        applyLocalSettingsMock.mockReset();
        platformState.os = 'web';
        vi.unstubAllGlobals();
    });

    it('renders the overlay root and sprite selectors for UI e2e', async () => {
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        expect(screen.findByTestId('desktop-pet-overlay-root')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-sprite')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-hitbox')?.props.accessibilityRole).toBe('button');
        expect(screen.findByTestId('desktop-pet-overlay-hitbox')?.props.accessibilityLabel).toEqual(expect.any(String));
        expect(screen.findByTestId('desktop-pet-overlay-sprite')?.props.accessibilityElementsHidden).toBe(true);
        expect(screen.findByTestId('desktop-pet-overlay-sprite')?.props.importantForAccessibility).toBe(
            'no-hide-descendants',
        );
        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('idle');
        expect(screen.root.findAllByType('Image')[0]?.props.source).toBe(
            resolveBuiltInPetPackage('blink').spritesheetSource,
        );
    });

    it('keeps rendering the pet when the native window-state event bridge is not ready yet', async () => {
        listenDesktopPetOverlayWindowStateMock.mockRejectedValueOnce(new Error('event-bridge-not-ready'));
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        await flushHookEffects();

        expect(screen.findByTestId('desktop-pet-overlay-root')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-sprite')).not.toBeNull();
    });

    it('can render tray activity from native window state without reading session activity locally', async () => {
        sessionsState.current = [];
        const nativeActivity = {
            state: 'waiting',
            reason: 'permission',
            sessionId: 'session-native',
            trayItems: [{
                id: 'session-native:permission',
                dismissKey: 'session-native:permission',
                sessionId: 'session-native',
                status: 'waiting',
                priority: 100,
                title: 'Native session',
                subtitle: 'Waiting for approval',
                activityAtMs: 12_000,
                expiresAtMs: null,
                actions: {
                    primary: 'open',
                    quickReply: false,
                    dismiss: false,
                },
            }],
        };
        getDesktopPetOverlayWindowStateMock.mockResolvedValue({
            visible: true,
            inputLocked: false,
            monitorId: 'monitor-1',
            logicalPosition: { x: 0, y: 0 },
            logicalSize: { width: 320, height: 280 },
            scaleFactor: 1,
            lastPlacementRecoveryCode: null,
            activity: nativeActivity,
        });
        listenDesktopPetOverlayWindowStateMock.mockImplementation(async (handler) => {
            handler({
                visible: true,
                inputLocked: false,
                monitorId: 'monitor-1',
                logicalPosition: { x: 0, y: 0 },
                logicalSize: { width: 320, height: 280 },
                scaleFactor: 1,
                lastPlacementRecoveryCode: null,
                activity: nativeActivity,
            });
            return () => {};
        });
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute activitySource="native" />);
        await flushHookEffects();

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('waiting');
        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-native')).not.toBeNull();
    });

    it('does not render fallback art when the companion selection is disabled', async () => {
        featureDecisionState.companion = { state: 'disabled' };
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        expect(screen.findByTestId('desktop-pet-overlay-root')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-sprite')).toBeNull();
        expect(screen.root.findAllByType('Image')).toHaveLength(0);
    });

    it('renders the desktop overlay sprite inside visible mascot bounds', async () => {
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const stateStyle = StyleSheet.flatten(screen.findByTestId('pet-companion-state')?.props.style);
        const spriteStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-sprite')?.props.style);

        expect(spriteStyle?.width).toBeCloseTo(92, 4);
        expect(spriteStyle?.height).toBeCloseTo(99.6666666667, 4);
        expect(stateStyle?.width).toBeCloseTo(92, 4);
        expect(stateStyle?.height).toBeCloseTo(99.6666666667, 4);
    });

    it('applies the local companion size scale to desktop overlay sprite bounds', async () => {
        localSettingsState.current = {
            ...localSettingsState.current,
            petsCompanionSizeScale: 1.5,
        };
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const stateStyle = StyleSheet.flatten(screen.findByTestId('pet-companion-state')?.props.style);
        const spriteStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-sprite')?.props.style);

        expect(spriteStyle?.width).toBeCloseTo(138, 4);
        expect(spriteStyle?.height).toBeCloseTo(149.5, 4);
        expect(stateStyle?.width).toBeCloseTo(138, 4);
        expect(stateStyle?.height).toBeCloseTo(149.5, 4);
    });

    it('keeps the desktop overlay idle frame still between ambient actions', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        expect(screen.root.findAllByType('Image')[0]?.props.style.transform).toEqual([
            { translateX: -0 },
            { translateY: -0 },
        ]);

        await act(async () => {
            vi.advanceTimersByTime(300);
        });

        expect(screen.root.findAllByType('Image')[0]?.props.style.transform).toEqual([
            { translateX: -0 },
            { translateY: -0 },
        ]);
    });

    it('reacts to a pet tap with a short jumping state', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        await screen.pressByTestIdAsync('desktop-pet-overlay-hitbox');

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('jumping');
        expect(screen.findByTestId('desktop-pet-overlay-sprite')?.props['data-pet-state']).toBe('jumping');
        expect(showMainWindowFromDesktopPetOverlayMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            vi.advanceTimersByTime(980);
        });

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('idle');
    });

    it('derives the rendered overlay state from existing active session selectors', async () => {
        const session = createSessionFixture({
            id: 'session-running',
            active: true,
            thinking: true,
            thinkingAt: Date.now(),
            seq: 0,
        });
        sessionsState.current = [
            {
                ...session,
                metadata: {
                    ...session.metadata!,
                    readStateV1: { v: 1, sessionSeq: 0, pendingActivityAt: 0, updatedAt: 0 },
                },
            },
        ];

        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('running');
    });

    it('derives persistent waiting attention from the existing unread session selector', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-unread', active: true, thinking: false }),
        ];
        sessionSignalsState.current = {
            'session-unread': {
                hasUnreadMessages: true,
                latestThinkingActivityAtMs: null,
                latestMeaningfulActivityAtMs: 9_000,
            },
        };

        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('waiting');
    });

    it('renders activity tray items as no-drag actionable status cards', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-waiting', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const tray = screen.findByTestId('desktop-pet-overlay-tray');
        const item = screen.findByTestId('desktop-pet-overlay-tray-item-session-waiting');
        const status = screen.findByTestId('desktop-pet-overlay-tray-status-session-waiting');

        expect(tray).not.toBeNull();
        expect(tray?.props['data-pet-no-drag']).toBe('true');
        expect(item).not.toBeNull();
        expect(item?.props.accessibilityRole).toBe('button');
        expect(item?.props.accessibilityLabel).toEqual(expect.any(String));
        expect(item?.props['data-pet-no-drag']).toBe('true');
        expect(item?.props.dataSet).toEqual({
            petNoDrag: 'true',
            petTraySessionId: 'session-waiting',
        });
        expect(status).not.toBeNull();
    });

    it('renders collapsed tray bubbles without visible status text or heavy card borders', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-compact', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const tray = screen.findByTestId('desktop-pet-overlay-tray');
        const item = screen.findByTestId('desktop-pet-overlay-tray-item-session-compact');
        const surface = screen.findByTestId('desktop-pet-overlay-tray-surface-session-compact');
        const status = screen.findByTestId('desktop-pet-overlay-tray-status-session-compact');
        const replyRow = screen.findByTestId('desktop-pet-overlay-tray-reply-row-session-compact');
        const statusLabel = status?.props.accessibilityLabel;

        expect(item?.props['data-pet-collapsed']).toBe('true');
        expect(item?.props['data-pet-reply-expanded']).toBe('false');
        expect(screen.root.findAll((node) => node.props?.children === statusLabel)).toHaveLength(0);
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-compact')).toBeNull();

        const trayStyle = StyleSheet.flatten(tray?.props.style);
        const itemStyle = resolvePressableStyle(item?.props.style);
        const surfaceStyle = StyleSheet.flatten(surface?.props.style);
        const statusStyle = StyleSheet.flatten(status?.props.style);
        const replyRowStyle = StyleSheet.flatten(replyRow?.props.style);

        expect(surface).not.toBeNull();
        expect(surfaceStyle?.position).toBe('absolute');
        expect(surfaceStyle?.backgroundColor).toEqual(expect.any(String));
        expect(surfaceStyle?.boxShadow).toBeUndefined();
        expect(trayStyle?.width).toBeLessThanOrEqual(276);
        expect(trayStyle?.maxHeight).toBeGreaterThanOrEqual(220);
        expect(trayStyle?.overflow).toBe('hidden');
        expect(tray?.props['data-pet-scroll-fade-top']).toBe('false');
        expect(tray?.props['data-pet-scroll-fade-bottom']).toBe('false');
        expect(itemStyle.height).toBeUndefined();
        expect(itemStyle.minHeight).toBeUndefined();
        expect((itemStyle.borderWidth as number | undefined) ?? 0).toBe(0);
        expect(itemStyle.boxShadow).toBeUndefined();
        expect(statusStyle?.position).toBe('absolute');
        expect((statusStyle?.borderWidth as number | undefined) ?? 0).toBe(0);
        expect(statusStyle?.width).toBeLessThanOrEqual(18);
        expect(statusStyle?.height).toBeLessThanOrEqual(18);
        expect(replyRowStyle?.overflow).toBe('hidden');
        expect(replyRowStyle?.opacity).toBe(0);
        expect(replyRow?.props.accessibilityElementsHidden).toBe(true);
    });

    it('keeps every activity bubble mounted inside the scrollable tray while preserving the full badge count', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-first', active: true, pendingCount: 1, updatedAt: 30 }),
            createSessionFixture({ id: 'session-second', active: true, pendingCount: 1, updatedAt: 20 }),
            createSessionFixture({ id: 'session-third', active: true, pendingCount: 1, updatedAt: 10 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-first')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-second')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-third')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-tray-scroll')).not.toBeNull();

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-context-toggle'), 'onPress');
        });

        expect(screen.findByTestId('desktop-pet-overlay-context-toggle')?.props['data-pet-tray-count']).toBe('3');
    });

    it('uses Codex status icon semantics without making the status badge a reply toggle', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-status-waiting', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const status = screen.findByTestId('desktop-pet-overlay-tray-status-session-status-waiting');

        expect(status?.props['data-pet-status-icon']).toBe('time-outline');
        expect(status?.props.accessibilityRole).toBeUndefined();
        expect(status?.props.onPress).toBeUndefined();
    });

    it('keeps collapsed tray actions out of layout and pointer flow until hover expansion', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-action-layout', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const dismissTestID = 'desktop-pet-overlay-tray-dismiss-session-action-layout';
        const itemTestID = 'desktop-pet-overlay-tray-item-session-action-layout';
        const collapsedDismiss = screen.findByTestId(dismissTestID);
        const collapsedDismissStyle = resolvePressableStyle(collapsedDismiss?.props.style);

        expect(collapsedDismissStyle.position).toBe('absolute');
        expect(collapsedDismiss?.props.pointerEvents).toBe('none');

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId(itemTestID), 'onHoverIn');
        });

        const expandedDismiss = screen.findByTestId(dismissTestID);
        const expandedDismissStyle = resolvePressableStyle(expandedDismiss?.props.style);
        expect(expandedDismiss?.props.pointerEvents).toBe('auto');
        expect(expandedDismissStyle.left).toBe(4);
        expect(expandedDismissStyle.right).toBeUndefined();
    });

    it('positions compact tray bubbles absolutely above the mascot instead of expanding the row layout', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-positioned', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const rootStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-root')?.props.style);
        const stateStyle = StyleSheet.flatten(screen.findByTestId('pet-companion-state')?.props.style);
        const trayStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-tray')?.props.style);

        expect(rootStyle?.position).toBe('relative');
        expect(stateStyle?.position).toBe('absolute');
        expect(stateStyle?.right).toEqual(expect.any(Number));
        expect(stateStyle?.bottom).toEqual(expect.any(Number));
        expect(trayStyle?.position).toBe('absolute');
        expect(trayStyle?.right).toEqual(expect.any(Number));
        expect(trayStyle?.bottom).toEqual(expect.any(Number));
        expect(trayStyle?.right).toBe(stateStyle?.right);
        expect(trayStyle?.bottom).toBeCloseTo(125.6666666667, 4);
        expect((trayStyle?.bottom as number)).toBeGreaterThan((stateStyle?.bottom as number));

        const controlsStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-context-anchor')?.props.style);
        expect(controlsStyle?.right).toBe(stateStyle?.right);
        expect(controlsStyle?.bottom).toBeCloseTo(99.6666666667, 4);
    });

    it('keeps native measured tray placement fluid so reply expansion can resize the transparent overlay window', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-native-layout', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(
            <DesktopPetOverlayRoute
                nativeLayoutState={{
                    window: { width: 298, height: 274 },
                    tray: { x: 0, y: 0, width: 276, height: 132 },
                    mascot: { x: 182, y: 150, width: 116, height: 124 },
                    controls: { x: 258, y: 122, width: 30, height: 30 },
                }}
            />,
        );

        const rootStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-root')?.props.style);
        const trayStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-tray')?.props.style);

        expect(rootStyle?.width).toBe(298);
        expect(rootStyle?.height).toBe(274);
        expect(trayStyle?.left).toBe(0);
        expect(trayStyle?.bottom).toBe(142);
        expect(trayStyle?.width).toBe(276);
        expect(trayStyle?.height).toBeUndefined();
        expect(trayStyle?.maxHeight).toBeGreaterThanOrEqual(220);
    });

    it('does not clip tray bubbles behind a stale compact native layout state', async () => {
        sessionsState.current = [
            createSessionFixture({
                id: 'session-stale-compact-layout',
                active: true,
                pendingCount: 0,
                seq: 2,
                lastViewedSessionSeq: 1,
            }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(
            <DesktopPetOverlayRoute
                nativeLayoutState={{
                    window: { width: 120, height: 128 },
                    mascot: { x: 0, y: 4, width: 116, height: 124 },
                    tray: null,
                    controls: { x: 86, y: 20, width: 30, height: 30 },
                }}
            />,
        );

        const rootStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-root')?.props.style);
        const tray = screen.findByTestId('desktop-pet-overlay-tray');
        const trayStyle = StyleSheet.flatten(tray?.props.style);

        expect(rootStyle).toEqual(expect.objectContaining({ width: 356, height: 420 }));
        expect(tray).not.toBeNull();
        expect(tray?.props['data-pet-tray-open']).toBe('true');
        expect(trayStyle?.bottom).toEqual(expect.any(Number));
    });

    it('reports measured mascot, tray, and control bounds to the native layout owner without duplicate resizes', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-measured', active: true, pendingCount: 1 }),
        ];
        const harness = installDesktopPetOverlayMeasurementHarness();
        const elements: Record<TestMeasuredElementId, Element> = {
            root: createMeasuredElement({ x: 10, y: 20, width: 356, height: 320 }),
            mascot: createMeasuredElement({ x: 238, y: 222.3333333333, width: 92, height: 99.6666666667 }),
            tray: createMeasuredElement({ x: 54, y: 82.3333333333, width: 276, height: 132 }),
            controls: createMeasuredElement({ x: 300, y: 190.3333333333, width: 30, height: 30 }),
        };
        const onMeasuredLayoutChange = vi.fn();
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        await renderScreen(
            <DesktopPetOverlayRoute
                measurementElementResolver={(elementId: TestMeasuredElementId) => elements[elementId] ?? null}
                onMeasuredLayoutChange={onMeasuredLayoutChange}
            />,
        );
        await harness.flushFrame();
        harness.observers[0]?.flush();
        await harness.flushFrame();

        expect(syncDesktopPetOverlayElementMetricsMock).toHaveBeenCalledTimes(1);
        expect(syncDesktopPetOverlayElementMetricsMock).toHaveBeenCalledWith({
            isTrayVisible: true,
            mascot: { x: 228, y: 202.3333333333, width: 92, height: 99.6666666667 },
            tray: { x: 44, y: 62.333333333300004, width: 276, height: 132 },
            controls: { x: 290, y: 170.3333333333, width: 30, height: 30 },
        });
        expect(onMeasuredLayoutChange).toHaveBeenCalledWith({
            window: { width: 356, height: 320 },
            mascot: { x: 228, y: 202.3333333333, width: 92, height: 99.6666666667 },
            tray: { x: 44, y: 62.333333333300004, width: 276, height: 132 },
            controls: { x: 290, y: 170.3333333333, width: 30, height: 30 },
        });
        const observedElements = harness.observers.flatMap((observer) =>
            observer.observe.mock.calls.map(([element]) => element),
        );
        expect(observedElements).toContain(elements.root);
        expect(observedElements).toContain(elements.mascot);
        expect(observedElements).toContain(elements.tray);
        expect(observedElements).toContain(elements.controls);

        expect(syncDesktopPetOverlayElementMetricsMock).toHaveBeenCalledTimes(1);
    });

    it('keeps expanded fallback tray metrics when reply expansion briefly remounts the tray element', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-reply-remount', active: true, pendingCount: 1 }),
        ];
        const harness = installDesktopPetOverlayMeasurementHarness();
        const elements: Partial<Record<TestMeasuredElementId, Element>> = {
            root: createMeasuredElement({ x: 10, y: 20, width: 356, height: 420 }),
            mascot: createMeasuredElement({ x: 238, y: 296.3333333333, width: 92, height: 99.6666666667 }),
            controls: createMeasuredElement({ x: 300, y: 264.3333333333, width: 30, height: 30 }),
        };
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        await renderScreen(
            <DesktopPetOverlayRoute
                measurementElementResolver={(elementId: TestMeasuredElementId) => elements[elementId] ?? null}
            />,
        );
        await harness.flushFrame();

        expect(syncDesktopPetOverlayElementMetricsMock).toHaveBeenLastCalledWith(expect.objectContaining({
            isTrayVisible: true,
            tray: expect.objectContaining({
                width: 276,
                height: expect.any(Number),
            }),
        }));
    });

    it('reports a null tray measurement when the tray is collapsed', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-collapsed-metrics', active: true, pendingCount: 1 }),
        ];
        const harness = installDesktopPetOverlayMeasurementHarness();
        const elements: Record<TestMeasuredElementId, Element> = {
            root: createMeasuredElement({ x: 0, y: 0, width: 356, height: 320 }),
            mascot: createMeasuredElement({ x: 204, y: 178, width: 116, height: 124 }),
            tray: createMeasuredElement({ x: 22, y: 44, width: 276, height: 132 }),
            controls: createMeasuredElement({ x: 284, y: 150, width: 30, height: 30 }),
        };
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(
            <DesktopPetOverlayRoute
                measurementElementResolver={(elementId: TestMeasuredElementId) => elements[elementId] ?? null}
            />,
        );

        await harness.flushFrame();
        expect(syncDesktopPetOverlayElementMetricsMock).toHaveBeenLastCalledWith(expect.objectContaining({
            isTrayVisible: true,
            tray: { x: 22, y: 44, width: 276, height: 132 },
        }));
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-context-toggle'), 'onPress');
        });
        await harness.flushFrame();

        expect(syncDesktopPetOverlayElementMetricsMock).toHaveBeenLastCalledWith(expect.objectContaining({
            isTrayVisible: false,
            tray: null,
        }));
    });

    it('uses native layout positions when the overlay window reports measured placement', async () => {
        listenDesktopPetOverlayWindowStateMock.mockImplementation(async (handler) => {
            handler({
                visible: true,
                inputLocked: false,
                monitorId: null,
                logicalPosition: { x: 100, y: 200 },
                logicalSize: { width: 312, height: 244 },
                scaleFactor: 2,
                lastPlacementRecoveryCode: null,
                layout: {
                    placement: 'topEnd',
                    window: { width: 312, height: 244 },
                    mascot: { left: 196, top: 120, width: 116, height: 124 },
                    tray: { left: 0, top: 0, width: 276, height: 112 },
                    controls: { left: 266, top: 108, width: 30, height: 30 },
                },
            });
            return () => {};
        });
        sessionsState.current = [
            createSessionFixture({ id: 'session-native-layout', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        await flushHookEffects();
        const rootStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-root')?.props.style);
        const stateStyle = StyleSheet.flatten(screen.findByTestId('pet-companion-state')?.props.style);
        const trayStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-tray')?.props.style);
        const controlsStyle = StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-context-anchor')?.props.style);

        expect(rootStyle).toEqual(expect.objectContaining({ width: 312, height: 244 }));
        expect(stateStyle).toEqual(expect.objectContaining({ left: 196, top: 120, width: 116, height: 124 }));
        expect(trayStyle).toEqual(expect.objectContaining({ left: 0, bottom: 132, width: 276 }));
        expect(trayStyle?.height).toBeUndefined();
        expect(controlsStyle).toEqual(expect.objectContaining({ left: 266, top: 108 }));
        expect(stateStyle?.right).toBeUndefined();
        expect(trayStyle?.top).toBeUndefined();
    });

    it('reveals tray actions on hover without opening quick reply input', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-hover-reply', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const itemTestID = 'desktop-pet-overlay-tray-item-session-hover-reply';
        const collapsedItem = screen.findByTestId(itemTestID);
        expect(collapsedItem?.props['data-pet-reply-expanded']).toBe('false');

        await act(async () => {
            invokeTestInstanceHandler(collapsedItem, 'onHoverIn');
        });

        const expandedItem = screen.findByTestId(itemTestID);
        const replyRow = screen.findByTestId('desktop-pet-overlay-tray-reply-row-session-hover-reply');
        const replyAction = screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-hover-reply');
        const replyRowStyle = StyleSheet.flatten(replyRow?.props.style);

        expect(expandedItem?.props['data-pet-collapsed']).toBe('false');
        expect(expandedItem?.props['data-pet-reply-expanded']).toBe('false');
        expect(replyRow?.props['data-pet-no-drag']).toBe('true');
        expect(replyRow?.props.dataSet).toEqual({ petNoDrag: 'true' });
        expect(replyRowStyle?.opacity).toBe(0);
        expect(replyRow?.props.accessibilityElementsHidden).toBe(true);
        expect(replyAction).not.toBeNull();
        expect(replyAction?.props.onPointerDown).toEqual(expect.any(Function));
        expect(replyAction?.props.onMouseDown).toEqual(expect.any(Function));
        expect(replyAction?.props.onClick).toEqual(expect.any(Function));
        expect(replyAction?.props.onPressIn).toEqual(expect.any(Function));
        expect(replyAction?.props.onStartShouldSetResponder?.()).toBe(true);
        expect(replyAction?.props.pointerEvents).toBe('auto');
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-hover-reply')).toBeNull();
    });

    it('reveals tray actions from native mouse observations before the webview receives hover events', async () => {
        let nativeMouseHandler: ((payload: { inside: boolean; x: number; y: number }) => void) | null = null;
        listenDesktopPetOverlayNativeMouseMock.mockImplementation(async (handler) => {
            nativeMouseHandler = handler;
            return () => {};
        });
        sessionsState.current = [
            createSessionFixture({ id: 'session-native-hover', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const elementFromPointMock = vi.fn(() => ({
            closest: (selector: string) => selector === '[data-pet-tray-session-id]'
                ? {
                    getAttribute: (name: string) => (
                        name === 'data-pet-tray-session-id' ? 'session-native-hover' : null
                    ),
                }
                : null,
        } as unknown as Element));
        vi.stubGlobal('document', {
            elementFromPoint: elementFromPointMock,
            getElementById: vi.fn(() => null),
        });
        try {
            const screen = await renderScreen(<DesktopPetOverlayRoute />);
            expect(screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-native-hover')?.props.pointerEvents).toBe('none');
            expect(nativeMouseHandler).not.toBeNull();

            await act(async () => {
                nativeMouseHandler?.({ inside: true, x: 24, y: 32 });
            });

            expect(elementFromPointMock).toHaveBeenCalledWith(24, 32);
            expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-native-hover')?.props['data-pet-collapsed']).toBe('false');
            expect(screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-native-hover')?.props.pointerEvents).toBe('auto');

            await act(async () => {
                nativeMouseHandler?.({ inside: false, x: 0, y: 0 });
            });

            expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-native-hover')?.props['data-pet-collapsed']).toBe('true');
            expect(screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-native-hover')?.props.pointerEvents).toBe('none');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('keeps hover actions active while the pointer crosses into the absolute Reply action', async () => {
        vi.useFakeTimers();
        try {
            sessionsState.current = [
                createSessionFixture({ id: 'session-hover-bridge', active: true, pendingCount: 1 }),
            ];
            const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

            const screen = await renderScreen(<DesktopPetOverlayRoute />);
            const itemTestID = 'desktop-pet-overlay-tray-item-session-hover-bridge';
            const item = screen.findByTestId(itemTestID);

            await act(async () => {
                invokeTestInstanceHandler(item, 'onHoverIn');
                invokeTestInstanceHandler(screen.findByTestId(itemTestID), 'onHoverOut');
            });

            const replyAction = screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-hover-bridge');
            expect(replyAction?.props.pointerEvents).toBe('auto');

            await act(async () => {
                invokeTestInstanceHandler(replyAction, 'onHoverIn');
            });

            expect(screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-hover-bridge')?.props.pointerEvents).toBe('auto');
            await act(async () => {
                vi.advanceTimersByTime(160);
            });

            expect(screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-hover-bridge')?.props.pointerEvents).toBe('auto');
        } finally {
            vi.useRealTimers();
        }
    });

    it('opens quick reply controls from the explicit Reply action', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-badge-reply', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const item = screen.findByTestId('desktop-pet-overlay-tray-item-session-badge-reply');
        await act(async () => {
            invokeTestInstanceHandler(item, 'onHoverIn');
        });
        const replyAction = screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-badge-reply');
        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-badge-reply')?.props['data-pet-reply-expanded']).toBe(
            'false',
        );

        await act(async () => {
            invokeTestInstanceHandler(replyAction, 'onPress', { stopPropagation: vi.fn() });
        });

        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-badge-reply')?.props['data-pet-reply-expanded']).toBe(
            'true',
        );
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-badge-reply')).not.toBeNull();
    });

    it('invalidates stale native layout before opening quick reply so the overlay does not collapse between frames', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-reply-layout', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(
            <DesktopPetOverlayRoute
                nativeLayoutState={{
                    placement: 'bottomEnd',
                    window: { width: 312, height: 244 },
                    mascot: { x: 196, y: 120, width: 116, height: 124 },
                    tray: { x: 0, y: 0, width: 276, height: 56 },
                    controls: { x: 266, y: 108, width: 30, height: 30 },
                }}
            />,
        );
        expect(StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-root')?.props.style)).toEqual(
            expect.objectContaining({ width: 312, height: 244 }),
        );

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-tray-item-session-reply-layout'), 'onHoverIn');
        });
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-reply-layout'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });

        expect(StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-root')?.props.style)).toEqual(
            expect.objectContaining({ width: 356, height: 420 }),
        );
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-reply-layout')).not.toBeNull();
    });

    it('keeps bubble height stable on hover so the measured desktop overlay does not jiggle', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-stable-hover', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const item = screen.findByTestId('desktop-pet-overlay-tray-item-session-stable-hover');
        const collapsedItemStyle = resolvePressableStyle(item?.props.style);

        await act(async () => {
            invokeTestInstanceHandler(item, 'onHoverIn');
        });

        const hoveredItemStyle = resolvePressableStyle(screen.findByTestId('desktop-pet-overlay-tray-item-session-stable-hover')?.props.style);
        expect(hoveredItemStyle.height).toBe(collapsedItemStyle.height);
        expect(hoveredItemStyle.minHeight).toBe(collapsedItemStyle.minHeight);
    });

    it('closes quick reply before dismissing the activity bubble', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-close-reply', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-tray-item-session-close-reply'), 'onHoverIn');
        });
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-close-reply'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-close-reply')).not.toBeNull();

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-dismiss-session-close-reply'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });

        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-close-reply')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-close-reply')).toBeNull();
        expect(applyLocalSettingsMock).not.toHaveBeenCalledWith(expect.objectContaining({
            petsDismissedCompanionTrayItemKeys: expect.anything(),
        }));
    });

    it('keeps quick reply open when activity timestamps refresh for the same session', async () => {
        sessionsState.current = [
            createSessionFixture({
                id: 'session-stable-reply',
                active: true,
                pendingCount: 1,
                activeAt: 1_000,
                thinkingAt: 1_000,
            }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-tray-item-session-stable-reply'), 'onHoverIn');
        });
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-stable-reply'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-stable-reply')).not.toBeNull();

        sessionsState.current = [
            createSessionFixture({
                id: 'session-stable-reply',
                active: true,
                pendingCount: 1,
                activeAt: 2_000,
                thinkingAt: 2_000,
            }),
        ];
        await screen.update(<DesktopPetOverlayRoute />);

        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-stable-reply')?.props['data-pet-reply-expanded']).toBe(
            'true',
        );
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-stable-reply')).not.toBeNull();
    });

    it('opens tray items through the existing session action path', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-open', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const item = screen.findByTestId('desktop-pet-overlay-tray-item-session-open');
        expect(item).not.toBeNull();
        if (!item) return;

        await act(async () => {
            invokeTestInstanceHandler(item, 'onPress');
        });

        expect(executePetOverlayActionMock).toHaveBeenCalledWith(
            'session.open',
            { sessionId: 'session-open' },
            expect.objectContaining({ defaultSessionId: 'session-open' }),
        );
        expect(showMainWindowFromDesktopPetOverlayMock).toHaveBeenCalledTimes(1);
    });

    it('dismisses tray items from the no-drag tray action', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-dismiss', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const itemTestID = 'desktop-pet-overlay-tray-item-session-dismiss';
        const dismiss = screen.findByTestId('desktop-pet-overlay-tray-dismiss-session-dismiss');
        expect(screen.findByTestId(itemTestID)).not.toBeNull();
        expect(dismiss).not.toBeNull();
        expect(dismiss?.props.dataSet).toEqual({ petNoDrag: 'true' });
        if (!dismiss) return;

        await act(async () => {
            invokeTestInstanceHandler(dismiss, 'onPress', { stopPropagation: vi.fn() });
        });

        expect(screen.findByTestId(itemTestID)).toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-context-toggle')).toBeNull();
        expect(applyLocalSettingsMock).toHaveBeenCalledWith({
            petsDismissedCompanionTrayItemKeys: expect.arrayContaining([
                expect.stringMatching(/^waiting:session-dismiss:/),
            ]),
        });
    });

    it('persists dismissed tray items until the same session has newer activity', async () => {
        localSettingsState.current = {
            ...localSettingsState.current,
            petsDismissedCompanionTrayItemKeys: ['waiting:session-dismissed:1000'],
        } as typeof localSettingsState.current;
        sessionsState.current = [
            createSessionFixture({
                id: 'session-dismissed',
                active: true,
                pendingCount: 1,
                createdAt: 1_000,
                activeAt: 1_000,
                thinkingAt: 1_000,
            }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-dismissed')).toBeNull();

        sessionsState.current = [
            createSessionFixture({
                id: 'session-dismissed',
                active: true,
                pendingCount: 1,
                createdAt: 1_000,
                activeAt: 2_000,
                thinkingAt: 2_000,
            }),
        ];
        await screen.update(<DesktopPetOverlayRoute />);

        expect(screen.findByTestId('desktop-pet-overlay-tray-item-session-dismissed')).not.toBeNull();
    });

    it('sends quick replies through the existing session message action path', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-reply', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const item = screen.findByTestId('desktop-pet-overlay-tray-item-session-reply');
        await act(async () => {
            invokeTestInstanceHandler(item, 'onHoverIn');
        });
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-action-session-reply'),
                'onPress',
                { stopPropagation: vi.fn() },
            );
        });
        const input = screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-reply');
        const send = screen.findByTestId('desktop-pet-overlay-tray-reply-send-session-reply');
        expect(input).not.toBeNull();
        expect(send).not.toBeNull();
        if (!input || !send) return;

        const sendStyle = resolvePressableStyle(send.props.style);
        const inputShell = screen.findByTestId('desktop-pet-overlay-tray-reply-input-shell-session-reply');
        const replyRow = screen.findByTestId('desktop-pet-overlay-tray-reply-row-session-reply');
        const inputStyle = StyleSheet.flatten(input.props.style);
        const inputShellStyle = StyleSheet.flatten(inputShell?.props.style);
        const replyRowStyle = StyleSheet.flatten(replyRow?.props.style);
        expect(replyRowStyle?.marginTop).toBeGreaterThan(0);
        expect(inputShellStyle?.position).toBe('relative');
        expect(input.props.multiline).toBe(true);
        expect(input.props.numberOfLines).toBe(1);
        expect(input.props.onKeyPress).toEqual(expect.any(Function));
        expect(inputStyle?.outlineStyle).toBe('none');
        expect(inputStyle?.resize).toBe('none');
        expect(inputStyle?.overflowY).toBe('hidden');
        expect(inputStyle?.height).toBe(30);
        expect(inputStyle?.minHeight).toBe(30);
        expect(inputStyle?.maxHeight).toBe(30);
        expect(inputShellStyle?.height).toBe(30);
        expect(inputShellStyle?.maxHeight).toBe(30);
        expect(replyRowStyle?.maxHeight).toBe(30);
        expect(inputStyle?.paddingRight).toBeGreaterThan(36);
        expect(sendStyle.position).toBe('absolute');
        expect(sendStyle.right).toBeGreaterThan(0);
        expect(sendStyle.top).toBeGreaterThan(0);
        expect(sendStyle.width).toBeLessThan(32);
        expect(sendStyle.height).toBe(sendStyle.width);
        expect(sendStyle.borderRadius).toBe((sendStyle.width as number) / 2);
        expect(sendStyle.borderTopLeftRadius).toBeUndefined();
        expect(sendStyle.borderBottomLeftRadius).toBeUndefined();
        expect(sendStyle.borderWidth).toBe(0);
        expect(screen.root.findAll((node) => node.props?.name === 'arrow-up')).toHaveLength(1);

        await act(async () => {
            invokeTestInstanceHandler(inputShell, 'onPress', { stopPropagation: vi.fn() });
            invokeTestInstanceHandler(input, 'onPress', { stopPropagation: vi.fn() });
        });
        await act(async () => {
            invokeTestInstanceHandler(input, 'onPressIn', { stopPropagation: vi.fn() });
        });
        expect(executePetOverlayActionMock).not.toHaveBeenCalledWith(
            'session.open',
            expect.objectContaining({ sessionId: 'session-reply' }),
            expect.anything(),
        );

        const shiftEnterEvent = {
            nativeEvent: { key: 'Enter', shiftKey: true },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        await act(async () => {
            invokeTestInstanceHandler(input, 'onKeyPress', shiftEnterEvent);
        });
        expect(shiftEnterEvent.preventDefault).not.toHaveBeenCalled();
        expect(executePetOverlayActionMock).not.toHaveBeenCalledWith(
            'session.message.send',
            expect.objectContaining({ sessionId: 'session-reply' }),
            expect.anything(),
        );

        await act(async () => {
            invokeTestInstanceHandler(input, 'onChangeText', '  Ship it\nwith details  ');
        });
        const multilineInputStyle = StyleSheet.flatten(
            screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-reply')?.props.style,
        );
        expect(screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-reply')?.props.numberOfLines).toBe(2);
        expect(multilineInputStyle?.height).toBeGreaterThan(30);
        expect(multilineInputStyle?.maxHeight).toBe(multilineInputStyle?.height);
        expect(multilineInputStyle?.overflowY).toBe('hidden');

        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-reply'),
                'onChangeText',
                'line 1\nline 2\nline 3\nline 4',
            );
        });
        const wrappedInputStyle = StyleSheet.flatten(
            screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-reply')?.props.style,
        );
        const wrappedReplyRowStyle = StyleSheet.flatten(
            screen.findByTestId('desktop-pet-overlay-tray-reply-row-session-reply')?.props.style,
        );
        expect(wrappedInputStyle?.height).toBeGreaterThan(60);
        expect(wrappedInputStyle?.overflowY).toBe('auto');
        expect((wrappedReplyRowStyle?.maxHeight ?? 0)).toBeGreaterThanOrEqual(wrappedInputStyle?.height ?? 0);
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-reply'),
                'onChangeText',
                '  Ship it\nwith details  ',
            );
        });

        const enterEvent = {
            nativeEvent: { key: 'Enter', shiftKey: false },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-pet-overlay-tray-reply-input-session-reply'),
                'onKeyPress',
                enterEvent,
            );
        });
        expect(enterEvent.preventDefault).toHaveBeenCalled();
        expect(executePetOverlayActionMock).toHaveBeenCalledWith(
            'session.message.send',
            { sessionId: 'session-reply', message: 'Ship it\nwith details' },
            expect.objectContaining({ defaultSessionId: 'session-reply' }),
        );
        executePetOverlayActionMock.mockClear();

        await act(async () => {
            invokeTestInstanceHandler(input, 'onChangeText', '  Ship it  ');
        });
        await act(async () => {
            invokeTestInstanceHandler(send, 'onPress');
        });

        expect(executePetOverlayActionMock).toHaveBeenCalledWith(
            'session.message.send',
            { sessionId: 'session-reply', message: 'Ship it' },
            expect.objectContaining({ defaultSessionId: 'session-reply' }),
        );
    });

    it('collapses and expands tray bubbles from the no-drag mascot badge', async () => {
        sessionsState.current = [
            createSessionFixture({ id: 'session-toggle', active: true, pendingCount: 1 }),
        ];
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');

        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const action = screen.findByTestId('desktop-pet-overlay-context-toggle');
        expect(action).not.toBeNull();
        expect(action?.props['data-pet-no-drag']).toBe('true');
        expect(action?.props.dataSet).toEqual({ petNoDrag: 'true' });
        expect(action?.props['data-pet-tray-open']).toBe('true');
        expect(screen.findByTestId('desktop-pet-overlay-tray')).not.toBeNull();
        if (!action) return;

        await act(async () => {
            invokeTestInstanceHandler(action, 'onPress');
        });

        expect(applyLocalSettingsMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('desktop-pet-overlay-tray')).not.toBeNull();
        expect(screen.findByTestId('desktop-pet-overlay-tray')?.props.pointerEvents).toBe('none');
        expect(screen.findByTestId('desktop-pet-overlay-tray')?.props.accessibilityElementsHidden).toBe(true);
        expect(StyleSheet.flatten(screen.findByTestId('desktop-pet-overlay-tray')?.props.style)?.opacity).toBe(0);
        expect(screen.findByTestId('desktop-pet-overlay-context-toggle')?.props['data-pet-tray-open']).toBe('false');

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-context-toggle'), 'onPress');
        });

        expect(screen.findByTestId('desktop-pet-overlay-tray')).not.toBeNull();
    });

    it('persists desktop overlay drags through the native bridge', async () => {
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
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        const draggableHitbox = screen.findAll((node) => (
            node.props?.testID === 'desktop-pet-overlay-hitbox'
            && typeof node.props?.onPointerDown === 'function'
        ))[0] ?? null;
        expect(draggableHitbox).not.toBeNull();
        await act(async () => {
            invokeTestInstanceHandler(draggableHitbox, 'onPointerDown', {
                button: 0,
                clientX: 120,
                clientY: 130,
                screenX: 120,
                screenY: 130,
                target: {
                    closest: (selector: string) => selector.includes('data-pet-mascot') ? {} : null,
                },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 144,
                clientY: 118,
            }));
        });

        expect(applyDesktopPetOverlayDragDeltaMock).toHaveBeenCalledWith({
            pointerId: expect.any(Number),
            dx: 24,
            dy: -12,
            coordinateSpace: 'screen',
        });
        expect(screen.findByTestId('pet-companion-state')?.props['data-pet-state']).toBe('running-right');
    });

    it('uses screen coordinates for native window drags so movement is not damped by the moving webview', async () => {
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;

            constructor(
                type: string,
                init: { clientX: number; clientY: number; screenX: number; screenY: number },
            ) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX;
                this.screenY = init.screenY;
            }
        }
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        const draggableHitbox = screen.findAll((node) => (
            node.props?.testID === 'desktop-pet-overlay-hitbox'
            && typeof node.props?.onPointerDown === 'function'
        ))[0] ?? null;
        expect(draggableHitbox).not.toBeNull();
        await act(async () => {
            invokeTestInstanceHandler(draggableHitbox, 'onPointerDown', {
                button: 0,
                clientX: 120,
                clientY: 130,
                screenX: 500,
                screenY: 600,
                target: {
                    closest: (selector: string) => selector.includes('data-pet-mascot') ? {} : null,
                },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 121,
                clientY: 129,
                screenX: 560,
                screenY: 612,
            }));
        });

        expect(applyDesktopPetOverlayDragDeltaMock).toHaveBeenCalledWith({
            pointerId: expect.any(Number),
            dx: 60,
            dy: 12,
            coordinateSpace: 'screen',
        });
    });

    it('starts native window drags from direct web pointerdown events', async () => {
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;

            constructor(
                type: string,
                init: { clientX: number; clientY: number; screenX: number; screenY: number },
            ) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX;
                this.screenY = init.screenY;
            }
        }
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        const draggableHitbox = screen.findByTestId('desktop-pet-overlay-hitbox');
        const setPointerCapture = vi.fn();
        const releasePointerCapture = vi.fn();
        await act(async () => {
            invokeTestInstanceHandler(draggableHitbox, 'onPointerDown', {
                button: 0,
                pointerId: 41,
                clientX: 120,
                clientY: 130,
                screenX: 500,
                screenY: 600,
                currentTarget: {
                    setPointerCapture,
                    releasePointerCapture,
                },
                target: {
                    closest: (selector: string) => selector.includes('data-pet-mascot') ? {} : null,
                },
                timeStamp: 0,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });
        expect(setPointerCapture).toHaveBeenCalledWith(41);

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 121,
                clientY: 129,
                screenX: 548,
                screenY: 624,
            }));
        });

        expect(applyDesktopPetOverlayDragDeltaMock).toHaveBeenCalledWith({
            pointerId: 41,
            dx: 48,
            dy: 24,
            coordinateSpace: 'screen',
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                clientX: 121,
                clientY: 129,
                screenX: 548,
                screenY: 624,
            }));
        });

        expect(releasePointerCapture).toHaveBeenCalledWith(41);
    });

    it('waits for the native drag session before applying screen deltas', async () => {
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;
            pointerId: number;
            button: number;

            constructor(
                type: string,
                init: {
                    clientX: number;
                    clientY: number;
                    screenX: number;
                    screenY: number;
                    pointerId: number;
                    button?: number;
                    timeStamp: number;
                    target?: unknown;
                },
            ) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX;
                this.screenY = init.screenY;
                this.pointerId = init.pointerId;
                this.button = init.button ?? 0;
                Object.defineProperty(this, 'timeStamp', {
                    value: init.timeStamp,
                    configurable: true,
                });
                Object.defineProperty(this, 'target', {
                    value: init.target,
                    configurable: true,
                });
            }
        }
        const dragStart = createDeferred<void>();
        startDesktopPetOverlayDragSessionMock.mockReturnValueOnce(dragStart.promise);
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const target = {
            closest: (selector: string) =>
                selector.includes('data-pet-mascot') || selector.includes('data-avatar-mascot') ? {} : null,
        };

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-hitbox'), 'onPointerDown', {
                button: 0,
                clientX: 120,
                clientY: 130,
                screenX: 500,
                screenY: 600,
                pointerId: 82,
                timeStamp: 1_000,
                target,
                currentTarget: {},
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 150,
                clientY: 130,
                screenX: 560,
                screenY: 624,
                pointerId: 82,
                timeStamp: 1_020,
                target,
            }));
        });
        await flushHookEffects();

        expect(applyDesktopPetOverlayDragDeltaMock).not.toHaveBeenCalled();

        dragStart.resolve();
        await flushHookEffects();

        expect(applyDesktopPetOverlayDragDeltaMock).toHaveBeenCalledWith({
            pointerId: 82,
            dx: 60,
            dy: 24,
            coordinateSpace: 'screen',
        });
    });

    it('waits for native release velocity before ending the drag session', async () => {
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;
            pointerId: number;
            button: number;

            constructor(
                type: string,
                init: {
                    clientX: number;
                    clientY: number;
                    screenX: number;
                    screenY: number;
                    pointerId: number;
                    button?: number;
                    timeStamp: number;
                    target?: unknown;
                },
            ) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX;
                this.screenY = init.screenY;
                this.pointerId = init.pointerId;
                this.button = init.button ?? 0;
                Object.defineProperty(this, 'timeStamp', {
                    value: init.timeStamp,
                    configurable: true,
                });
                Object.defineProperty(this, 'target', {
                    value: init.target,
                    configurable: true,
                });
            }
        }
        const releaseVelocity = createDeferred<void>();
        releaseDesktopPetOverlayDragVelocityMock.mockReturnValueOnce(releaseVelocity.promise);
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        const target = {
            closest: (selector: string) =>
                selector.includes('data-pet-mascot') || selector.includes('data-avatar-mascot') ? {} : null,
        };

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-hitbox'), 'onPointerDown', {
                button: 0,
                clientX: 120,
                clientY: 130,
                screenX: 500,
                screenY: 600,
                pointerId: 83,
                timeStamp: 1_000,
                target,
                currentTarget: {},
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 150,
                clientY: 130,
                screenX: 2_000,
                screenY: 600,
                pointerId: 83,
                timeStamp: 1_020,
                target,
            }));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                clientX: 150,
                clientY: 130,
                screenX: 2_000,
                screenY: 600,
                pointerId: 83,
                timeStamp: 1_020,
                target,
            }));
        });
        await flushHookEffects();

        expect(releaseDesktopPetOverlayDragVelocityMock).toHaveBeenCalledWith({
            pointerId: 83,
            vx: 1_600,
            vy: 0,
            sampleWindowMs: 100,
        });
        expect(endDesktopPetOverlayDragSessionMock).not.toHaveBeenCalled();

        releaseVelocity.resolve();
        await flushHookEffects();

        expect(endDesktopPetOverlayDragSessionMock).toHaveBeenCalledWith({
            pointerId: 83,
            cancelled: false,
            screenX: 2_000,
            screenY: 600,
        });
    });

    it('ignores secondary-button pointer starts', async () => {
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;

            constructor(
                type: string,
                init: { clientX: number; clientY: number; screenX: number; screenY: number },
            ) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX;
                this.screenY = init.screenY;
            }
        }
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-hitbox'), 'onPointerDown', {
                button: 2,
                pointerId: 42,
                clientX: 120,
                clientY: 130,
                screenX: 500,
                screenY: 600,
                currentTarget: { setPointerCapture: vi.fn() },
                target: {
                    closest: (selector: string) => selector.includes('data-pet-mascot') ? {} : null,
                },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 121,
                clientY: 129,
                screenX: 548,
                screenY: 624,
            }));
        });

        expect(applyDesktopPetOverlayDragDeltaMock).not.toHaveBeenCalled();
    });

    it('does not start drags from no-drag descendants', async () => {
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;

            constructor(
                type: string,
                init: { clientX: number; clientY: number; screenX: number; screenY: number },
            ) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX;
                this.screenY = init.screenY;
            }
        }
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-hitbox'), 'onPointerDown', {
                button: 0,
                pointerId: 43,
                clientX: 120,
                clientY: 130,
                screenX: 500,
                screenY: 600,
                currentTarget: { setPointerCapture: vi.fn() },
                target: {
                    closest: (selector: string) => selector.includes('data-pet-no-drag') ? {} : null,
                },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 121,
                clientY: 129,
                screenX: 548,
                screenY: 624,
            }));
        });

        expect(applyDesktopPetOverlayDragDeltaMock).not.toHaveBeenCalled();
    });

    it('captures desktop overlay pointers and releases bounded velocity through the native bridge', async () => {
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;
            pointerId: number;
            button: number;

            constructor(
                type: string,
                init: {
                    clientX: number;
                    clientY: number;
                    screenX: number;
                    screenY: number;
                    pointerId: number;
                    button?: number;
                    timeStamp: number;
                    target?: unknown;
                },
            ) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX;
                this.screenY = init.screenY;
                this.pointerId = init.pointerId;
                this.button = init.button ?? 0;
                Object.defineProperty(this, 'timeStamp', {
                    value: init.timeStamp,
                    configurable: true,
                });
                Object.defineProperty(this, 'target', {
                    value: init.target,
                    configurable: true,
                });
            }
        }
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        const setPointerCapture = vi.fn();
        const releasePointerCapture = vi.fn();
        const draggableHitbox = screen.findByTestId('desktop-pet-overlay-hitbox');
        const target = {
            closest: (selector: string) =>
                selector.includes('data-pet-mascot') || selector.includes('data-avatar-mascot') ? {} : null,
        };
        await act(async () => {
            invokeTestInstanceHandler(draggableHitbox, 'onPointerDown', {
                button: 0,
                clientX: 120,
                clientY: 130,
                screenX: 500,
                screenY: 600,
                pointerId: 42,
                timeStamp: 1_000,
                target,
                currentTarget: {
                    setPointerCapture,
                    releasePointerCapture,
                },
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 150,
                clientY: 130,
                screenX: 2_000,
                screenY: 600,
                pointerId: 42,
                timeStamp: 1_020,
                target,
            }));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                clientX: 150,
                clientY: 130,
                screenX: 2_000,
                screenY: 600,
                pointerId: 42,
                timeStamp: 1_020,
                target,
            }));
        });

        expect(setPointerCapture).toHaveBeenCalledWith(42);
        expect(startDesktopPetOverlayDragSessionMock).toHaveBeenCalledWith({
            pointerId: 42,
            screenX: 500,
            screenY: 600,
            startedAtMs: 1_000,
        });
        expect(applyDesktopPetOverlayDragDeltaMock).toHaveBeenCalledWith({
            pointerId: 42,
            dx: 1_500,
            dy: 0,
            coordinateSpace: 'screen',
        });
        expect(releaseDesktopPetOverlayDragVelocityMock).toHaveBeenCalledWith({
            pointerId: 42,
            vx: 1_600,
            vy: 0,
            sampleWindowMs: 100,
        });
        expect(endDesktopPetOverlayDragSessionMock).toHaveBeenCalledWith({
            pointerId: 42,
            cancelled: false,
            screenX: 2_000,
            screenY: 600,
        });
        expect(releaseDesktopPetOverlayDragVelocityMock.mock.invocationCallOrder[0]).toBeLessThan(
            endDesktopPetOverlayDragSessionMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(releasePointerCapture).toHaveBeenCalledWith(42);
        expect(showMainWindowFromDesktopPetOverlayMock).not.toHaveBeenCalled();
    });

    it('treats below-threshold pointer movement as a mascot click without moving the native window', async () => {
        class TestPointerEvent extends Event {
            clientX: number;
            clientY: number;
            screenX: number;
            screenY: number;
            pointerId: number;
            button: number;

            constructor(
                type: string,
                init: {
                    clientX: number;
                    clientY: number;
                    screenX: number;
                    screenY: number;
                    pointerId: number;
                    button?: number;
                    timeStamp: number;
                    target?: unknown;
                },
            ) {
                super(type);
                this.clientX = init.clientX;
                this.clientY = init.clientY;
                this.screenX = init.screenX;
                this.screenY = init.screenY;
                this.pointerId = init.pointerId;
                this.button = init.button ?? 0;
                Object.defineProperty(this, 'timeStamp', {
                    value: init.timeStamp,
                    configurable: true,
                });
                Object.defineProperty(this, 'target', {
                    value: init.target,
                    configurable: true,
                });
            }
        }
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 320, innerHeight: 260 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);

        const target = {
            closest: (selector: string) =>
                selector.includes('data-pet-mascot') || selector.includes('data-avatar-mascot') ? {} : null,
        };
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-hitbox'), 'onPointerDown', {
                button: 0,
                clientX: 120,
                clientY: 130,
                screenX: 500,
                screenY: 600,
                pointerId: 51,
                timeStamp: 1_000,
                target,
                currentTarget: {},
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', {
                clientX: 121,
                clientY: 130,
                screenX: 502,
                screenY: 600,
                pointerId: 51,
                timeStamp: 1_010,
                target,
            }));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointerup', {
                clientX: 121,
                clientY: 130,
                screenX: 502,
                screenY: 600,
                pointerId: 51,
                timeStamp: 1_020,
                target,
            }));
        });

        expect(startDesktopPetOverlayDragSessionMock).toHaveBeenCalledWith({
            pointerId: 51,
            screenX: 500,
            screenY: 600,
            startedAtMs: 1_000,
        });
        expect(applyDesktopPetOverlayDragDeltaMock).not.toHaveBeenCalled();
        expect(releaseDesktopPetOverlayDragVelocityMock).not.toHaveBeenCalled();
        expect(endDesktopPetOverlayDragSessionMock).toHaveBeenCalledWith({
            pointerId: 51,
            cancelled: false,
            screenX: 502,
            screenY: 600,
        });

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-pet-overlay-hitbox'), 'onPress', {
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        expect(showMainWindowFromDesktopPetOverlayMock).toHaveBeenCalledWith({ reason: 'mascot-click' });
        expect(showMainWindowFromDesktopPetOverlayMock).toHaveBeenCalledTimes(1);
    });

    it('renders the selected account pet spritesheet instead of hardcoded Blink', async () => {
        settingsState.current = {
            petsEnabled: true,
            petsSelectedPetRef: { kind: 'accountPet', accountPetId: accountPet.accountPetId },
        };
        accountPetsState.current = {
            [accountPet.accountPetId]: accountPet,
        };
        serverFetchMock.mockResolvedValue(responseWithAsset('image/webp', [1, 2, 3]));

        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        await flushHookEffects();

        expect(serverFetchMock).toHaveBeenCalledWith(
            `/v1/account/pets/${accountPet.accountPetId}/spritesheet`,
            undefined,
            { retry: 'none' },
        );
        expect(screen.root.findAllByType('Image')[0]?.props.source).toBe('data:image/webp;base64,AQID');
    });

    it('falls back to Blink when the account pet spritesheet media type is not allowed', async () => {
        settingsState.current = {
            petsEnabled: true,
            petsSelectedPetRef: { kind: 'accountPet', accountPetId: accountPet.accountPetId },
        };
        accountPetsState.current = {
            [accountPet.accountPetId]: accountPet,
        };
        serverFetchMock.mockResolvedValue(responseWithAsset('image/svg+xml', [1, 2, 3]));

        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        await flushHookEffects();

        expect(screen.root.findAllByType('Image')[0]?.props.source).toBe(
            resolveBuiltInPetPackage('blink').spritesheetSource,
        );
    });

    it('renders the selected local daemon preview without exposing local paths', async () => {
        localSettingsState.current = {
            petsEnabledOverride: 'inherit',
            petsSelectedPetOverride: { kind: 'happierManagedLocal', sourceKey: 'managed:blink' },
            petsCompanionSizeScale: 1,
        };
        localPetSourcesState.current = {
            'managed:blink': {
                sourceKey: 'managed:blink',
                source: {
                    kind: 'happierManagedLocal',
                    sourceKey: 'managed:blink',
                    packagePath: '/Users/tester/.happier/pets/managed-blink',
                },
                displayName: 'Managed Blink',
                manifest: {
                    id: 'managed-blink',
                    displayName: 'Managed Blink',
                    description: 'Managed pet',
                    spritesheetPath: 'spritesheet.png',
                },
                mediaType: 'image/png',
                digest: 'sha256:managed',
                sizeBytes: 3,
                daemonTarget: {
                    machineId: 'machine-pets',
                    serverId: 'server-pets',
                },
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValue({
            sourceKey: 'managed:blink',
            mediaType: 'image/png',
            digest: 'sha256:managed',
            dataBase64: 'AQID',
            sizeBytes: 3,
        });

        const { DesktopPetOverlayRoute } = await import('./DesktopPetOverlayRoute');
        const screen = await renderScreen(<DesktopPetOverlayRoute />);
        await flushHookEffects();

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-pets',
            serverId: 'server-pets',
            method: PET_DAEMON_RPC_METHODS.READ_PREVIEW_ASSET,
            payload: { sourceKey: 'managed:blink' },
        });
        expect(screen.root.findAllByType('Image')[0]?.props.source).toBe('data:image/png;base64,AQID');
        expect(JSON.stringify(screen.root.findAllByType('Image')[0]?.props)).not.toContain('/Users/');

        standardCleanup();
        const secondScreen = await renderScreen(<DesktopPetOverlayRoute />);
        await flushHookEffects();

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(secondScreen.root.findAllByType('Image')[0]?.props.source).toBe('data:image/png;base64,AQID');
    });
});
