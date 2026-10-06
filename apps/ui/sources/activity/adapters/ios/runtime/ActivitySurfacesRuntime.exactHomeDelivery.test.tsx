import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { settingsParse } from '@/sync/domains/settings/settings';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import type { StorageState } from '@/sync/store/types';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';

import type { LiveActivitySnapshot } from '../liveActivities/buildLiveActivitySnapshots';

vi.hoisted(async () => {
    const { mkdirSync, realpathSync } = await import('node:fs');
    const { join } = await import('node:path');
    const cache = join(realpathSync('node_modules'), '.cache', 'ci03-ios-runtime-exact-home');
    mkdirSync(cache, { recursive: true });
    vi.stubEnv('TMPDIR', cache);
});

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const HOME_A = 'server-a';
const HOME_B = 'server-b';
/** A Home this device can name but whose Account settings it has never persisted. */
const HOME_UNRESOLVED = 'server-c';
/** One Session ID on two Homes: exact-Home policy must never collapse them. */
const SHARED_SESSION_ID = 'shared-session';

const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' | 'android' }));
const appStateState = vi.hoisted(() => ({
    currentState: 'active' as 'active' | 'inactive' | 'background',
    listeners: new Set<(state: 'active' | 'inactive' | 'background') => void>(),
}));
const sessionRowsState = vi.hoisted(() => ({
    value: [] as Array<{ serverId: string; session: Session }>,
}));
const settingsState = vi.hoisted(() => ({
    value: {
        experiments: true,
        featureToggles: {
            'app.ui.liveActivities': true,
            'app.ui.homeScreenWidgets': true,
        },
    } as Record<string, unknown>,
}));
const localSettingsState = vi.hoisted(() => ({
    value: {
        activitySurfacesEnabled: true,
        iosLiveActivitiesEnabled: true,
        iosWidgetsEnabled: true,
        liveActivitiesMode: 'attention',
        liveActivitiesMaxConcurrent: 4,
        liveActivitiesStrategy: 'session_specific',
        widgetsPresetMode: 'attention',
        activitySurfaceTapTarget: 'open_session',
    } as Record<string, unknown>,
}));

const focusWidgetUpdateSnapshot = vi.hoisted(() => vi.fn());
const sessionsWidgetUpdateSnapshot = vi.hoisted(() => vi.fn());
const liveActivityUpdate = vi.hoisted(() => vi.fn(async () => {}));
const liveActivityEnd = vi.hoisted(() => vi.fn(async () => {}));
const liveActivityInstances = vi.hoisted(() => [] as Array<{
    serverId: string | null;
    update: typeof liveActivityUpdate;
    end: () => Promise<void>;
}>);
const liveActivityStart = vi.hoisted(() => vi.fn((snapshot: LiveActivitySnapshot, _route?: string) => {
    const instance = {
        serverId: snapshot.serverId,
        update: liveActivityUpdate,
        end: vi.fn(async () => { await liveActivityEnd(); }),
    };
    liveActivityInstances.push(instance);
    return instance;
}));
const liveActivityGetInstances = vi.hoisted(() => vi.fn(() => liveActivityInstances));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return platformState.os;
            },
        },
        AppState: {
            get currentState() {
                return appStateState.currentState;
            },
            addEventListener: (
                eventName: string,
                listener: (state: 'active' | 'inactive' | 'background') => void,
            ) => {
                if (eventName === 'change') appStateState.listeners.add(listener);
                return { remove: () => appStateState.listeners.delete(listener) };
            },
        },
    });
});

vi.mock('expo-constants', () => ({
    default: {
        expoConfig: {
            ios: { bundleIdentifier: 'dev.happier.custom' },
            plugins: [['expo-widgets', { widgets: [] }]],
        },
        installationId: 'device-1',
    },
}));

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

vi.mock('expo-widgets', () => ({ addUserInteractionListener: () => ({ remove: vi.fn() }) }));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: () => ({}),
    requireOptionalNativeModule: () => null,
}));

function seedActivityState(activeServerId = HOME_A): void {
    const sessionListRowsByServerId: Record<string, Record<string, ReturnType<typeof buildSessionListRenderableFromSession>>> = {};
    const ordinarySessionListMembershipByServerId: Record<string, string[]> = {};
    const sessionListIndexByServerId: Record<string, NonNullable<StorageState['sessionListIndexByServerId'][string]>> = {};
    const sessions: Record<string, Session> = {};
    for (const { serverId, session } of sessionRowsState.value) {
        const sessionId = String(session.id);
        (sessionListRowsByServerId[serverId] ??= {})[sessionId] =
            buildSessionListRenderableFromSession(session);
        (ordinarySessionListMembershipByServerId[serverId] ??= []).push(sessionId);
        (sessionListIndexByServerId[serverId] ??= []).push({ type: 'session', sessionId, serverId });
        // Only the active Home's copy is hydrated, exactly like the real store.
        if (serverId === activeServerId) sessions[sessionId] = session;
    }
    storage.setState({
        isDataReady: true,
        settings: settingsParse(settingsState.value),
        localSettings: localSettingsParse(localSettingsState.value),
        sessions,
        sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId,
        sessionMessages: {},
        sessionListIndexByServerId,
        concurrentSessionListCacheByServerId: {},
    });
}

vi.mock('./iosActivityWidgetModules', () => ({
    HappierFocusWidget: { updateSnapshot: focusWidgetUpdateSnapshot },
    HappierSessionsWidget: { updateSnapshot: sessionsWidgetUpdateSnapshot },
    HappierFocusLiveActivity: { start: liveActivityStart, getInstances: liveActivityGetInstances },
}));

function createAttentionSession(serverId: string, sessionId: string, title: string): Session {
    return createSessionFixture({
        id: sessionId,
        serverId,
        active: true,
        updatedAt: 2_000,
        seq: 4,
        pendingVersion: 1,
        pendingPermissionRequestCount: 1,
        pendingRequestObservedAt: 1_900,
        agentStateVersion: 1,
        agentState: {
            controlledByUser: null,
            requests: {
                'permission-1': { tool: 'Bash', kind: 'permission', arguments: {}, createdAt: 1_900 },
            },
        },
        metadata: {
            summary: { text: title, updatedAt: 1 },
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            machineId: 'machine-1',
        },
    } as Partial<Session>);
}

async function persistHomeAccountSettings(
    serverId: string,
    settings: Record<string, unknown>,
    version = 1,
): Promise<void> {
    const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
    saveAccountSettings({ serverId, accountId: `account-${serverId}` }, settingsParse(settings), version);
}

function liveActivityStartAddresses(): string[] {
    return liveActivityStart.mock.calls
        .map((call) => call[0])
        .map((snapshot) => `${snapshot.serverId ?? ''}/${snapshot.sessionId}`)
        .sort();
}

function latestWidgetSnapshot(): ActivitySurfaceSnapshot {
    const calls = focusWidgetUpdateSnapshot.mock.calls;
    return calls[calls.length - 1]?.[0] as ActivitySurfaceSnapshot;
}

function widgetAddresses(): string[] {
    return (latestWidgetSnapshot()?.sessions ?? [])
        .map((session) => `${session.serverId ?? ''}/${session.sessionId}`)
        .sort();
}

/**
 * Live Activity authorization is read asynchronously and re-runs reconciliation,
 * so each observation point drains both passes.
 */
async function flushActivitySurfacesRuntime(): Promise<void> {
    await flushHookEffects();
}

async function renderActivitySurfacesRuntime() {
    const { ActivitySurfacesRuntime } = await import('./ActivitySurfacesRuntime');
    const rendered = await renderScreen(<ActivitySurfacesRuntime />);
    await flushActivitySurfacesRuntime();
    return rendered;
}

describe('ActivitySurfacesRuntime exact-Home Account delivery', () => {
    beforeEach(async () => {
        resetServerFeaturesClientForTests();
        setRuntimeFetch(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/auth/ping') return Response.json({});
            throw new Error(`Unexpected Activity Home request: ${path}`);
        });
        for (const serverId of [HOME_A, HOME_B, HOME_UNRESOLVED]) {
            await upsertServerProfile({ serverUrl: `https://${serverId}`, name: serverId });
        }
        await setActiveServerId(HOME_A);
        // Secure credential storage is the external boundary. Account decoding,
        // exact-Home binding, persistence and delivery admission remain real.
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url) => ({
            token: createAccountTokenForTests(`account-${new URL(url).hostname}`),
        }));
        sessionRowsState.value = [
            { serverId: HOME_A, session: createAttentionSession(HOME_A, SHARED_SESSION_ID, 'Home A work') },
            { serverId: HOME_B, session: createAttentionSession(HOME_B, SHARED_SESSION_ID, 'Home B work') },
        ];
        // Both Homes have attention, so any absence below can only come from policy.
        await persistHomeAccountSettings(HOME_A, {});
        await persistHomeAccountSettings(HOME_B, {});
        seedActivityState();
    });

    afterEach(() => {
        standardCleanup();
        vi.restoreAllMocks();
        focusWidgetUpdateSnapshot.mockClear();
        sessionsWidgetUpdateSnapshot.mockClear();
        liveActivityStart.mockClear();
        liveActivityUpdate.mockClear();
        liveActivityEnd.mockClear();
        liveActivityInstances.length = 0;
        appStateState.listeners.clear();
    });

    it('admits each Home through its own Account policy for each surface', async () => {
        await persistHomeAccountSettings(HOME_A, {
            attentionDeliveryPolicyV1: { v: 1, channels: { live_activity: { enabled: false } } },
        });
        await persistHomeAccountSettings(HOME_B, {
            attentionDeliveryPolicyV1: { v: 1, channels: { home_widget: { enabled: false } } },
        });

        await renderActivitySurfacesRuntime();

        expect(liveActivityStartAddresses()).toEqual([`${HOME_B}/${SHARED_SESSION_ID}`]);
        expect(widgetAddresses()).toEqual([`${HOME_A}/${SHARED_SESSION_ID}`]);
    });

    it('fails closed for a Home with no persisted Account settings', async () => {
        sessionRowsState.value = [
            ...sessionRowsState.value,
            {
                serverId: HOME_UNRESOLVED,
                session: createAttentionSession(HOME_UNRESOLVED, 'session-unresolved', 'Unresolved Home work'),
            },
        ];
        seedActivityState();

        await renderActivitySurfacesRuntime();

        expect(liveActivityStartAddresses()).toEqual([
            `${HOME_A}/${SHARED_SESSION_ID}`,
            `${HOME_B}/${SHARED_SESSION_ID}`,
        ]);
        expect(widgetAddresses()).toEqual([
            `${HOME_A}/${SHARED_SESSION_ID}`,
            `${HOME_B}/${SHARED_SESSION_ID}`,
        ]);
    });

    it('does not retarget another Home when the active Home changes', async () => {
        await persistHomeAccountSettings(HOME_A, {
            attentionDeliveryPolicyV1: { v: 1, channels: { live_activity: { enabled: false } } },
        });

        await renderActivitySurfacesRuntime();
        const beforeSwitch = liveActivityStartAddresses();

        standardCleanup();
        liveActivityStart.mockClear();
        liveActivityEnd.mockClear();
        liveActivityInstances.length = 0;
        focusWidgetUpdateSnapshot.mockClear();
        await setActiveServerId(HOME_B);
        seedActivityState(HOME_B);
        await renderActivitySurfacesRuntime();

        expect(beforeSwitch).toEqual([`${HOME_B}/${SHARED_SESSION_ID}`]);
        expect(liveActivityStartAddresses()).toEqual([`${HOME_B}/${SHARED_SESSION_ID}`]);
        expect(widgetAddresses()).toEqual([`${HOME_B}/${SHARED_SESSION_ID}`]);
    });

    it('reconciles immediately when the other Home rewrites its persisted Account policy', async () => {
        await renderActivitySurfacesRuntime();
        expect(liveActivityStartAddresses()).toEqual([
            `${HOME_A}/${SHARED_SESSION_ID}`,
            `${HOME_B}/${SHARED_SESSION_ID}`,
        ]);
        const homeA = liveActivityInstances.find((instance) => instance.serverId === HOME_A)!;
        const homeB = liveActivityInstances.find((instance) => instance.serverId === HOME_B)!;

        liveActivityStart.mockClear();
        focusWidgetUpdateSnapshot.mockClear();
        await act(async () => {
            await persistHomeAccountSettings(HOME_B, {
                attentionDeliveryPolicyV1: { v: 1, channels: { live_activity: { enabled: false } } },
            }, 2);
        });
        await flushActivitySurfacesRuntime();

        expect(liveActivityStartAddresses()).toEqual([]);
        expect(homeA.end).not.toHaveBeenCalled();
        expect(homeB.end).toHaveBeenCalledTimes(1);
    });

    it('withholds the title for a Home whose Account permits status only', async () => {
        await persistHomeAccountSettings(HOME_A, {
            attentionDeliveryPolicyV1: { v: 1, privacy: { surfaces: { home_widget: 'include_preview' } } },
        });
        await persistHomeAccountSettings(HOME_B, {
            attentionDeliveryPolicyV1: { v: 1, privacy: { surfaces: { home_widget: 'status_only' } } },
        });

        await renderActivitySurfacesRuntime();

        const sessions = latestWidgetSnapshot().sessions;
        const homeA = sessions.find((session) => session.serverId === HOME_A);
        const homeB = sessions.find((session) => session.serverId === HOME_B);
        expect(homeA?.title).toBe('Home A work');
        expect(homeB?.title).not.toBe('Home B work');
        expect(homeB?.title).not.toBe('Home A work');
        expect(homeB?.subtitle).toBeNull();
        expect(homeB?.statusText).toBeNull();
        expect(homeB?.previewText).toBeNull();
    });
});
