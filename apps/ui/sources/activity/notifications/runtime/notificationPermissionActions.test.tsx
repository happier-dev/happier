import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { AppState, Platform } from 'react-native';
import { AccountProfileSchema, PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { createOkFetchResponse, createReactNativeAppStateEmitter, createServerFetchWithReachabilityProbe, getServerFetchUrl, renderHook, flushHookEffects } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { parseNotificationTap } from '../notificationRouting';
import { executeNotificationPermissionAction, handleNotificationBackgroundTask } from './notificationPermissionActions';
import { resolveNotificationPermissionTarget } from './resolveNotificationPermissionTarget';
import { consumeNotificationPermissionRecoveryNeeded, consumeNotificationPermissionRecoveryNotice, markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';
import { initializeNotificationBackgroundTask, resetNotificationBackgroundTaskStateForTests } from './notificationBackgroundTaskState';
import { useNotificationResponseRouting } from './useNotificationResponseRouting';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedSessionDataKeyCacheForTests, resolveScopedSessionCryptoContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { isServerReachabilityNetworkAllowed, resetServerReachabilitySupervisors, setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

const boundary = vi.hoisted(() => ({
    secrets: new Map<string, string>(),
    rpc: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    push: vi.fn(),
    navigate: vi.fn(),
    disconnect: vi.fn(),
    alert: vi.fn<typeof import('react-native')['Alert']['alert']>(),
    connectsImmediately: true,
    connect: vi.fn(),
    completeConnection: null as null | (() => void),
    listener: null as null | ((response: unknown) => void),
    lastResponse: null as unknown,
    nativeListeners: new Map<string, (event: unknown) => void>(),
    nativePending: vi.fn<() => Promise<unknown[]>>(),
    nativeClaim: vi.fn<(deliveryId: string) => Promise<boolean>>(),
    nativeComplete: vi.fn<(deliveryId: string) => Promise<boolean>>(),
}));

// Native secure storage, React Native, Expo responses, and socket.io are the
// system boundaries. Profile/auth/parser/coordinator/scoped RPC logic stays real.
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => boundary.secrets.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { boundary.secrets.set(key, value); },
    deleteItemAsync: async (key: string) => { boundary.secrets.delete(key); },
}));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' }, {
        AppState: { currentState: 'active' },
        Alert: { alert: boundary.alert },
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: boundary.push, navigate: boundary.navigate } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-notifications', () => ({
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    getLastNotificationResponseAsync: async () => boundary.lastResponse,
    clearLastNotificationResponseAsync: async () => { boundary.lastResponse = null; },
    addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
        boundary.listener = listener;
        return { remove: () => { boundary.listener = null; } };
    },
}));
vi.mock('expo-modules-core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('expo-modules-core')>();
    return {
        ...actual,
        requireOptionalNativeModule: (name: string) => name === 'ExpoNotificationsEmitter' ? {
            getPendingBackgroundNotificationResponses: boundary.nativePending,
            claimBackgroundNotificationResponse: boundary.nativeClaim,
            completeBackgroundNotificationResponse: boundary.nativeComplete,
            addListener: (event: string, listener: (body: unknown) => void) => {
                boundary.nativeListeners.set(event, listener);
                return { remove: () => { boundary.nativeListeners.delete(event); } };
            },
        } : actual.requireOptionalNativeModule(name),
    };
});
vi.mock('socket.io-client', () => ({
    io: () => {
        const listeners = new Map<string, Set<() => void>>();
        boundary.completeConnection = () => { for (const listener of listeners.get('connect') ?? []) listener(); };
        return {
            connected: boundary.connectsImmediately,
            on: (event: string, listener: () => void) => {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event)?.add(listener);
            },
            off: (event: string, listener: () => void) => { listeners.get(event)?.delete(listener); },
            connect: boundary.connect, disconnect: boundary.disconnect, emit: () => {},
            emitWithAck: (...args: unknown[]) => boundary.rpc(...args),
            timeout: () => ({ emitWithAck: (...args: unknown[]) => boundary.rpc(...args) }),
        };
    },
}));

const serverUrl = 'https://notifications.example.test';
let responseSequence = 0;
function token(account = 'account') { return `e30.${btoa(JSON.stringify({ sub: account }))}.signature`; }
function response(actionIdentifier = PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1 as string, identifier: string | null = `n${responseSequence}`) {
    return { actionIdentifier, notification: { request: { identifier, content: { data: { serverUrl, sessionId: 'session', requestId: 'request', occurrenceId: `occurrence-${responseSequence}` } } } } };
}
function parsed(value = response()) {
    const tap = parseNotificationTap({ response: value, defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
    if (!tap) throw new Error('Fixture did not parse');
    return tap;
}

function expectSessionNavigationToServer(serverId: string, callIndex = 0) {
    const navigation = new URL(String(boundary.navigate.mock.calls[callIndex]?.[0]), 'https://ui.example.test');
    expect(navigation.pathname).toBe('/session/session');
    expect(profiles.areServerProfileIdentifiersEquivalent(navigation.searchParams.get('serverId') ?? '', serverId)).toBe(true);
}

describe('Native notification permission entry points', () => {
    beforeEach(async () => {
        responseSequence += 1;
        Platform.OS = 'android';
        // Exercise production secure storage, not the development entitlement fallback.
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK', 'false');
        setServerReachabilityNetworkAllowed(true);
        boundary.secrets.clear();
        boundary.rpc.mockReset().mockResolvedValue({ ok: true, result: { ok: true } });
        boundary.push.mockClear();
        boundary.navigate.mockClear();
        boundary.disconnect.mockClear();
        boundary.alert.mockClear();
        boundary.connectsImmediately = true;
        boundary.connect.mockClear();
        boundary.completeConnection = null;
        boundary.lastResponse = null;
        boundary.nativeListeners.clear();
        boundary.nativePending.mockReset().mockResolvedValue([]);
        boundary.nativeClaim.mockReset().mockResolvedValue(true);
        boundary.nativeComplete.mockReset().mockResolvedValue(true);
        consumeNotificationPermissionRecoveryNeeded();
        resetNotificationBackgroundTaskStateForTests();
        resetScopedSessionDataKeyCacheForTests();
        const profile = profiles.upsertServerProfile({ serverUrl, name: 'Test' });
        profiles.setServerProfileIdentityForUrl(serverUrl, 'srv_notification_identity');
        profiles.setActiveServerId(profile.id, { scope: 'device' });
        expect(await TokenStorage.setCredentials({ token: token() })).toBe(true);
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId: 'srv_notification_identity', accountId: 'account' } });
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => {
            const { pathname } = getServerFetchUrl(input);
            if (pathname === '/v2/sessions/session') {
                return createOkFetchResponse({
                    session: { id: 'session', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                        metadata: '{}', metadataVersion: 0, agentState: null, agentStateVersion: 0,
                        pendingCount: 0, pendingVersion: 0, encryptionMode: 'plain', dataEncryptionKey: null },
                });
            }
            // Canonical session navigation can switch Home and refresh these endpoints.
            if (pathname === '/v1/account/profile') return createOkFetchResponse(AccountProfileSchema.parse({ id: 'account' }));
            if (pathname === '/v1/artifacts') return createOkFetchResponse([]);
            return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        })));
    });
    afterEach(async () => {
        setServerReachabilityNetworkAllowed(true);
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        await resetServerReachabilitySupervisors();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('executes a foreground press even with task registration and coalesces the task race', async () => {
        await initializeNotificationBackgroundTask('android', () => ({ registerNotificationBackgroundTask: async () => true }));
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        await act(async () => {
            boundary.listener?.(response());
            await handleNotificationBackgroundTask({ data: response() });
        });
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.push).not.toHaveBeenCalled();
        expect(profiles.getActiveServerUrl()).toBe(serverUrl);
        await hook.unmount();
    });

    it('keeps a confirmed background response from becoming a false review notice on later listener delivery', async () => {
        const { consumeNotificationPermissionRecoveryNeeded } = await import('./notificationPermissionRecovery');
        consumeNotificationPermissionRecoveryNeeded();
        const nativeResponse = response();
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            expect(boundary.listener).toEqual(expect.any(Function));
            await expect(handleNotificationBackgroundTask({ data: nativeResponse })).resolves.toMatchObject({ status: 'confirmed' });
            // The actual CLI no longer has a pending waiter after accepting this occurrence.
            boundary.rpc.mockResolvedValue({ ok: true, result: { ok: false, errorCode: 'permission_request_not_found' } });
            await act(async () => { boundary.listener?.(nativeResponse); });
            await flushHookEffects();
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            expect(boundary.alert).not.toHaveBeenCalled();
            expect(consumeNotificationPermissionRecoveryNeeded()).toBe(false);
            expect(boundary.push).not.toHaveBeenCalled();
            expect(boundary.navigate).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('keeps a cold iOS native completion pending until the scoped permission RPC acknowledges it', async () => {
        Platform.OS = 'ios';
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        const delivery = { deliveryId: `native-${responseSequence}`, response: response() };
        boundary.nativePending.mockResolvedValue([delivery]);
        let acknowledge!: (result: unknown) => void;
        boundary.rpc.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
        const adapter = await import('./notificationBackgroundTask.ios');

        await expect(adapter.registerNotificationBackgroundTask()).resolves.toBe(true);
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
        expect(boundary.nativeComplete).not.toHaveBeenCalled();
        boundary.nativeListeners.get('onDidReceiveBackgroundNotificationResponse')?.(delivery);
        acknowledge({ ok: true, result: { ok: true } });
        await vi.waitFor(() => expect(boundary.nativeComplete).toHaveBeenCalledWith(delivery.deliveryId));
        expect(boundary.nativeComplete).toHaveBeenCalledTimes(1);
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.rpc.mock.calls[0]?.[1]).toMatchObject({
            method: 'session:session.permission.respondToOccurrence.v1',
            params: expect.objectContaining({ occurrenceId: delivery.response.notification.request.content.data.occurrenceId }),
        });
        expect(boundary.push).not.toHaveBeenCalled();
        expect(boundary.navigate).not.toHaveBeenCalled();
        expect(profiles.getActiveServerUrl()).toBe(other.serverUrl);
        expect(consumeNotificationPermissionRecoveryNeeded()).toBe(false);
    });

    it.each([
        ['HAPPIER_QUESTION_CHOICE_1_V1', { kind: 'choices', questionKey: 'Which?', values: ['main-value', 'develop-value'] }, undefined, 'main-value'],
        ['HAPPIER_QUESTION_TEXT_V1', { kind: 'text', questionKey: 'Which?', allowEmpty: false }, 'my branch', 'my branch'],
    ] as const)('answers a live simple question with the canonical structured operation: %s', async (actionIdentifier, descriptor, userText, answer) => {
        const nativeResponse = { ...response(actionIdentifier), ...(userText === undefined ? {} : { userText }),
            notification: { request: { identifier: 'question', content: { data: { serverUrl, accountId: 'account', sessionId: 'session',
                requestId: 'question-request', occurrenceId: `question-occurrence-${responseSequence}`, questionAnswerV1: descriptor } } } } };
        await expect(handleNotificationBackgroundTask({ data: nativeResponse })).resolves.toMatchObject({ status: 'confirmed' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.rpc.mock.calls[0]?.[1]).toMatchObject({ method: 'session:session.structuredQuestion.respond.v1',
            params: { id: 'question-request', occurrenceId: `question-occurrence-${responseSequence}`, structuredAnswersV1: { 'Which?': [answer] } } });
        const tap = parseNotificationTap({ response: nativeResponse, defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
        if (!tap) throw new Error('Question response must parse');
        await expect(executeNotificationPermissionAction(tap, { allowExecution: false })).resolves.toMatchObject({ status: 'not_sent' });
        await expect(executeNotificationPermissionAction(tap)).resolves.toMatchObject({ status: 'confirmed' });
        const changedResponse = { ...nativeResponse,
            actionIdentifier: userText === undefined ? PUSH_NOTIFICATION_ACTION_IDS.questionChoice2V1 : actionIdentifier,
            ...(userText === undefined ? {} : { userText: 'another answer' }) };
        const changed = parseNotificationTap({ response: changedResponse, defaultActionIdentifier: 'expo.modules.notifications.actions.DEFAULT' });
        if (!changed) throw new Error('Changed question response must parse');
        await expect(executeNotificationPermissionAction(changed)).resolves.toMatchObject({ status: 'conflict' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.push).not.toHaveBeenCalled();
        expect(boundary.navigate).not.toHaveBeenCalled();
    });

    it('keeps an incomplete background question response reviewable without sending', async () => {
        const current = response(PUSH_NOTIFICATION_ACTION_IDS.questionTextV1);
        const nativeResponse = { ...current, userText: 'answer', notification: { request: { ...current.notification.request,
            content: { data: { ...current.notification.request.content.data,
                questionAnswerV1: { kind: 'text', questionKey: 'Which?', allowEmpty: false } } } } } };
        await expect(handleNotificationBackgroundTask({ data: nativeResponse })).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(consumeNotificationPermissionRecoveryNeeded()).toBe(true);
        expect(parseNotificationTap({ response: nativeResponse, defaultActionIdentifier: 'default' })).toMatchObject({ isOpenAction: true, questionAction: null });
    });

    it('requires an explicit question acknowledgement from the occurrence-aware receiver', async () => {
        boundary.rpc.mockResolvedValue({ ok: true, result: undefined });
        const current = response(PUSH_NOTIFICATION_ACTION_IDS.questionTextV1);
        const nativeResponse = { ...current, userText: 'answer', notification: { request: { ...current.notification.request,
            content: { data: { ...current.notification.request.content.data, accountId: 'account',
                questionAnswerV1: { kind: 'text', questionKey: 'Which?', allowEmpty: false } } } } } };
        await expect(handleNotificationBackgroundTask({ data: nativeResponse })).resolves.toMatchObject({ status: 'unconfirmed' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(consumeNotificationPermissionRecoveryNeeded()).toBe(true);
    });

    it('uses the current application result for a later permission occurrence', async () => {
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'confirmed' });
        responseSequence += 1;
        boundary.rpc.mockResolvedValue({ ok: true, result: { ok: false, errorCode: 'permission_request_not_found' } });
        await expect(handleNotificationBackgroundTask({ data: response(undefined, 'another') })).resolves.toMatchObject({ status: 'rejected' });
        await expect(handleNotificationBackgroundTask({ data: response(undefined, null) })).resolves.toMatchObject({ status: 'rejected' });
        await expect(executeNotificationPermissionAction(parsed(response(PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1)))).resolves.toMatchObject({ status: 'rejected' });
        expect(boundary.rpc).toHaveBeenCalledTimes(4);
    });

    it('executes a background press while normal app networking is paused', async () => {
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        // Sync closes this real gate when a running native app enters background.
        // A headless action must not need to resume all foreground networking.
        setServerReachabilityNetworkAllowed(false);
        vi.useFakeTimers();
        try {
            const foreground = resolveScopedSessionCryptoContext({
                serverId: 'srv_notification_identity', serverUrl, token: token(), sessionId: 'session',
                decryptEncryptionKey: async () => null,
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(fetch).not.toHaveBeenCalled();
            const pending = handleNotificationBackgroundTask({ data: response() });
            await vi.advanceTimersByTimeAsync(30_000);
            await expect(pending).resolves.toMatchObject({ status: 'confirmed' });
            await expect(foreground).resolves.toMatchObject({ encryptionMode: 'unknown' });
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            expect(boundary.disconnect).toHaveBeenCalledTimes(1);
            expect(boundary.push).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('resolves canonical active and inactive saved server scopes without changing the selected server', async () => {
        expect(await resolveNotificationPermissionTarget(serverUrl.toUpperCase() + '/')).toEqual({ serverId: 'srv_notification_identity', accountId: 'account' });
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'confirmed' });
        expect(profiles.getActiveServerUrl()).toBe(other.serverUrl);
    });

    it('applies denial thinking recovery for the active scope but never for another scope', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const initialState = storage.getState();
        try {
            const session = {
                id: 'session', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
                thinking: true, thinkingAt: 1, presence: 'online' as const,
            };
            storage.getState().applySessions([session]);
            storage.getState().markSessionOptimisticThinking('session');
            await expect(executeNotificationPermissionAction(parsed(response(PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1))))
                .resolves.toMatchObject({ status: 'confirmed' });
            expect(storage.getState().sessions['session']?.thinking).toBe(false);

            // Same decision against a now-inactive server scope: the authenticated
            // send still works, but it must not touch the active scope's UI state.
            storage.getState().applySessions([{ ...session, thinking: true }]);
            const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
            profiles.setActiveServerId(other.id, { scope: 'device' });
            await TokenStorage.setCredentials({ token: token('other-account') });
            const foreign = parsed(response(PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1, 'n2'));
            await expect(executeNotificationPermissionAction({ ...foreign, permissionAction: { ...foreign.permissionAction!, requestId: 'foreign-request' } }))
                .resolves.toMatchObject({ status: 'confirmed' });
            expect(storage.getState().sessions['session']?.thinking).toBe(true);
            expect(profiles.getActiveServerUrl()).toBe(other.serverUrl);
        } finally {
            storage.setState(initialState, true);
        }
    });

    it('does not issue without credentials, rejects mismatched account hints, then allows a fresh press to retry', async () => {
        await TokenStorage.removeCredentials();
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
        await TokenStorage.setCredentials({ token: token('replacement') });
        await expect(executeNotificationPermissionAction({ ...parsed(), accountId: 'account' })).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'confirmed' });
    });

    it('fails closed for absent scope and invalid authentication', async () => {
        expect(await resolveNotificationPermissionTarget('not a URL')).toBeNull();
        expect(await resolveNotificationPermissionTarget('https://unsaved.example.test')).toBeNull();
        await TokenStorage.setCredentials({ token: token('   ') });
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('does not send older notifications lacking occurrence identity', async () => {
        const old = response();
        const { occurrenceId: _occurrenceId, ...data } = old.notification.request.content.data;
        const legacy = { ...old, notification: { request: { ...old.notification.request, content: { data } } } };
        await expect(handleNotificationBackgroundTask({ data: legacy })).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('does not downgrade an unsupported occurrence response to the legacy method', async () => {
        boundary.rpc.mockResolvedValue({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE', error: 'Unsupported receiver' });
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'unconfirmed' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.rpc.mock.calls[0]?.[1]).toMatchObject({ method: 'session:session.permission.respondToOccurrence.v1' });
    });

    it('does not emit if the authenticated session endpoint denies access', async () => {
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => new Response('{}', { status: 404 }))));
        await expect(executeNotificationPermissionAction(parsed())).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('keeps network acknowledgement failure unconfirmed and does not replay it', async () => {
        const target = await resolveNotificationPermissionTarget(serverUrl);
        boundary.rpc.mockRejectedValue(new Error('ACK disconnected'));
        await expect(handleNotificationBackgroundTask({ data: response() })).resolves.toMatchObject({ status: 'unconfirmed' });
        expect(consumeNotificationPermissionRecoveryNotice()).toEqual({ target });
        await expect(executeNotificationPermissionAction(parsed(), { allowExecution: false })).resolves.toMatchObject({ status: 'not_sent' });
        expect(consumeNotificationPermissionRecoveryNeeded()).toBe(false);
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.disconnect).toHaveBeenCalledTimes(1);
    });

    it('never emits when a scoped session lookup completes after the issuance deadline', async () => {
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        const sessionResponse = await fetch(`${serverUrl}/v2/sessions/session`);
        let release!: () => void;
        const stalled = new Promise<Response>((resolve) => { release = () => resolve(sessionResponse); });
        vi.stubGlobal('fetch', vi.fn(() => stalled));
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed());
            await vi.advanceTimersByTimeAsync(30_000);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.rpc).not.toHaveBeenCalled();
            // Cancellation is already known, so no late socket is opened.
            expect(boundary.disconnect).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('admits a cold execution module after the SDK load budget but within the action lifetime', async () => {
        let release!: () => void;
        const loading = new Promise<void>((resolve) => { release = resolve; });
        const importExecution = async () => {
            await loading;
            return await import('./notificationPermissionActionExecution');
        };
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed(), { importExecution });
            await vi.advanceTimersByTimeAsync(11_436);
            expect(boundary.rpc).not.toHaveBeenCalled();
            release();
            await vi.advanceTimersByTimeAsync(0);
            await expect(pending).resolves.toMatchObject({ status: 'confirmed' });
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });

    it('includes a never-loaded execution module in the single action deadline', async () => {
        vi.useFakeTimers();
        try {
            const pending = handleNotificationBackgroundTask({ data: response() }, {
                importExecution: () => new Promise(() => {}),
            });
            await vi.advanceTimersByTimeAsync(30_000);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('does not restart the action deadline after cold module loading and leaves an issued decision unconfirmed', async () => {
        const execution = await import('./notificationPermissionActionExecution');
        let release!: () => void;
        const loading = new Promise<void>((resolve) => { release = resolve; });
        boundary.rpc.mockImplementation(() => new Promise(() => {}));
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed(), {
                importExecution: async () => { await loading; return execution; },
            });
            await vi.advanceTimersByTimeAsync(29_000);
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1_000);
            await expect(pending).resolves.toMatchObject({ status: 'unconfirmed' });
            expect(boundary.disconnect).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });

    it('settles native cancellation during module loading and never issues after a late load', async () => {
        let release!: () => void;
        const loading = new Promise<void>((resolve) => { release = resolve; });
        const lifetime = new AbortController();
        const pending = handleNotificationBackgroundTask({ data: response() }, {
            signal: lifetime.signal,
            importExecution: async () => {
                await loading;
                return await import('./notificationPermissionActionExecution');
            },
        });
        lifetime.abort();
        await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
        release();
        await vi.dynamicImportSettled();
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('does not issue when the native action expires during preparation', async () => {
        const target = await import('./resolveNotificationPermissionTarget');
        let release!: () => void;
        const stalled = new Promise<typeof target>((resolve) => { release = () => resolve(target); });
        const lifetime = new AbortController();
        const pending = executeNotificationPermissionAction(parsed(), {
            signal: lifetime.signal,
            importTarget: () => stalled,
        });
        lifetime.abort();
        release();
        await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(boundary.disconnect).not.toHaveBeenCalled();
    });

    it('leaves an issued action unconfirmed and disconnects when its native lifetime expires', async () => {
        boundary.rpc.mockImplementation(() => new Promise(() => {}));
        const lifetime = new AbortController();
        const pending = executeNotificationPermissionAction(parsed(), { signal: lifetime.signal });
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
        lifetime.abort();
        await expect(pending).resolves.toMatchObject({ status: 'unconfirmed' });
        expect(boundary.disconnect).toHaveBeenCalledTimes(1);
    });

    it.each(['never', 'late'] as const)('closes the one-shot socket when native encryption completes %s after the deadline', async (completion) => {
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const nativeCrypto = await import('rn-encryption');
        const secret = new Uint8Array(32).fill(7);
        expect(await TokenStorage.setCredentials({ token: token(), secret: encodeBase64(secret, 'base64url') })).toBe(true);
        const encryption = await Encryption.create(secret);
        const body = await (await fetch(`${serverUrl}/v2/sessions/session`)).json();
        body.session.encryptionMode = 'e2ee';
        body.session.dataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(new Uint8Array(32).fill(8)), 'base64');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
        let finish!: (value: string) => void;
        // Stall only the native AES boundary; account/session/encryption/RPC logic stays real.
        const encrypt = vi.spyOn(nativeCrypto, 'encryptAsyncAES').mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed());
            await vi.advanceTimersByTimeAsync(0);
            expect(encrypt).toHaveBeenCalledTimes(1);
            expect(boundary.disconnect).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(30_000);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            expect(boundary.disconnect).toHaveBeenCalledTimes(1);
            if (completion === 'late') {
                finish('AAAA');
                await vi.advanceTimersByTimeAsync(0);
                expect(boundary.disconnect).toHaveBeenCalledTimes(1);
            }
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('disconnects an in-progress connection at the action deadline and ignores a late connect event', async () => {
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        const sessionResponse = await fetch(`${serverUrl}/v2/sessions/session`);
        let release!: () => void;
        const lookup = new Promise<Response>((resolve) => { release = () => resolve(sessionResponse); });
        vi.stubGlobal('fetch', vi.fn(() => lookup));
        boundary.connectsImmediately = false;
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed());
            await vi.advanceTimersByTimeAsync(5000);
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.connect).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(25_000);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            // The connection's own 30s timeout is still five seconds away.
            expect(boundary.disconnect).toHaveBeenCalledTimes(1);
            boundary.completeConnection?.();
            await vi.advanceTimersByTimeAsync(5000);
            expect(boundary.rpc).not.toHaveBeenCalled();
            expect(boundary.disconnect).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });

    it('bounds a stalled target import without issuing after it resolves late', async () => {
        const target = await import('./resolveNotificationPermissionTarget');
        await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
        let release!: () => void;
        const stalledTarget = new Promise<typeof target>((resolve) => { release = () => resolve(target); });
        // Stall only the bundle loader. Resolved modules retain real auth/storage/RPC behavior.
        vi.useFakeTimers();
        try {
            const pending = executeNotificationPermissionAction(parsed(), {
                importTarget: () => stalledTarget,
            });
            let settled = false;
            void pending.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(29_999);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(pending).resolves.toMatchObject({ status: 'not_sent' });
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('records a content-free recovery notice without a second asynchronous load', async () => {
        const { consumeNotificationPermissionRecoveryNeeded } = await import('./notificationPermissionRecovery');
        consumeNotificationPermissionRecoveryNeeded();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await expect(executeNotificationPermissionAction({ ...parsed(), permissionAction: null })).resolves.toMatchObject({ status: 'not_sent' });
            expect(boundary.rpc).not.toHaveBeenCalled();
            expect(consumeNotificationPermissionRecoveryNeeded()).toBe(true);
            expect(warn.mock.calls.flat().join(' ')).not.toContain(serverUrl);
        } finally { warn.mockRestore(); }
    });

    it('ignores receipts, malformed bodies and Open/Answer, and refuses malformed or unsaved permission targets', async () => {
        for (const body of [null, {}, { data: null }, { data: { notification: {} } }, { data: response('unknown') }, { data: response('expo.modules.notifications.actions.DEFAULT') }, { data: response(PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1) }]) {
            await expect(handleNotificationBackgroundTask(body)).resolves.toMatchObject({ status: 'ignored' });
        }
        await expect(executeNotificationPermissionAction({ ...parsed(), permissionAction: null })).resolves.toMatchObject({ status: 'not_sent' });
        await expect(executeNotificationPermissionAction({ ...parsed(), serverUrl: 'https://unsaved.example.test' })).resolves.toMatchObject({ status: 'not_sent' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it('decodes SDK54 task dataString and interprets application rejection inside transport success', async () => {
        boundary.rpc.mockResolvedValue({ ok: true, result: { ok: false, errorCode: 'permission_request_expired' } });
        const nativeResponse = { actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, notification: {
            request: { identifier: 'n1', content: { dataString: JSON.stringify(response().notification.request.content.data) } },
        } };
        await expect(handleNotificationBackgroundTask({ data: nativeResponse })).resolves.toMatchObject({ status: 'rejected' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
    });

    it.each([
        { entry: 'cached Reply', action: PUSH_NOTIFICATION_ACTION_IDS.questionTextV1, cached: true },
        { entry: 'DEFAULT session tap', action: 'expo.modules.notifications.actions.DEFAULT', cached: false },
    ])('keeps $entry session navigation bound to its supplied Account', async ({ action, cached }) => {
        const current = response(action);
        const hinted = { ...current, userText: 'a private answer', notification: { request: { ...current.notification.request,
            content: { data: { ...current.notification.request.content.data, accountId: 'account',
                questionAnswerV1: { kind: 'text', questionKey: 'Which?', allowEmpty: false } } } } } };
        await TokenStorage.setCredentials({ token: token('replacement-account') });
        if (cached) boundary.lastResponse = hinted;
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            if (!cached) await act(async () => { boundary.listener?.(hinted); });
            await flushHookEffects();
            expect(boundary.navigate).not.toHaveBeenCalled();
            expect(boundary.push).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it.each([
        { entry: 'cached Reply', action: PUSH_NOTIFICATION_ACTION_IDS.questionTextV1, cached: true },
        { entry: 'DEFAULT session tap', action: 'expo.modules.notifications.actions.DEFAULT', cached: false },
    ])('opens $entry session navigation for the matching supplied Account without replaying input', async ({ action, cached }) => {
        const current = response(action);
        const hinted = { ...current, userText: 'a private answer', notification: { request: { ...current.notification.request,
            content: { data: { ...current.notification.request.content.data, accountId: 'account',
                questionAnswerV1: { kind: 'text', questionKey: 'Which?', allowEmpty: false } } } } } };
        if (cached) boundary.lastResponse = hinted;
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            if (!cached) await act(async () => { boundary.listener?.(hinted); });
            await vi.waitFor(() => expect(boundary.navigate).toHaveBeenCalledTimes(1));
            expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
            expect(boundary.push).not.toHaveBeenCalled();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('revalidates supplied Account session navigation after the saved Home switch', async () => {
        const current = response('expo.modules.notifications.actions.DEFAULT');
        const hinted = { ...current, notification: { request: { ...current.notification.request,
            content: { data: { ...current.notification.request.content.data, accountId: 'account' } } } } };
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true,
            refreshAuth: async () => { await TokenStorage.setCredentials({ token: token('replacement-account') }); },
        }));
        try {
            await act(async () => { boundary.listener?.(hinted); });
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
            expect(boundary.navigate).not.toHaveBeenCalled();
            expect(boundary.push).not.toHaveBeenCalled();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('keeps resumed supplied Account session navigation bound after pending persistence', async () => {
        const { setPendingNotificationNav, clearPendingNotificationNav } = await import('@/sync/domains/pending/pendingNotificationNav');
        await TokenStorage.setCredentials({ token: token('replacement-account') });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId: 'srv_notification_identity', accountId: 'replacement-account' } });
        setPendingNotificationNav({ serverUrl, route: '/session/session', accountId: 'account' });
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await flushHookEffects();
            expect(boundary.push).not.toHaveBeenCalled();
            expect(boundary.navigate).not.toHaveBeenCalled();
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); clearPendingNotificationNav(); }
    });

    it.each([
        { matching: false, foreignHome: false },
        { matching: true, foreignHome: false },
        { matching: true, foreignHome: true },
    ])('keeps supplied Account admission on an explicit session URL (matching Account: $matching, foreign Home: $foreignHome)', async ({ matching, foreignHome }) => {
        const current = response('expo.modules.notifications.actions.DEFAULT');
        const other = foreignHome ? profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' }) : null;
        const explicitRoute = `/session/session/info?jumpSeq=3${other ? `&serverId=${encodeURIComponent(other.id)}` : ''}`;
        const hinted = { ...current, notification: { request: { ...current.notification.request,
            content: { data: { ...current.notification.request.content.data, accountId: 'account', url: explicitRoute } } } } };
        if (!matching) await TokenStorage.setCredentials({ token: token('replacement-account') });
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await act(async () => { boundary.listener?.(hinted); });
            if (matching && !foreignHome) {
                await vi.waitFor(() => expect(boundary.push).toHaveBeenCalledWith(explicitRoute));
            } else {
                await flushHookEffects();
                expect(boundary.push).not.toHaveBeenCalled();
                await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
            }
            expect(boundary.navigate).not.toHaveBeenCalled();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('keeps Add Home presentation for supplied Account session notifications without admitting session content', async () => {
        const current = response('expo.modules.notifications.actions.DEFAULT');
        const unknownHome = 'https://unsaved.example.test';
        const hinted = { ...current, notification: { request: { ...current.notification.request,
            content: { data: { ...current.notification.request.content.data, serverUrl: unknownHome, accountId: 'account' } } } } };
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await act(async () => { boundary.listener?.(hinted); });
            expect(boundary.push).toHaveBeenCalledWith(`/settings/server?url=${encodeURIComponent(unknownHome)}&source=notification`);
            expect(boundary.navigate).not.toHaveBeenCalled();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('navigates to the session for a saved cold-start response without executing it', async () => {
        boundary.lastResponse = response();
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        await flushHookEffects();
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(boundary.navigate).toHaveBeenCalledTimes(1);
        expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
        expect(profiles.getActiveServerUrl()).toBe(serverUrl);
        await hook.unmount();
    });

    it.each(['android', 'ios'] as const)('does not reopen a handled background action from the saved response cache on %s', async (platform) => {
        Platform.OS = platform;
        await expect(handleNotificationBackgroundTask({ data: response() })).resolves.toMatchObject({ status: 'confirmed' });
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        boundary.lastResponse = response();
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        expect(boundary.push).not.toHaveBeenCalled();
        expect(profiles.getActiveServerUrl()).toBe(other.serverUrl);
        await hook.unmount();
    });

    it.each(['android', 'ios'] as const)('still opens review for a newer occurrence reusing a native notification identifier on %s', async (platform) => {
        Platform.OS = platform;
        boundary.lastResponse = response();
        const first = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        await flushHookEffects();
        expect(boundary.navigate).toHaveBeenCalledTimes(1);
        await first.unmount();
        const next = response();
        next.notification.request.content.data.occurrenceId = 'next-occurrence';
        boundary.lastResponse = next;
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        await flushHookEffects();
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(boundary.navigate).toHaveBeenCalledTimes(2);
        expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId, 1);
        await hook.unmount();
    });

    it('keeps ordinary notification taps and Answer routed on Android and iOS', async () => {
        for (const platform of ['android', 'ios'] as const) {
            Platform.OS = platform;
            const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
            await act(async () => { boundary.listener?.(response('expo.modules.notifications.actions.DEFAULT', `${platform}-tap-${responseSequence}`)); });
            expect(boundary.navigate).toHaveBeenCalledTimes(1);
            expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
            boundary.navigate.mockClear();
            await act(async () => { boundary.listener?.(response(PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1, `${platform}-answer-${responseSequence}`)); });
            expect(boundary.navigate).toHaveBeenCalledTimes(1);
            expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
            boundary.navigate.mockClear();
            await hook.unmount();
        }
        expect(boundary.rpc).not.toHaveBeenCalled();
    });

    it.each(['expo.modules.notifications.actions.DEFAULT', PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1])('keeps generated session navigation scoped to its notification server: %s', async (action) => {
        const target = profiles.getActiveServerSnapshot();
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await act(async () => {
                boundary.listener?.(response(action));
                profiles.setActiveServerId(other.id, { scope: 'device' });
            });
            expect(boundary.navigate).toHaveBeenCalledTimes(1);
            expectSessionNavigationToServer(target.serverId);
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('preserves an explicit arbitrary notification URL instead of replacing it with a session route', async () => {
        const current = response('expo.modules.notifications.actions.DEFAULT');
        const custom = { ...current, notification: { request: { ...current.notification.request, content: {
            data: { ...current.notification.request.content.data, accountId: 'another-account', url: '/settings/notifications?source=push' },
        } } } };
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await act(async () => { boundary.listener?.(custom); });
            expect(boundary.push).toHaveBeenCalledWith('/settings/notifications?source=push');
            expect(boundary.navigate).not.toHaveBeenCalled();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('executes a live iOS permission action against its explicit server without navigating or changing Home', async () => {
        Platform.OS = 'ios';
        const { storage } = await import('@/sync/domains/state/storage');
        const initialState = storage.getState();
        const target = profiles.getActiveServerSnapshot();
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        profiles.setActiveServerId(target.serverId, { scope: 'device' });
        // A notification can be the first session reference on this device.
        storage.setState({ sessions: {}, sessionListViewDataByServerId: {} });
        const originalFetch = fetch;
        const fetchBoundary = vi.fn<typeof fetch>(async (input, init) => {
            if (String(input).startsWith(`${other.serverUrl}/v2/sessions/`)) return new Response('{}', { status: 404 });
            return originalFetch(input, init);
        });
        vi.stubGlobal('fetch', fetchBoundary);
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            expect(boundary.listener).toEqual(expect.any(Function));
            await act(async () => {
                boundary.listener?.(response());
                // The real handler awaits loading/dispatch; Home can change in that interval.
                profiles.setActiveServerId(other.id, { scope: 'device' });
            });
            await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
            await flushHookEffects();
            const sessionUrls = fetchBoundary.mock.calls.map(([input]) => new URL(String(input)))
                .filter((url) => url.pathname.startsWith('/v2/sessions/'))
                .map((url) => `${url.origin}${url.pathname}`);
            expect(sessionUrls).toEqual([`${serverUrl}/v2/sessions/session`]);
            expect(boundary.rpc).toHaveBeenCalledTimes(1);
            expect(boundary.navigate).not.toHaveBeenCalled();
            expect(boundary.push).not.toHaveBeenCalled();
            expect(profiles.getActiveServerUrl()).toBe(other.serverUrl);
        } finally {
            await hook.unmount();
            storage.setState(initialState, true);
        }
    });

    it('opens an unhandled cached iOS permission response for scoped review without executing it', async () => {
        Platform.OS = 'ios';
        boundary.lastResponse = response();
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await vi.waitFor(() => expect(boundary.navigate).toHaveBeenCalledTimes(1));
            expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
            expect(boundary.rpc).not.toHaveBeenCalled();
            expect(boundary.lastResponse).toBeNull();
        } finally { await hook.unmount(); }
    });

    it('opens a legacy pending iOS action for scoped review and contains navigation failures', async () => {
        Platform.OS = 'ios';
        const { setPendingNotificationAction, getPendingNotificationAction } = await import('@/sync/domains/pending/pendingNotificationAction');
        setPendingNotificationAction({ serverUrl, sessionId: 'session', requestId: 'request', action: 'allow' });
        boundary.navigate.mockImplementationOnce(() => { throw new Error('navigation unavailable'); });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await flushHookEffects();
            expectSessionNavigationToServer(profiles.getActiveServerSnapshot().serverId);
            expect(error).toHaveBeenCalled();
            expect(getPendingNotificationAction()).toBeNull();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('offers pending-request review only after foregrounding a legacy unknown recovery notice', async () => {
        const emitter = createReactNativeAppStateEmitter('background');
        const restoreAppState = emitter.install(AppState);
        const { MMKV } = await import('react-native-mmkv');
        const { readStorageScopeFromEnv, scopedStorageId } = await import('@/utils/system/storageScope');
        // Characterize the original presentation flag, which had no Home/Account.
        const legacy = new MMKV({ id: scopedStorageId('notification-permission-actions', readStorageScopeFromEnv()) });
        legacy.set('recovery-needed', '1');
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await flushHookEffects();
            expect(boundary.alert).not.toHaveBeenCalled();
            expect(boundary.push).not.toHaveBeenCalled();
            await act(async () => { emitter.emit('active'); });
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
            const review = boundary.alert.mock.calls[0]?.[2]?.find((button) => button.onPress);
            expect(review?.onPress).toEqual(expect.any(Function));
            expect(boundary.push).not.toHaveBeenCalled();
            await act(async () => { review?.onPress?.(); });
            await vi.waitFor(() => expect(boundary.push).toHaveBeenCalledWith('/(app)/inbox'));
            expect(boundary.rpc).not.toHaveBeenCalled();
            expect(consumeNotificationPermissionRecoveryNeeded()).toBe(false);
        } finally { await hook.unmount(); restoreAppState(); }
    });

    it('opens known recovery in its saved Home after an explicit review press', async () => {
        const target = await resolveNotificationPermissionTarget(serverUrl);
        expect(target).not.toBeNull();
        markNotificationPermissionRecoveryNeeded(target);
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        const refreshAuth = vi.fn(async () => {});
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth }));
        try {
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
            expect(profiles.getActiveServerUrl()).toBe(other.serverUrl);
            expect(boundary.push).not.toHaveBeenCalled();
            const review = boundary.alert.mock.calls[0]?.[2]?.find((button) => button.onPress);
            expect(review?.onPress).toEqual(expect.any(Function));
            await act(async () => { review?.onPress?.(); });
            await vi.waitFor(() => expect(boundary.push).toHaveBeenCalledWith('/(app)/inbox'));
            expect(profiles.getActiveServerUrl()).toBe(serverUrl);
            expect(refreshAuth).toHaveBeenCalled();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('refuses known recovery after its saved Home credentials change Account before review', async () => {
        const target = await resolveNotificationPermissionTarget(serverUrl);
        expect(target).not.toBeNull();
        markNotificationPermissionRecoveryNeeded(target);
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
            const review = boundary.alert.mock.calls[0]?.[2]?.find((button) => button.onPress);
            expect(review?.onPress).toEqual(expect.any(Function));
            await TokenStorage.setCredentials({ token: token('replacement-account') });
            await act(async () => { review?.onPress?.(); });
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(2));
            expect(boundary.push).not.toHaveBeenCalled();
            expect(boundary.navigate).not.toHaveBeenCalled();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('refuses known recovery when Account changes while switching to its saved Home', async () => {
        const target = await resolveNotificationPermissionTarget(serverUrl);
        expect(target).not.toBeNull();
        markNotificationPermissionRecoveryNeeded(target);
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        const hook = await renderHook(() => useNotificationResponseRouting({
            enabled: true,
            refreshAuth: async () => { await TokenStorage.setCredentials({ token: token('replacement-account') }); },
        }));
        try {
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
            const review = boundary.alert.mock.calls[0]?.[2]?.find((button) => button.onPress);
            expect(review?.onPress).toEqual(expect.any(Function));
            await act(async () => { review?.onPress?.(); });
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(2));
            expect(boundary.push).not.toHaveBeenCalled();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('does not borrow the current Home for recovery after the saved target is removed', async () => {
        const target = await resolveNotificationPermissionTarget(serverUrl);
        if (!target) throw new Error('Fixture target unavailable');
        markNotificationPermissionRecoveryNeeded(target);
        const saved = profiles.getServerProfileById(target.serverId);
        if (!saved) throw new Error('Fixture profile unavailable');
        const other = profiles.upsertServerProfile({ serverUrl: 'https://other.example.test', name: 'Other' });
        profiles.setActiveServerId(other.id, { scope: 'device' });
        await TokenStorage.setCredentials({ token: token('other-account') });
        profiles.removeServerProfile(saved.id);
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
            const review = boundary.alert.mock.calls[0]?.[2]?.find((button) => button.onPress);
            expect(review?.onPress).toEqual(expect.any(Function));
            await act(async () => { review?.onPress?.(); });
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(2));
            expect(boundary.push).not.toHaveBeenCalled();
            expect(profiles.getActiveServerUrl()).toBe(other.serverUrl);
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('enforces a supplied account hint on the iOS notification path', async () => {
        Platform.OS = 'ios';
        const current = response();
        const hinted = { ...current, notification: { request: { ...current.notification.request, content: {
            data: { ...current.notification.request.content.data, accountId: 'another-account' },
        } } } };
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        try {
            await act(async () => { boundary.listener?.(hinted); });
            await flushHookEffects();
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
            const review = boundary.alert.mock.calls[0]?.[2]?.find((button) => button.onPress);
            expect(review?.onPress).toEqual(expect.any(Function));
            await act(async () => { review?.onPress?.(); });
            await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(2));
            expect(boundary.navigate).not.toHaveBeenCalled();
            expect(boundary.push).not.toHaveBeenCalled();
            expect(boundary.rpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it.each([PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1])('shows recovery for a live legacy iOS permission response and sends only occurrence-bound responses: %s', async (action) => {
        Platform.OS = 'ios';
        const hook = await renderHook(() => useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }));
        const current = response(action, `ios-current-${responseSequence}`);
        const { occurrenceId: _occurrenceId, ...legacyData } = current.notification.request.content.data;
        const legacy = { ...current, notification: { request: {
            ...current.notification.request, identifier: `ios-legacy-${responseSequence}`, content: { data: legacyData },
        } } };
        await act(async () => { boundary.listener?.(legacy); });
        // Recovery follows the awaited permission branch, so this observes its
        // completion before making the negative assertion at the real socket boundary.
        await vi.waitFor(() => expect(boundary.alert).toHaveBeenCalledTimes(1));
        expect(boundary.rpc).not.toHaveBeenCalled();

        // The same loaded hook and boundary must execute a current payload.
        await act(async () => { boundary.listener?.(current); });
        await vi.waitFor(() => expect(boundary.rpc).toHaveBeenCalledTimes(1));
        await flushHookEffects();
        expect(boundary.navigate).not.toHaveBeenCalled();
        expect(boundary.push).not.toHaveBeenCalled();
        expect(boundary.rpc.mock.calls[0]?.[1]).toMatchObject({
            method: 'session:session.permission.respondToOccurrence.v1',
            params: expect.objectContaining({ occurrenceId: current.notification.request.content.data.occurrenceId }),
        });
        expect(profiles.getActiveServerUrl()).toBe(serverUrl);
        await hook.unmount();
    });
});
