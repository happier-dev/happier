import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, createSessionAccessFixture, createSessionFixture, renderScreen } from '@/dev/testkit';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { TokenStorage, type HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { removeServerProfile, setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { handleNewMessageSocketUpdate } from '@/sync/engine/sessions/sessionSocketUpdate';
import { handleEphemeralSocketUpdate, handleUpdateContainer } from '@/sync/engine/socket/socket';
import { ActivityLocalNotificationRuntime } from './ActivityLocalNotificationRuntime';
import { notifyActivityAgentRequest, notifyActivityReady, resetActivityLocalNotificationRuntimeForTests } from './activityLocalNotificationBus';
import { resetActivityAlertPresentationNotesForTests } from '../remoteAlerts/activityAlertPresentationNotes';
import { resolveForegroundNotificationBehavior } from '../resolveForegroundNotificationBehavior';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { stopConcurrentSessionCacheSync } from '@/sync/runtime/orchestration/concurrentSessionCache';

type ExpoNotificationParams = Parameters<typeof import('../channels/sendExpoLocalNotification')['sendExpoLocalNotification']>[0];

const boundary = vi.hoisted(() => ({
    desktop: false,
    nativePlatform: 'ios',
    requests: vi.fn(async (_request: Parameters<typeof import('expo-notifications')['scheduleNotificationAsync']>[0]) => undefined),
    inventory: vi.fn(async (): Promise<Array<{request: {identifier: string; content: {data: Record<string, unknown>}}}>> => []),
    dismiss: vi.fn(async (_identifier: string) => undefined),
    received: new Set<() => void>(),
    active: { serverId: 'srv_home_a', serverUrl: 'https://stack.example.test', generation: 1 },
    expo: vi.fn(async (_params: ExpoNotificationParams) => 'notification-1'),
    tauri: vi.fn(async (_notification: unknown) => undefined),
    plugin: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return boundary.desktop ? 'web' : boundary.nativePlatform; } } });
});
vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
    sendNotification: boundary.plugin,
}));
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
await loadSyncSingletonForTests();
const initialState = storage.getInitialState();
const getSession = () => storage.getState().sessions['session-1'];
const applySessions: Parameters<typeof handleUpdateContainer>[0]['applySessions'] = (sessions) => storage.getState().applySessions(sessions);

async function deliverMessage(seq: number, human: boolean, recovered = false, sourceAccountId = 'other-account'): Promise<void> {
    if (!recovered) {
        await handleEphemeralSocketUpdate({ sourceServerId: 'srv_home_a',
            update: { type: 'session-personal-event', sessionId: 'session-1', eventId: `message-${seq}`,
                event: human ? 'human_message' : 'message', message: { sequenceDomain: 'session_transcript', messageSeq: seq },
                ...(human ? { sourceAccountId } : {}),
            },
            addActivityUpdate: () => undefined, addMachineActivityUpdate: () => undefined,
            getSessionEncryption: () => null, getSession, applyMessages: () => undefined,
        });
        return;
    }
    await handleNewMessageSocketUpdate({
        serverId: 'srv_home_a',
        updateData: { body: { sid: 'session-1', message: {
            id: `message-${seq}`, seq, localId: null, createdAt: seq, updatedAt: seq,
            messageRole: human ? 'user' : 'agent',
            ...(human ? { accountActor: { v: 1, accountId: 'other-account', profile: null } } : {}),
            ...(recovered ? { transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' } } : {}),
            content: { t: 'plain', v: { role: human ? 'user' : 'agent', content: { type: 'text', text: `preview-${seq}` } } },
        } }, seq, createdAt: seq },
        getSession, getSessionEncryption: () => null, applySessions,
        fetchSessions: () => undefined, applyMessages: () => undefined,
        isMutableToolCall: () => false, invalidateScmStatus: () => undefined,
        isSessionMessagesLoaded: () => false, getSessionMaterializedMaxSeq: () => 0,
        markSessionMaterializedMaxSeq: () => undefined, onMessageGapDetected: () => undefined,
    });
}

describe('live Follow socket notifications', () => {
    it('selects a stalled presence original once while current, and withdraws recovered or replaced turns', async () => {
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const stalledOccurrence = { turnId: 'stalled-turn', publisherFence: 123 };
        const setSource = (active: boolean, preset: 'important' | 'quiet' = 'important', latestTurnId = 'stalled-turn') => applySessions([{
            ...getSession(), active, activeAt: 123, latestTurnId, latestTurnStatus: 'in_progress',
            viewer: { ...getSession().viewer!, follow: { follows: true, notificationLevel: 'important', policy: { preset } } },
        }]);
        const deliver = () => handleEphemeralSocketUpdate({ sourceServerId: 'srv_home_a',
            update: { type: 'session-personal-event', sessionId: 'session-1', eventId: 'stalled-original',
                event: 'source_unavailable', stalledOccurrence },
            addActivityUpdate: () => undefined, addMachineActivityUpdate: () => undefined,
            getSessionEncryption: () => null, getSession, applyMessages: () => undefined,
        });
        await act(async () => { setSource(false, 'quiet'); });
        await act(async () => { await deliver(); });
        expect(boundary.expo).not.toHaveBeenCalled();
        await act(async () => { setSource(false); });
        expect(getSession()).toMatchObject({ active: false, activeAt: 123,
            latestTurnId: 'stalled-turn', latestTurnStatus: 'in_progress' });
        await act(async () => { await deliver(); });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
        await act(async () => { setSource(true); });
        await act(async () => { await deliver(); });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
        await act(async () => { setSource(false, 'important', 'replacement-turn'); });
        await act(async () => { await deliver(); });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
    });

    it.each(['goal_changed', 'update_posted'] as const)('keeps a selected quiet %s original quiet and interrupts only after the same current policy selects Interrupt', async kind => {
        const setDelivery = (delivery: 'quiet' | 'interrupt') => applySessions([{ ...getSession(), viewer: {
            ...getSession().viewer!, follow: { follows: true, notificationLevel: 'important',
                policy: { preset: 'custom', events: { [kind]: { delivery } } } },
        } }]);
        setDelivery('quiet');
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const deliver = (seq: number) => handleEphemeralSocketUpdate({ sourceServerId: 'srv_home_a',
            update: { type: 'session-personal-event', sessionId: 'session-1', eventId: `original-${seq}`, event: 'message',
                followEvent: { kind }, message: { sequenceDomain: 'session_transcript', messageSeq: seq } },
            addActivityUpdate: () => undefined, addMachineActivityUpdate: () => undefined,
            getSessionEncryption: () => null, getSession, applyMessages: () => undefined,
        });
        await act(async () => { await deliver(1); });
        expect(boundary.expo).not.toHaveBeenCalled();
        await act(async () => { setDelivery('interrupt'); });
        await act(async () => { await deliver(2); });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
    });

    it('reconciles a muted Home wake without posting a local alert, then delivers an ordinary wake', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');
        const { applySessionChangedBackgroundWakePayload } = await import('../backgroundWake/defineSessionChangedBackgroundWakeTask');
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        let reconciled = 0;
        const reconcile = async () => {
            reconciled++;
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [], undefined, undefined, 'reconciliation');
            return true;
        };
        await act(async () => {
            await applySessionChangedBackgroundWakePayload({
                payload: { type: 'session_changed', serverId: 'srv_home_a', sessionId: 'session-1', alert: 'muted' }, reconcile,
            });
        });
        expect(reconciled).toBe(1);
        expect(boundary.expo).not.toHaveBeenCalled();
        await act(async () => {
            await applySessionChangedBackgroundWakePayload({
                payload: { type: 'session_changed', serverId: 'srv_home_a', sessionId: 'session-1' }, reconcile,
            });
        });
        expect(reconciled).toBe(2);
        expect(boundary.expo).toHaveBeenCalled();
    });
    it('delivers an independent live alert while a muted wake is reconciling the same Session', async () => {
        const { applySessionChangedBackgroundWakePayload } = await import('../backgroundWake/defineSessionChangedBackgroundWakeTask');
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const deferred = createDeferred<boolean>();
        const pending = applySessionChangedBackgroundWakePayload({
            payload: { type: 'session_changed', serverId: 'srv_home_a', sessionId: 'session-1', alert: 'muted' },
            reconcile: async () => {
                notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [], undefined, undefined, 'reconciliation');
                return deferred.promise;
            },
        });
        try {
            expect(boundary.expo).not.toHaveBeenCalled();
            await act(async () => notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, []));
            expect(boundary.expo).toHaveBeenCalledTimes(1);
        } finally {
            deferred.resolve(true);
            await act(async () => { await pending; });
        }
    });
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let savedProfileId: string | undefined;
    const credentialWrites: Array<{ desktop: boolean; write: HomeCredentialWriteRollback }> = [];
    let localStorage: ReturnType<typeof installLocalStorageMock>;
    let webLocks: ReturnType<typeof installWebLockManagerMock>;
    let previousDesktopHost: PropertyDescriptor | undefined;
    let restoredHome: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
    beforeEach(async () => {
        storage.setState(initialState, true);
        storage.setState({ isDataReady: false });
        boundary.nativePlatform = 'ios';
        boundary.requests.mockClear(); boundary.inventory.mockReset().mockResolvedValue([]); boundary.dismiss.mockClear();
        // The setup loader and direct SDK imports share this genuine OS boundary.
        const notifications = await import('@/dev/expoNotificationsStub');
        vi.spyOn(notifications, 'getPresentedNotificationsAsync').mockImplementation(() => boundary.inventory());
        vi.spyOn(notifications, 'dismissNotificationAsync').mockImplementation(identifier => boundary.dismiss(identifier));
        vi.spyOn(notifications, 'addNotificationReceivedListener').mockImplementation(listener => {
            if (typeof listener !== 'function') throw new Error('Expected native receipt listener');
            const received = () => listener();
            boundary.received.add(received);
            return { remove: () => { boundary.received.delete(received); } };
        });
        vi.spyOn(notifications, 'scheduleNotificationAsync').mockImplementation(async raw => {
            // The canonical SDK stub is intentionally untyped; this is the native request boundary.
            const request = raw as Parameters<typeof import('expo-notifications')['scheduleNotificationAsync']>[0];
            await boundary.requests(request);
            const { content } = request;
            if (typeof content.title !== 'string' || typeof content.body !== 'string') throw new Error('Expected local notification copy');
            return boundary.expo({ title: content.title, body: content.body,
                ...(content.data ? { data: content.data } : {}),
                ...(content.categoryIdentifier ? { categoryIdentifier: content.categoryIdentifier } : {}) });
        });
        boundary.desktop = false;
        const desktopStorage = createDesktopSecureStorageBoundary();
        previousDesktopHost = Object.getOwnPropertyDescriptor(globalThis, '__TAURI_INTERNALS__');
        Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
            configurable: true,
            get: () => boundary.desktop ? { invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
                if (command === 'desktop_notification_show') return boundary.tauri(args?.notification);
                if (command === 'desktop_notification_list') return [];
                return desktopStorage.invoke(command, args);
            } } : undefined,
        });
        localStorage = installLocalStorageMock();
        webLocks = installWebLockManagerMock();
        const profile = await upsertServerProfile({ serverUrl: boundary.active.serverUrl, name: 'Home A' });
        savedProfileId = profile.id;
        await setServerProfileIdentityForUrl(profile.serverUrl, 'srv_home_a');
        await setActiveServerId('srv_home_a');
        for (const desktop of [false, true]) {
            boundary.desktop = desktop;
            const write = await TokenStorage.setCredentialsForServerUrlWithRollback(
                profile.serverUrl, { serverId: 'srv_home_a' }, { token: createAccountTokenForTests('account-a') },
            );
            if (!write) throw new Error('Could not store the Follow notification Account credential');
            credentialWrites.push({ desktop, write });
        }
        boundary.desktop = false;
        restoredHome = await restoreServerAccountForTest({ serverUrl: boundary.active.serverUrl,
            serverIdentityId: 'srv_home_a', accountId: 'account-a' });
        storage.getState().activateProfileScope({ serverId: 'srv_home_a', accountId: 'account-a' });
        setRuntimeFetch(async url => new URL(String(url)).pathname === '/v2/account/session-delivery-mutes'
            ? Response.json({ scopes: [] }) : Response.json({}));
        storage.setState({ settings: settingsParse({}), localSettings: localSettingsParse({}) });
        saveAccountSettings({ serverId: 'srv_home_a', accountId: 'account-a' }, settingsParse({}), 1);
        applySessions([createSessionFixture({ id: 'session-1', serverId: 'srv_home_a', seq: 0, active: true, viewer: {
            latestFailureSeq: null,
            readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
            follow: { follows: false, notificationLevel: null },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            notification: { level: 'important', source: 'owner' },
        } })]);
    });
    afterEach(async () => {
        await act(async () => { screen?.tree.unmount(); });
        screen = undefined;
        await stopConcurrentSessionCacheSync();
        await restoredHome?.dispose(); restoredHome = null;
        for (const { desktop, write } of credentialWrites.splice(0).reverse()) {
            boundary.desktop = desktop;
            await write.rollback();
        }
        boundary.desktop = false;
        boundary.expo.mockClear(); boundary.tauri.mockClear(); boundary.plugin.mockClear();
        vi.restoreAllMocks();
        resetActivityLocalNotificationRuntimeForTests();
        resetActivityAlertPresentationNotesForTests();
        storage.setState(initialState, true);
        if (savedProfileId) await removeServerProfile(savedProfileId);
        savedProfileId = undefined;
        webLocks.restore();
        localStorage.restore();
        if (previousDesktopHost) Object.defineProperty(globalThis, '__TAURI_INTERNALS__', previousDesktopHost);
        else Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__');
    });

    it('schedules ordinary requests on their Android channel with the exact audience Account', async () => {
        boundary.nativePlatform = 'android';
        const settings = settingsParse({ attentionDeliveryPolicyV1: { v: 1, sounds: { defaultSoundId: 'default' } } });
        storage.setState({ settings });
        saveAccountSettings({ serverId: 'srv_home_a', accountId: 'account-a' }, settings, 2);
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        for (const requestKind of ['permission', 'user_action'] as const) {
            await act(async () => { notifyActivityAgentRequest({
                address: { serverId: 'srv_home_a', sessionId: 'session-1' }, requestId: requestKind,
                turnId: `turn-${requestKind}`, requestKind, toolName: 'Bash', toolArgs: { command: 'pwd' },
            }); });
        }
        await vi.waitFor(() => expect(boundary.requests).toHaveBeenCalledTimes(2));
        const { PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS } = await import('@happier-dev/protocol/push/pushNotificationActions');
        expect(boundary.requests.mock.calls.map(([request]) => ({ data: request.content.data, trigger: request.trigger }))).toEqual([
            expect.objectContaining({ data: expect.objectContaining({ accountId: 'account-a', kind: 'permission',
                requestId: 'permission', turnId: 'turn-permission' }), trigger: { channelId: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1 } }),
            expect.objectContaining({ data: expect.objectContaining({ accountId: 'account-a', kind: 'user_action',
                requestId: 'user_action', turnId: 'turn-user_action' }), trigger: { channelId: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsV1 } }),
        ]);
    });

    it('withdraws only positively completed ordinary turns, independently of local delivery policy', async () => {
        const notice = (identifier: string, data: Record<string, unknown> = {}) => ({ request: { identifier, content: { data: {
            kind: 'permission', serverId: 'srv_home_a', serverUrl: boundary.active.serverUrl,
            accountId: 'account-a', sessionId: 'session-1', requestId: 'request-1', turnId: 'turn-a', ...data,
        } } } });
        boundary.inventory.mockResolvedValue([
            notice('settled-permission'), notice('settled-question', {kind: 'user_action', requestId: 'question-1'}),
            notice('newer-turn', {turnId: 'turn-b'}), notice('other-account', {accountId: 'other-account'}),
            notice('other-home', {serverId: 'unknown-home', serverUrl: 'https://other.example.test'}),
            notice('unloaded', {sessionId: 'missing-session'}), notice('legacy', {turnId: undefined}),
            notice('unknown-account', {accountId: undefined}), notice('missing-request', {requestId: 'missing-request'}),
        ]);
        const settings = settingsParse({ attentionDeliveryPolicyV1: { v: 1, channels: { local_notification: { enabled: false } } } });
        storage.setState({ settings });
        saveAccountSettings({ serverId: 'srv_home_a', accountId: 'account-a' }, settings, 2);
        applySessions([{ ...getSession(), agentState: { requests: {
            'request-1': { tool: 'Bash', arguments: {}, createdAt: 1, turnId: 'turn-a' },
            'question-1': { tool: 'AskUserQuestion', arguments: {}, createdAt: 1, turnId: 'turn-a' },
        } } }]);
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await vi.waitFor(() => expect(boundary.inventory).toHaveBeenCalled());
        expect(boundary.dismiss).not.toHaveBeenCalled();
        await act(async () => { applySessions([{ ...getSession(), agentStateVersion: 2, agentState: {
            requests: { 'request-1': { tool: 'Bash', arguments: {}, createdAt: 2, turnId: 'turn-b' } },
            completedRequests: {
                'request-1': { tool: 'Bash', arguments: {}, createdAt: 1, completedAt: 2, status: 'denied', turnId: 'turn-a' },
                'question-1': { tool: 'AskUserQuestion', arguments: {}, createdAt: 1, completedAt: 2, status: 'approved', turnId: 'turn-a' },
            },
        } }]); });
        await vi.waitFor(() => expect(boundary.dismiss.mock.calls.map(([id]) => id).sort()).toEqual(['settled-permission', 'settled-question']));
        expect(boundary.expo).not.toHaveBeenCalled();
        boundary.inventory.mockResolvedValue([]);
        await act(async () => { for (const listener of boundary.received) listener(); });
        await new Promise(resolve => setTimeout(resolve, 0));
        const reads = boundary.inventory.mock.calls.length;
        await act(async () => { storage.setState({ sessions: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
            const session = createSessionFixture({ id: `unrelated-${index}`, serverId: 'srv_home_a', agentState: {} });
            return [session.id, session];
        })) }); });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(boundary.inventory).toHaveBeenCalledTimes(reads);
    });

    it('keeps a delivered request when the Account changes while native inventory is loading', async () => {
        const inventory = createDeferred<Awaited<ReturnType<typeof boundary.inventory>>>();
        boundary.inventory.mockReturnValue(inventory.promise);
        applySessions([{ ...getSession(), agentState: { completedRequests: {
            'request-1': { tool: 'Bash', arguments: {}, createdAt: 1, completedAt: 2, status: 'denied', turnId: 'turn-a' },
        } } }]);
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await vi.waitFor(() => expect(boundary.inventory).toHaveBeenCalled());
        await act(async () => { storage.getState().activateProfileScope({ serverId: 'srv_home_a', accountId: 'account-b' }); });
        await act(async () => { inventory.resolve([{ request: { identifier: 'old-account-notice', content: { data: {
            kind: 'permission', serverId: 'srv_home_a', serverUrl: boundary.active.serverUrl, accountId: 'account-a',
            sessionId: 'session-1', requestId: 'request-1', turnId: 'turn-a',
        } } } }]); });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(boundary.dismiss).not.toHaveBeenCalled();
    });

    it.each([false, true])('delivers live Follow messages on desktop=%s without remote enrollment or history replay', async (desktop) => {
        boundary.desktop = desktop;
        applySessions([{ ...getSession(), viewer: {
            latestFailureSeq: null,
            readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['followed_by_me'] },
            follow: { follows: true, notificationLevel: 'important', policy: { preset: 'important' } },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            notification: { level: 'important', source: 'preference' },
        } }]);
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const submit = desktop ? boundary.tauri : boundary.expo;
        await act(async () => { await deliverMessage(1, true); });
        await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
        if (desktop) {
            expect(boundary.tauri).toHaveBeenCalledWith(expect.objectContaining({
                accountId: 'account-a', actions: [],
                data: expect.objectContaining({ serverId: 'srv_home_a', sessionId: 'session-1', accountId: 'account-a' }),
            }));
            expect(boundary.plugin).not.toHaveBeenCalled();
        }
        await act(async () => { await deliverMessage(2, false); });
        expect(submit).toHaveBeenCalledTimes(1);
        await act(async () => { applySessions([{ ...getSession(), viewer: { ...getSession().viewer!, follow: { follows: true, notificationLevel: 'all_messages', policy: { preset: 'everything' } } } }]); });
        await act(async () => { await deliverMessage(3, false); });
        await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
        await act(async () => { await handleEphemeralSocketUpdate({ sourceServerId: 'srv_home_a',
            update: { type: 'session-personal-event', sessionId: 'session-1', eventId: 'discussion-message-3', event: 'message',
                message: { sequenceDomain: 'discussion', discussionId: 'discussion-1', messageSeq: 3 } },
            addActivityUpdate: () => undefined, addMachineActivityUpdate: () => undefined,
            getSessionEncryption: () => null, getSession, applyMessages: () => undefined,
        }); });
        await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
        await act(async () => { await deliverMessage(6, true, false, 'account-a'); });
        expect(submit).toHaveBeenCalledTimes(3);
        await act(async () => { await deliverMessage(4, true, true); });
        expect(submit).toHaveBeenCalledTimes(3);
        await act(async () => { applySessions([{ ...getSession(), viewer: { ...getSession().viewer!, follow: { follows: true, notificationLevel: 'none' } } }]); });
        await act(async () => { await deliverMessage(5, true); });
        expect(submit).toHaveBeenCalledTimes(3);
    });

    it('delivers live source-unavailable only for personally tracked sessions', async () => {
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const deliver = () => handleEphemeralSocketUpdate({ sourceServerId: 'srv_home_a',
            update: { type: 'session-personal-event', sessionId: 'session-1', eventId: 'source-occurrence-1', event: 'source_unavailable' },
            addActivityUpdate: () => undefined, addMachineActivityUpdate: () => undefined,
            getSessionEncryption: () => null, getSession, applyMessages: () => undefined,
        });
        await act(async () => { await deliver(); });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
        await act(async () => { applySessions([{ ...getSession(), access: createSessionAccessFixture('view'), viewer: {
            latestFailureSeq: null,
            readState: { state: 'not_started' }, relevance: { relevant: false, reasons: [] },
            follow: { follows: false, notificationLevel: null },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            notification: { level: 'none', source: 'none' },
        } }]); });
        await act(async () => { await deliver(); });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
    });

    it('delivers committed failed and cancelled occurrences through the live socket', async () => {
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        const transition = (event: 'failed' | 'cancelled', turnId: string) => handleEphemeralSocketUpdate({
            sourceServerId: 'srv_home_a', update: { type: 'session-personal-event', sessionId: 'session-1', eventId: `mutation-${turnId}`, event, turnId },
            addActivityUpdate: () => undefined, addMachineActivityUpdate: () => undefined,
            getSessionEncryption: () => null, getSession, applyMessages: () => undefined,
        });
        await act(async () => { await transition('failed', 'turn-1'); });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
        await act(async () => { await transition('cancelled', 'turn-2'); });
        expect(boundary.expo).toHaveBeenCalledTimes(2);
    });

    it('does not let native scheduling overwrite the foreground presentation owner', async () => {
        const settings = settingsParse({ attentionDeliveryPolicyV1: { v: 1, foregroundBehavior: 'full' } });
        storage.setState({ settings });
        saveAccountSettings({ serverId: 'srv_home_a', accountId: 'account-a' }, settings, 2);
        const accepted = createDeferred<string>();
        boundary.expo.mockImplementationOnce(() => accepted.promise);
        screen = await renderScreen(<ActivityLocalNotificationRuntime />);
        await act(async () => {
            notifyActivityReady({ serverId: 'srv_home_a', sessionId: 'session-1' }, [],
                { sequenceDomain: 'session_transcript', sequence: 21 }, 'ready-21');
        });
        expect(boundary.expo).toHaveBeenCalledTimes(1);
        const foreground = (content: Parameters<typeof resolveForegroundNotificationBehavior>[0]['content']) =>
            resolveForegroundNotificationBehavior({ content, localSettings: storage.getState().localSettings,
                now: new Date('2026-09-26T12:00:00Z'), isSessionVisible: () => false });

        // The rich push presents while local OS scheduling is still pending.
        await expect(foreground({ data: { sessionId: 'session-1', serverUrl: boundary.active.serverUrl,
            activityEventLocalId: 'ready-21' } })).resolves.toBe('full');
        await act(async () => { accepted.resolve('notification-accepted'); await accepted.promise; });
        // Scheduling acceptance is not a presentation and cannot overwrite the
        // rich note before the actual local foreground callback makes its decision.
        await expect(foreground(boundary.expo.mock.calls[0]![0])).resolves.toBe('off');
    });
});
