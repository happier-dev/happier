import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createServerFetchWithReachabilityProbe, createSessionFixture, createSocketHarness, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerId, setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedSessionDataKeyCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { rpcBoundary, connectSocket } = vi.hoisted(() => ({
    rpcBoundary: vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
    connectSocket: vi.fn(),
}));
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => connectSocket(...args) }));
vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: { sessionRPC: (_sessionId: string, method: string, payload: unknown) => rpcBoundary(method, payload) },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator',
        Platform: { OS: 'ios', select: <T,>(value: { ios?: T; default?: T }) => value.ios ?? value.default },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const initialStorageState = storage.getState();
let sessionSequence = 0;
let sessionId: string;
let originalServerId: string;

function accountToken(accountId: string): string {
    return `e30.${btoa(JSON.stringify({ sub: accountId }))}.signature`;
}

async function renderFooter(flavor: 'claude' | 'codex' | 'opencode' | 'gemini' = 'opencode') {
    const { PermissionFooter } = await import('./PermissionFooter');
    return await renderScreen(React.createElement(PermissionFooter, {
        permission: { id: 'p1', status: 'pending' }, sessionId,
        toolName: flavor === 'claude' ? 'Read' : 'execute', toolInput: { command: 'pwd' }, metadata: { flavor },
    }));
}

function replaceAccount() {
    vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue({ token: accountToken('account-after') });
    storage.setState({ profileScope: { serverId: getActiveServerId(), accountId: 'account-after' } });
    storage.getState().applySessions([createSessionFixture({
        id: sessionId, thinking: true, thinkingAt: Date.now() + 1,
        metadata: null, agentState: { requests: { p1: { tool: 'Bash', arguments: {}, occurrenceId: 'new-account-request' } } },
    })]);
    storage.getState().markSessionOptimisticThinking(sessionId);
    return storage.getState().sessions[sessionId];
}

describe('PermissionFooter stop action', () => {
    beforeEach(() => {
        rpcBoundary.mockReset().mockResolvedValue({ ok: true });
        connectSocket.mockReset();
        storage.setState(initialStorageState, true);
        sessionId = `permission-stop-${++sessionSequence}`;
        const serverId = getActiveServerId();
        originalServerId = serverId;
        storage.setState({ profileScope: { serverId, accountId: 'account-before' } });
        storage.getState().applySessions([createSessionFixture({ id: sessionId, metadata: null, thinking: true, thinkingAt: 1 })]);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const token = accountToken('account-before');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const response = V2SessionByIdResponseSchema.parse({ session: {
            id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, archivedAt: null,
            metadata: 'metadata', metadataVersion: 1, agentState: null, agentStateVersion: 0,
            pendingCount: 0, pendingVersion: 0, encryptionMode: 'plain', dataEncryptionKey: null,
        } });
        vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async () => new Response(JSON.stringify(response), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }))));
        const emitWithAck = async (_event: string, packet: { method: string; params: unknown }) => ({
            ok: true, result: await rpcBoundary(packet.method.slice(sessionId.length + 1), packet.params),
        });
        connectSocket.mockReturnValue({
            ...createSocketHarness<Record<string, unknown>>(), connected: true, connect: () => {}, disconnect: () => {},
            timeout: () => ({ emitWithAck }), emitWithAck,
        });
    });
    afterEach(() => {
        setActiveServerId(originalServerId);
        serverScopedRpcSocketPool.resetForTests();
        resetScopedSessionDataKeyCacheForTests();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each([
        { flavor: 'codex', aborts: false, readOnly: false },
        { flavor: 'opencode', aborts: true, readOnly: false },
        { flavor: 'claude', aborts: true, readOnly: true },
        { flavor: 'gemini', aborts: true, readOnly: false },
    ] as const)('preserves $flavor Stop behavior at the RPC boundary', async ({ flavor, aborts, readOnly }) => {
        const screen = await renderFooter(flavor);
        await pressTestInstanceAsync(screen.findByProps({ testID: 'permission-footer.stop' }), 'Stop');
        expect(rpcBoundary.mock.calls.map(([method]) => method)).toEqual(aborts ? ['permission', 'abort'] : ['permission']);
        expect(rpcBoundary.mock.calls[0]?.[1]).toMatchObject({ id: 'p1', approved: false, decision: aborts ? 'abort' : 'denied' });
        expect(storage.getState().sessions[sessionId]?.permissionMode === 'read-only').toBe(readOnly);
        if (aborts) {
            expect(connectSocket).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                auth: expect.objectContaining({ token: accountToken('account-before') }),
            }));
        }
    });

    it('dispatches one denial and one abort when Stop is activated twice before React commits', async () => {
        const screen = await renderFooter();
        const stop = screen.findByProps({ testID: 'permission-footer.stop' });
        await act(async () => { await Promise.all([stop.props.onPress(), stop.props.onPress()]); });
        expect(rpcBoundary.mock.calls.map(([method]) => method)).toEqual(['permission', 'abort']);
    });

    it.each(['claude', 'opencode'] as const)('Deny leaves the %s run active', async (flavor) => {
        const screen = await renderFooter(flavor);
        await pressTestInstanceAsync(screen.findByProps({ testID: 'permission-footer.deny' }), 'Deny');
        expect(rpcBoundary.mock.calls.map(([method]) => method)).toEqual(['permission']);
        expect(rpcBoundary.mock.calls[0]?.[1]).toMatchObject({ id: 'p1', approved: false, decision: 'denied' });
        expect(storage.getState().sessions[sessionId]?.permissionMode).not.toBe('read-only');
    });

    it('does not abort or settle Stop when the CLI rejects the permission decision', async () => {
        const rejected = { ok: false, errorCode: 'permission_request_not_found' };
        rpcBoundary.mockResolvedValueOnce(rejected);
        const before = storage.getState().sessions[sessionId];
        const screen = await renderFooter();
        const stop = screen.findByProps({ testID: 'permission-footer.stop' });
        await pressTestInstanceAsync(stop, 'Stop');
        expect(rpcBoundary.mock.calls.map(([method]) => method)).toEqual(['permission']);
        expect(storage.getState().sessions[sessionId]).toBe(before);
        // A rejected decision remains retryable through the real shared dispatch guard.
        await pressTestInstanceAsync(stop, 'retry Stop');
        expect(rpcBoundary.mock.calls.map(([method]) => method)).toEqual(['permission', 'permission', 'abort']);
    });

    it('does not abort a replacement Account after the permission acknowledgment', async () => {
        let replacement: ReturnType<typeof replaceAccount> | undefined;
        rpcBoundary.mockImplementation(async (method) => {
            if (method === 'permission') replacement = replaceAccount();
            return { ok: true };
        });
        const screen = await renderFooter();
        await pressTestInstanceAsync(screen.findByProps({ testID: 'permission-footer.stop' }), 'Stop');
        expect(rpcBoundary.mock.calls.map(([method]) => method)).toEqual(['permission']);
        expect(storage.getState().sessions[sessionId]).toBe(replacement);
    });

    it('does not issue Stop with credentials from a replacement Account', async () => {
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue({ token: accountToken('account-after') });
        const before = storage.getState().sessions[sessionId];
        const screen = await renderFooter();
        await pressTestInstanceAsync(screen.findByProps({ testID: 'permission-footer.stop' }), 'Stop');
        expect(rpcBoundary.mock.calls).toEqual([]);
        expect(storage.getState().sessions[sessionId]).toBe(before);
    });

    it('finishes Stop in its original Account when server focus changes', async () => {
        let focusedSession: ReturnType<typeof replaceAccount> | undefined;
        rpcBoundary.mockImplementation(async (method) => {
            if (method === 'permission') {
                const other = upsertServerProfile({ serverUrl: 'https://permission-stop-other.example.test' });
                setActiveServerId(other.id);
                storage.setState({ profileScope: { serverId: other.id, accountId: 'focused-account' } });
                storage.getState().applySessions([createSessionFixture({ id: sessionId, thinking: true, thinkingAt: Date.now() + 1 })]);
                storage.getState().markSessionOptimisticThinking(sessionId);
                focusedSession = storage.getState().sessions[sessionId];
            }
            return { ok: true };
        });
        const screen = await renderFooter('claude');
        await pressTestInstanceAsync(screen.findByProps({ testID: 'permission-footer.stop' }), 'Stop');
        expect(rpcBoundary.mock.calls.map(([method]) => method)).toEqual(['permission', 'abort']);
        expect(storage.getState().sessions[sessionId]).toBe(focusedSession);
    });

    it('does not apply a delayed abort acknowledgment to a replacement Account', async () => {
        const issued = createDeferred<void>();
        const acknowledgment = createDeferred<{ ok: true }>();
        rpcBoundary.mockImplementation(async (method) => {
            if (method !== 'abort') return { ok: true };
            issued.resolve();
            return await acknowledgment.promise;
        });
        const screen = await renderFooter('claude');
        const stop = screen.findByProps({ testID: 'permission-footer.stop' });
        await act(async () => {
            const pending = stop.props.onPress();
            await issued.promise;
            const replacement = replaceAccount();
            acknowledgment.resolve({ ok: true });
            await pending;
            expect(storage.getState().sessions[sessionId]).toBe(replacement);
        });
        expect(rpcBoundary.mock.calls.map(([method]) => method)).toEqual(['permission', 'abort']);
    });
});
