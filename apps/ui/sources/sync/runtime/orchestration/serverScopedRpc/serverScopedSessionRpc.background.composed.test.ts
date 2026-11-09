import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'android' } });
});

// Install the actual HTTP/Socket SDK ports before loading the real app runtime.
const initialNetwork = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
await initialNetwork.dispose();

const { storage } = await import('@/sync/domains/state/storage');
const initialStorageState = storage.getState();
let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>> | null = null;

async function focusPlainHome() {
    network = await installSessionOpsNetworkBoundary();
    const focused = await network.addHome('https://background-focused.example.test', 'focused-account');
    const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    await setActiveServerId(focused.id);
    const connection = await import('@/sync/runtime/orchestration/connectionManager');
    await connection.restoreConnectionToActiveServer({ token: focused.token });
    network.resetRequests();
    return focused;
}

afterEach(async () => {
    vi.useRealTimers();
    const { setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    setServerReachabilityNetworkAllowed(true);
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await network?.dispose();
    network = null;
    storage.setState(initialStorageState, true);
    vi.restoreAllMocks();
});

describe('background Session RPC through real Home and Account owners', () => {
    it('uses the scoped Account crypto and one-shot socket while foreground networking is paused', async () => {
        const focused = await focusPlainHome();
        const { socketRpcCodec } = await import('@happier-dev/sync-client');
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { sealEncryptedDataKeyEnvelopeV1} = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { createSessionSystemRecordHttpFixture } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const secret = new Uint8Array(32).fill(21);
        const sessionDataKey = new Uint8Array(32).fill(9);
        const account = await Encryption.create(secret);
        const envelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionDataKey,
            recipientPublicKey: account.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) }), 'base64');
        await account.initializeSessions(new Map([['session-1', sessionDataKey]]));
        const daemon = account.getSessionEncryption('session-1');
        if (!daemon) throw new Error('Real daemon Session cipher is unavailable');
        const encrypted = await network!.addHome('https://background-encrypted.example.test', 'encrypted-account', {
            encryptionMode: 'e2ee', credentials: { token: createAccountTokenForTests('encrypted-account'),
                secret: Buffer.from(secret).toString('base64url') },
        });
        const plainHttp = createSessionSystemRecordHttpFixture({ sessionId: 'session-1', records: [], encryptionMode: 'plain' });
        const encryptedHttp = createSessionSystemRecordHttpFixture({ sessionId: 'session-1', records: [],
            encryptionMode: 'e2ee', dataEncryptionKey: envelope });
        network!.setHttpResponder(async input => {
            const url = new URL(String(input));
            if (url.pathname !== '/v2/sessions/session-1') return null;
            return await (url.origin === encrypted.serverUrl ? encryptedHttp : plainHttp).request(input);
        });
        const { userRequestLeaseOwner } = await import('@/sync/runtime/connectivity/userRequestLease');
        const daemonSaw: unknown[] = [];
        network!.setRpcAckResponder(async request => {
            expect(userRequestLeaseOwner.hasActiveLease()).toBe(false);
            if (request.serverUrl === focused.serverUrl) return { ok: true, result: { accepted: true } };
            if (typeof request.payload !== 'string') throw new Error('Expected an encrypted Session request');
            const content = { mode: 'e2ee' as const, cipher: daemon };
            const decoded = await socketRpcCodec.decodeRequestParams(content, request.payload, `${request.targetId}:${request.method}`);
            daemonSaw.push(decoded.params);
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, { accepted: true }, decoded.callId) };
        });
        const { setServerReachabilityNetworkAllowed, isServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { sessionRpcWithServerAccountScope } = await import('./serverScopedSessionRpc');
        const { getActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { getAppliedActiveServerId } = await import('@/sync/runtime/orchestration/connectionManager');
        setServerReachabilityNetworkAllowed(false);
        storage.setState({ endpointStatus: 'offline' });
        vi.useFakeTimers();
        for (const target of [focused, encrypted]) {
            const outcome = sessionRpcWithServerAccountScope({ sessionId: 'session-1',
                scope: { serverId: target.id, accountId: target.accountId }, method: 'method-test', payload: { approved: true },
                networkMode: 'background-task', timeoutMs: 1_000,
            }).then(value => value, error => error);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(await outcome).toEqual({ accepted: true });
        }
        expect(daemonSaw).toEqual([{ approved: true }]);
        expect(network!.requests.map(({ serverUrl, token }) => [serverUrl, token])).toEqual([
            [focused.serverUrl, focused.token], [encrypted.serverUrl, encrypted.token],
        ]);
        expect(network!.socketBoundaries).toHaveLength(2);
        expect(network!.socketBoundaries.every(({ socket }) => !socket.active)).toBe(true);
        expect(isServerReachabilityNetworkAllowed()).toBe(false);
        expect(getActiveServerId()).toBe(focused.id);
        expect(getAppliedActiveServerId()).toBe(focused.id);
    });

    it('cancels exact scoped credential setup before a late context can issue an RPC', async () => {
        await focusPlainHome();
        const secureStore = await import('expo-secure-store');
        const writes = vi.spyOn(secureStore, 'setItemAsync');
        const target = await network!.addHome('https://background-cold-credential.example.test', 'cold-account');
        // Reuse the exact key/bytes produced by the credential owner. This is a
        // cold OS-store observation, rather than a replacement of credential admission.
        const persisted = writes.mock.calls.find(([, value]) => {
            if (!value.includes(target.token)) return false;
            const parsed: unknown = JSON.parse(value);
            return parsed !== null && typeof parsed === 'object' && 'token' in parsed && parsed.token === target.token;
        });
        writes.mockRestore();
        if (!persisted) throw new Error('Canonical credential write did not reach native secure storage');
        const [credentialKey, credentialBytes] = persisted;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.removeCredentialsForServerUrl(target.serverUrl, { serverId: target.id })).toBe(true);
        await secureStore.setItemAsync(credentialKey, credentialBytes);
        const entered = createDeferred<void>();
        const releaseRead = createDeferred<void>();
        const physicalRead = secureStore.getItemAsync.bind(secureStore);
        const read = vi.spyOn(secureStore, 'getItemAsync').mockImplementation(async (...args) => {
            if (args[0] === credentialKey) { entered.resolve(); await releaseRead.promise; }
            return await physicalRead(...args);
        });
        const controller = new AbortController();
        const { sessionRpcWithServerAccountScope } = await import('./serverScopedSessionRpc');
        vi.useFakeTimers();
        let observed: unknown = 'still-pending';
        const outcome = sessionRpcWithServerAccountScope({ sessionId: 'session-1',
            scope: { serverId: target.id, accountId: target.accountId }, method: 'method-test', payload: {},
            networkMode: 'background-task', signal: controller.signal,
        }).catch(error => { observed = error; return error; });
        try {
            await entered.promise;
            controller.abort();
            await vi.advanceTimersByTimeAsync(0);
            const cancelled = observed;
            releaseRead.resolve();
            await outcome;
            await vi.advanceTimersByTimeAsync(0);
            expect(cancelled).toMatchObject({ name: 'AbortError' });
            expect(network!.requests).toEqual([]);
            expect(network!.socketBoundaries).toEqual([]);
        } finally {
            releaseRead.resolve();
            await outcome;
            read.mockRestore();
        }
    });
});
