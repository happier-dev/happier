import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { fetchAccountEncryptionCurrentness } from './apiAccountEncryptionMode';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import type { Socket } from 'socket.io-client';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { fetchAccountEncryptionMode } from './apiAccountEncryptionMode';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createOperationAccountCurrentnessSource } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { invalidateAccountEncryptionModeCache } from './apiAccountEncryptionMode';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { fetchAccountEncryptionIdentity, invalidateAccountEncryptionModeCacheForChanges, captureAccountEncryptionCurrentness } from './apiAccountEncryptionMode';
import { createMachineFixture, createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resolveAccountPetReadAdmission } from '@/sync/domains/pets/resolveAccountPetReadAdmission';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
beforeAll(loadSyncSingletonForTests);
afterEach(async () => {
    vi.useRealTimers();
    apiSocket.disconnect();
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
    await home.reset();
    resetRuntimeFetch();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it.each(['active', 'historical'] as const)('settles a Plain socket update with %s custody without escaping or blocking disconnect', async custody => {
    const accountId = `plain-conversion-push-${custody}`;
    const serverUrl = `https://plain-conversion-push-${custody}.test`;
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }),
        secret: encodeBase64(new Uint8Array(32).fill(27), 'base64url'), custody };
    const serverId = await home.addHome({ name: 'Plain conversion push', serverUrl, accountId, credentials,
        accountEncryptionMode: 'e2ee', currentAccount: true });
    let currentness: AccountEncryptionCurrentnessResponse = { ...createPlainAccountEncryptionCurrentnessFixture(),
        mode: 'e2ee', recipientEnvelopeReadiness: { status: 'available' } };
    let reads = 0;
    setRuntimeFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') {
            reads++;
            return Response.json(currentness);
        }
        return home.request(url, init);
    });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    const request = createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials });
    apiSocket.initialize({ endpoint: serverUrl, token: credentials.token, credentials, serverId,
        generation: getActiveServerSnapshot().generation, request, isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const binding = apiSocket.getAccountEncryptionObservationBinding(credentials);
    expect(binding).not.toBeNull();
    {
        const read = () => binding!.read();
        await expect(read()).resolves.toMatchObject({ mode: 'e2ee' });
        currentness = { ...createPlainAccountEncryptionCurrentnessFixture(), version: 2, updatedAt: 2 };
        const beforePush = reads;
        const update = { id: 'plain-conversion-push', seq: 2, createdAt: 2,
            body: { t: 'update-account', id: accountId, encryptionCurrentness: currentness } };
        // Use the production onAny entry that produced r132's uncaught overlay.
        expect(() => { for (const listener of socket!.listenersAny()) listener('update', update); }).not.toThrow();
        if (custody === 'active') {
            await expect(read()).rejects.toMatchObject({ code: 'account_mode_downgrade_unverified', canTryAgain: false });
            await expect(read()).rejects.toMatchObject({ code: 'account_mode_downgrade_unverified', canTryAgain: false });
        } else {
            // The converter's completed custody adoption makes this a legitimate Plain observation.
            await expect(read()).resolves.toMatchObject({ mode: 'plain' });
        }
        expect(reads).toBe(beforePush);
        expect(() => apiSocket.disconnect()).not.toThrow();
        expect(socket!.connected).toBe(false);
    }
});

it.each(['captured_binding_before_read', 'captured_binding_after_read'] as const)(
  'logs a safe captured binding refusal at %s without a new authority request', async step => {
    const { captureAccountEncryptionObservationForHome } = await import('@/sync/http/accountEncryptionObservationBinding');
    const accountId = 'private-captured-diagnostic';
    const serverUrl = 'https://private-captured-diagnostic.test';
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Private captured diagnostic', serverUrl, accountId, credentials,
      accountEncryptionMode: 'plain', currentAccount: true });
    let reads = 0;
    setRuntimeFetch(async (url, init) => {
      if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') {
        reads++;
        return Response.json(createPlainAccountEncryptionCurrentnessFixture());
      }
      return home.request(url, init);
    });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    apiSocket.initialize({ endpoint: serverUrl, token: credentials.token, credentials, serverId,
      generation: getActiveServerSnapshot().generation,
      request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials }), isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    await fetchAccountEncryptionIdentity(credentials, { usage: 'identity' });
    let current = true;
    const before = reads;
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (let index = 0; index < 20; index++) {
        expect(captureAccountEncryptionObservationForHome({ serverId: 'unobserved-home', endpointUrl: serverUrl,
          credentials })).toBeUndefined();
      }
      expect(logged).not.toHaveBeenCalled();
      const binding = captureAccountEncryptionObservationForHome({ serverId, endpointUrl: serverUrl, credentials, isCurrent: () => current });
      expect(binding).toBeDefined();
      expect(logged).not.toHaveBeenCalled();
      await binding!.read();
      await binding!.read();
      expect(logged).not.toHaveBeenCalled();
      if (step === 'captured_binding_before_read') current = false;
      const reading = binding!.read();
      current = false;
      await expect(reading).rejects.toMatchObject({ code: 'account-encryption-currentness-unavailable' });
      expect(logged).toHaveBeenCalledWith('[accountEncryptionCurrentness] observation ' + JSON.stringify({
        event: 'captured_binding_read', publishedBindingPresent: true, publishedBindingCurrent: true,
        capturedBindingCurrent: false, sameBinding: true,
      }));
      expect(logged).toHaveBeenCalledWith('[accountEncryptionCurrentness] refusal ' + JSON.stringify({
        code: 'account-encryption-currentness-unavailable', step, errorClass: 'HappyError',
      }));
      expect(JSON.stringify(logged.mock.calls)).not.toContain('private');
      expect(reads).toBe(before);
    } finally { logged.mockRestore(); }
  });

it('shares 171 Machine RPCs per scope and Account identity admissions, refreshes once on a real mode change and reads nothing during idle 180s', async () => {
    const accountId = 'settled-account-currentness';
    const serverUrl = 'https://settled-account-currentness.test';
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Settled Account', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    let currentness = createPlainAccountEncryptionCurrentnessFixture();
    let reads = 0;
    let modeReads = 0;
    let denied = false;
    setRuntimeFetch(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') {
            reads++;
            return denied ? Response.json({ error: 'forbidden' }, { status: 403 }) : Response.json(currentness);
        }
        if (path === '/v1/account/encryption') modeReads++;
        if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, id => {
            // Supported legacy rows have no recipient access projection. The
            // canonical Machine owner then asks for the Account mode.
            const { access: _access, ...legacy } = createPlainMachineRowFixture({ id, accountId });
            return legacy;
        });
        return home.request(url, init);
    });
    let socket: Socket | undefined;
    const rpc = vi.fn(async () => ({ ok: true, result: { ready: true } }));
    installDisconnectedServerSocketBoundary(current => {
        socket = current;
        configureConnectedServerSocketBoundary(current);
        current.emitWithAck = rpc;
    });
    apiSocket.initialize({ endpoint: serverUrl, token: credentials.token, credentials, serverId,
        generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials }), isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const accountSocket = socket!;
    const context = await captureLazyActionAccountContext(serverId);
    const readIdentity = () => fetchAccountEncryptionIdentity(context.credentials, { request: context.request, usage: 'identity' });
    const operation = captureAccountEncryptionCurrentness(serverId);
    try {
        await expect(context.resolveAccountMode()).resolves.toBe('plain');
        const machines = Array.from({ length: 171 }, (_, index) => {
            const id = `settled-machine-${index}`;
            return createMachineFixture({ id, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                access: createPlainMachineRowFixture({ id, accountId }).access });
        });
        storage.getState().applyMachines(machines);
        // Socket.IO is the external boundary; RPC admission, codec and Account
        // observation remain real, including the exact Machine content mode.
        const answers = await Promise.all(machines.map(machine => apiSocket.machineRPC(
            machine.id, RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, {})));
        expect(answers).toEqual(machines.map(() => ({ ready: true })));
        expect(rpc).toHaveBeenCalledTimes(171);
        const scopedAnswers = await Promise.all(machines.map(machine => machineRpcWithServerScope({
            machineId: machine.id, serverId, accountId, preferScoped: true,
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, payload: {},
            onIssued: () => {},
        })));
        expect(scopedAnswers).toEqual(machines.map(() => ({ ready: true })));
        expect(rpc).toHaveBeenCalledTimes(342);
        await Promise.all(Array.from({ length: 171 }, readIdentity));
        await Promise.all(Array.from({ length: 171 }, () => fetchAccountEncryptionMode(
            context.credentials, { request: context.request, usage: 'identity' })));
        expect(await resolveAccountPetReadAdmission(context.credentials, { request: context.request }))
            .toEqual({ status: 'ready' });
        expect(reads).toBe(1);
        expect(modeReads).toBe(0);
        vi.useFakeTimers();
        const beforeIdle = reads;
        await vi.advanceTimersByTimeAsync(180_000);
        expect(reads - beforeIdle).toBe(0);
        expect(modeReads).toBe(0);
        vi.useRealTimers();

        currentness = { ...currentness, mode: 'e2ee', version: 2, updatedAt: 2,
            signingKeyFingerprint: 'changed-signing-key', contentKeyFingerprint: 'changed-content-key',
            recipientEnvelopeReadiness: { status: 'available' } };
        invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self', hint: { encryptionMode: 'e2ee' } }], { serverId });
        expect(operation.isCurrent()).toBe(false);
        const after = await Promise.all(Array.from({ length: 171 }, readIdentity));
        expect(after.every(identity => identity.mode === 'e2ee')).toBe(true);
        expect(await resolveAccountPetReadAdmission(context.credentials, { request: context.request }))
            .toEqual({ status: 'unavailable', reason: 'custom_pet_sync_unavailable' });
        expect(reads).toBe(2);
        // Exact Account/Settings cursor witnesses remain independent fresh reads.
        await fetchAccountEncryptionCurrentness(context.credentials, { request: context.request });
        expect(reads).toBe(3);
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(fetchAccountEncryptionMode(context.credentials, {
            request: context.request, usage: 'identity', signal: cancelled.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(reads).toBe(3);
        denied = true;
        invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self', hint: { encryptionMode: 'plain' } }], { serverId });
        await expect(readIdentity()).rejects.toMatchObject({ status: 403, code: 'account-encryption-currentness-unavailable' });
        expect(reads).toBe(4);
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(reads).toBe(4);
        expect(modeReads).toBe(0);
        vi.useRealTimers();
        // A complete committed push replaces unavailable authority directly.
        const update = { id: 'mode-push', seq: 3, createdAt: 3,
            body: { t: 'update-account', id: accountId, encryptionCurrentness: { ...currentness, version: 3 } } };
        for (const listener of accountSocket.listenersAny()) listener('update', update);
        await expect(readIdentity()).resolves.toMatchObject({ mode: 'e2ee' });
        expect(reads).toBe(4);
    } finally { vi.useRealTimers(); operation.dispose(); context.dispose(); }
});

it.each(['matching', 'different', 'disconnected'] as const)('admits captured Action identity only through its live resolved carrier (%s)', async carrier => {
    const accountId = `captured-carrier-${carrier}`;
    const serverUrl = `https://captured-carrier-${carrier}.test`;
    const runtimeOrigin = carrier === 'different' ? 'https://different-observed-ingress.test' : serverUrl;
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Captured carrier', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    const authorityReads: URL[] = [];
    setRuntimeFetch(async (rawUrl, init) => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/v1/account/encryption' || url.pathname === '/v1/account/encryption/currentness') {
            authorityReads.push(url);
            return Response.json(url.pathname.endsWith('/currentness') ? createPlainAccountEncryptionCurrentnessFixture()
                : { mode: 'plain', updatedAt: 1 });
        }
        return home.request(rawUrl, init);
    });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => {
        socket = current;
        if (carrier !== 'disconnected') configureConnectedServerSocketBoundary(current);
    });
    apiSocket.initialize({ endpoint: serverUrl, runtimeOrigin, token: credentials.token, credentials, serverId,
        generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, runtimeOrigin, serverId, credentials }),
        isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(carrier !== 'disconnected'));
    if (carrier !== 'disconnected') {
        await expect(fetchAccountEncryptionMode(credentials)).resolves.toMatchObject({ mode: 'plain' });
        expect(authorityReads.map(url => url.pathname)).toEqual(['/v1/account/encryption/currentness']);
    }
    authorityReads.length = 0;
    const preparedRequest = apiSocket.createRequestForPreparedTarget({ endpoint: serverUrl, runtimeOrigin, serverId,
        generation: getActiveServerSnapshot().generation });
    await expect(fetchAccountEncryptionMode(credentials, { request: preparedRequest, usage: 'identity' })).resolves.toMatchObject({ mode: 'plain' });
    expect(authorityReads.map(url => [url.origin, url.pathname])).toEqual(carrier === 'disconnected'
        ? [[serverUrl, '/v1/account/encryption']] : []);
    authorityReads.length = 0;
    const invocation = new AbortController();
    const context = await captureLazyActionAccountContext(serverId, invocation.signal);
    try {
        expect(authorityReads).toHaveLength(0);
        await expect(context.resolveAccountMode()).resolves.toBe('plain');
        expect(authorityReads.map(url => [url.origin, url.pathname])).toEqual(carrier === 'matching' ? []
            : [[serverUrl, '/v1/account/encryption']]);
        authorityReads.length = 0;
        await expect(fetchAccountEncryptionCurrentness(context.credentials, { request: context.request }))
            .resolves.toMatchObject({ mode: 'plain' });
        expect(authorityReads.map(url => [url.origin, url.pathname])).toEqual([[serverUrl, '/v1/account/encryption/currentness']]);
        invocation.abort();
        await expect(fetchAccountEncryptionMode(context.credentials, { request: context.request, usage: 'identity' })).rejects.toThrow();
        expect(context.accountLifetime.isCurrent()).toBe(false);
        expect(context.accountOnlyLifetime.isCurrent()).toBe(true);
    } finally { context.dispose(); }
});

it.each([
    { name: 'a retained secret', credentials: { token: 'captured-token', secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') } },
    { name: 'only the bearer', credentials: { token: 'captured-token' } },
])('keeps captured-Home readiness failure with $name out of the selected Home recovery flow', async ({ credentials }) => {
    await upsertAndActivateServer({ serverUrl: 'https://selected-currentness.test' });
    // The selected Home holds recoverable credentials; a captured request must not borrow them.
    const selected = getActiveServerSnapshot();
    await TokenStorage.setCredentialsForServerUrl(selected.serverUrl, { serverId: selected.serverId },
        { token: 'selected-token', secret: encodeBase64(new Uint8Array(32).fill(25), 'base64url') });
    const readCredentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: 'migration-required',
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
    }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = createServerFetchAtEndpoint({ endpointUrl: 'https://captured-currentness.test', credentials });
    await expect(fetchAccountEncryptionCurrentness(credentials, { request })).rejects.toMatchObject({
        code: 'account-encryption-currentness-unavailable',
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).origin).toBe('https://captured-currentness.test');
    expect(readCredentials).not.toHaveBeenCalled();
});

it.each(['unchanged', 'intentional-disconnect', 'explicit-reconnect', 'reconfigure', 'mode', 'fingerprint', 'update', 'malformed-update', 'scope-reset', 'credential-retired', 'home-retired', 'fresh-denied'] as const)(
    'revalidates finite Session hydration across socket loss (%s)', async outcome => {
    const accountId = `finite-${outcome}`;
    const serverUrl = `https://finite-${outcome}.test`;
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Finite Session', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    let currentness: AccountEncryptionCurrentnessResponse = createPlainAccountEncryptionCurrentnessFixture();
    let denied = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let detailStarted = false;
    const sessionId = 'finite-session';
    setRuntimeFetch(createSessionReadBatchFetchBoundary(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption/currentness') return denied
            ? Response.json({ error: 'forbidden' }, { status: 403 }) : Response.json(currentness);
        if (path === `/v2/sessions/${sessionId}`) {
            detailStarted = true;
            await held;
            return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) });
        }
        if (path === `/v1/sessions/${sessionId}/turns`) return Response.json({ v: 1, sessionId, updatedAt: 1, turns: [] });
        return home.request(rawUrl, init);
    }));
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    const request = createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials });
    const config = { endpoint: serverUrl, serverId, token: credentials.token, credentials,
        generation: getActiveServerSnapshot().generation, request, isCurrent: () => true };
    apiSocket.initialize(config, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const context = await captureLazyActionAccountContext(serverId);
    let operationReads = 0;
    const explicitCredentials: string[] = [];
    const source = createOperationAccountCurrentnessSource({ credentials, serverId,
        request: (path, init) => {
            operationReads += 1;
            explicitCredentials.push(new Headers(init.headers).get('Authorization') ?? '');
            return context.request(path, init);
        } });
    try {
        await source.read();
        const reading = runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope,
            activeRequest: context.request }, authority => readSessionSnapshotForAuthority({ authority, sessionId,
                accountCurrentnessSource: source, isCurrent: context.accountLifetime.isCurrent }))
            .then(value => ({ value }), (error: unknown) => ({ error }));
        await waitForHomeGovernance(() => expect(detailStarted).toBe(true));
        socket!.connected = false;
        for (const listener of socket!.listeners('disconnect')) listener('ping timeout');
        if (outcome === 'mode') currentness = { ...currentness, mode: 'e2ee', signingKeyFingerprint: 'signing-new',
            contentKeyFingerprint: 'content-new', recipientEnvelopeReadiness: { status: 'available' } };
        if (outcome === 'fingerprint') currentness = { ...currentness, signingKeyFingerprint: 'changed-anchor' };
        denied = outcome === 'fresh-denied';
        socket!.connect();
        if (outcome === 'update' || outcome === 'malformed-update') {
            const update = { id: 'encryption-change', seq: 2, createdAt: 2,
                body: { t: 'update-account', id: accountId, encryptionCurrentness: outcome === 'update'
                    ? { ...currentness, updatedAt: 2, version: 2 } : { mode: 'plain' } } };
            for (const listener of socket!.listenersAny()) listener('update', update);
        }
        if (outcome === 'scope-reset') invalidateAccountEncryptionModeCache({ reason: 'scope-reset' });
        if (outcome === 'intentional-disconnect') apiSocket.disconnect();
        if (outcome === 'explicit-reconnect') {
            apiSocket.disconnect();
            apiSocket.connect();
            await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
        }
        if (outcome === 'reconfigure') {
            apiSocket.initialize({ ...config }, null);
            await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
        }
        if (outcome === 'credential-retired' || outcome === 'home-retired') {
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId });
            if (outcome === 'home-retired') {
                const { removeServerProfile } = await import('@/sync/domains/server/serverProfiles');
                await removeServerProfile(serverId);
            }
        }
        release();
        const result = await reading;
        if (outcome === 'unchanged' || outcome === 'intentional-disconnect'
            || outcome === 'explicit-reconnect' || outcome === 'reconfigure') {
            expect(result).toMatchObject({ value: { session: { id: sessionId } } });
            expect(source.isCurrent()).toBe(true);
            expect(operationReads).toBe(2);
            await Promise.all([source.read(), source.read()]);
            expect(operationReads).toBe(2);
            expect(explicitCredentials).toEqual([`Bearer ${credentials.token}`, `Bearer ${credentials.token}`]);
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            await expect(TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId })).resolves.toEqual(credentials);
        } else {
            expect(result).toHaveProperty('error');
            if (['mode', 'fingerprint', 'update', 'malformed-update', 'scope-reset'].includes(outcome)) {
                // A previously retired capture is refused by the Snapshot
                // reader before hydration; a fresh-read mismatch reaches the
                // finite currentness owner's more specific typed error.
                expect(result).toMatchObject({ error: outcome === 'mode' || outcome === 'fingerprint'
                    ? { code: 'account_encryption_currentness_changed' }
                    : { name: 'SessionSnapshotReadError', errorCode: 'stale_response' } });
                expect(source.isCurrent()).toBe(false);
                expect(source.assertCurrent).toThrow(expect.objectContaining({ code: 'account_encryption_currentness_changed' }));
            }
        }
    } finally { release(); source.dispose(); context.dispose(); }
});

it('shares the fresh replacement of a withdrawn pending finite currentness read', async () => {
    const initial = createPlainAccountEncryptionCurrentnessFixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    const source = createOperationAccountCurrentnessSource({ credentials: { token: 'finite-pending' }, initial,
        request: async () => {
            requests += 1;
            const version = requests + 1;
            if (requests === 1) await held;
            return Response.json(createPlainAccountEncryptionCurrentnessFixture({ version }));
        } });
    try {
        invalidateAccountEncryptionModeCache({ reason: 'transport-withdrawal' });
        const first = source.read();
        expect(requests).toBe(1);
        invalidateAccountEncryptionModeCache({ reason: 'transport-withdrawal' });
        const second = source.read();
        expect(requests).toBe(1);
        release();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult).toBe(secondResult);
        expect(requests).toBe(2);
    } finally { release(); source.dispose(); }
});

it.each(['healthy', 'socket-reconnect', 'explicit-reconnect', 'reconfigure'] as const)(
    'admits a new finite Session demand through the current Account observation after %s', async transition => {
    const accountId = `new-demand-${transition}`;
    const serverUrl = `https://new-demand-${transition}.test`;
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'New finite demand', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    const statuses: number[] = [];
    const sessionId = 'new-finite-session';
    setRuntimeFetch(createSessionReadBatchFetchBoundary(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption/currentness') {
            statuses.push(200);
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        if (path === `/v2/sessions/${sessionId}`) return Response.json({
            session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }),
        });
        if (path === `/v1/sessions/${sessionId}/turns`) return Response.json({ v: 1, sessionId, updatedAt: 1, turns: [] });
        return home.request(rawUrl, init);
    }));
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    const config = { endpoint: serverUrl, serverId, token: credentials.token, credentials,
        generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials }), isCurrent: () => true };
    apiSocket.initialize(config, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const previous = apiSocket.getAccountEncryptionObservationBinding(credentials);
    expect(previous).not.toBeNull();
    await previous!.read();
    expect(statuses).toEqual([200]);
    if (transition === 'socket-reconnect') {
        socket!.disconnect();
        socket!.connect();
    } else if (transition === 'explicit-reconnect') {
        apiSocket.disconnect();
        expect(previous!.isCurrent()).toBe(false);
        expect(apiSocket.getAccountEncryptionObservationBinding(credentials)).toBeNull();
        apiSocket.connect();
    } else if (transition === 'reconfigure') {
        apiSocket.initialize({ ...config }, null);
    }
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const current = apiSocket.getAccountEncryptionObservationBinding(credentials);
    expect(current?.isCurrent()).toBe(true);
    if (transition === 'explicit-reconnect' || transition === 'reconfigure') {
        expect(previous!.isCurrent()).toBe(false);
        expect(current).not.toBe(previous);
    }
    const context = await captureLazyActionAccountContext(serverId);
    const source = createOperationAccountCurrentnessSource({ credentials: context.credentials,
        serverId, request: context.request });
    try {
        // Every borrower, including a new finite Session read, shares the settled
        // transport fact: the Home decides each Session read against persisted mode.
        await context.resolveAccountMode();
        await Promise.all(Array.from({ length: 20 }, () => fetchAccountEncryptionIdentity(
            context.credentials, { request: context.request, usage: 'identity' })));
        expect(statuses).toEqual(transition === 'healthy' ? [200] : [200, 200]);
        const beforeWitness = statuses.length;
        const snapshots = await Promise.all(Array.from({ length: 2 }, () =>
            runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope,
                activeRequest: context.request }, authority => readSessionSnapshotForAuthority({ authority,
                    sessionId, accountCurrentnessSource: source, isCurrent: context.accountLifetime.isCurrent }))));
        expect(snapshots.every(snapshot => snapshot.session.id === sessionId)).toBe(true);
        expect(source.isCurrent()).toBe(true);
        expect(statuses.slice(beforeWitness)).toEqual([]);
    } finally { source.dispose(); context.dispose(); }
});

it('lets an ambient request borrow only its current transport binding for the same credential', async () => {
    const { bindCurrentAccountEncryptionObservation, readAccountEncryptionObservationBinding } = await import('@/sync/http/accountEncryptionObservationBinding');
    const { fetchOperationAccountEncryptionIdentity } = await import('./apiAccountEncryptionMode');
    const credentials = { token: createAccountTokenForTests('ambient-owner', { currentAccount: true }) };
    const replaced = { token: createAccountTokenForTests('ambient-replacement', { currentAccount: true }) };
    let reads = 0;
    let current = true;
    const settled = { ...createPlainAccountEncryptionCurrentnessFixture() } as Awaited<ReturnType<typeof fetchAccountEncryptionIdentity>>;
    const { resolveAuthCredentialsScopeKey } = await import('@/auth/storage/resolveAuthCredentialsScopeKey');
    // The same Account after a token rotation is a different credential.
    const rotated = { token: credentials.token.replace(/\.signature$/, '.rotated-signature') };
    const binding = { credentials, credentialScopeKey: resolveAuthCredentialsScopeKey(credentials), serverId: 'ambient', endpointUrl: 'https://ambient.test',
        runtimeOrigin: 'https://ambient.test', homeCarrierEndpointId: null, isCurrent: () => current,
        read: async () => settled, readWitness: async () => createPlainAccountEncryptionCurrentnessFixture(),
        peek: () => current ? settled : null };
    let transport: typeof binding | null = null;
    const ambient = bindCurrentAccountEncryptionObservation(async () => {
        reads += 1;
        return Response.json(createPlainAccountEncryptionCurrentnessFixture());
    }, () => transport);
    transport = binding;
    await fetchOperationAccountEncryptionIdentity(credentials, { request: ambient });
    expect(reads).toBe(0);
    // A replaced credential never borrows the transport's admitted mode.
    expect(readAccountEncryptionObservationBinding(ambient, replaced)).toBeNull();
    await fetchOperationAccountEncryptionIdentity(replaced, { request: ambient });
    expect(reads).toBe(1);
    expect(rotated.token).not.toBe(credentials.token);
    expect(readAccountEncryptionObservationBinding(ambient, rotated)).toBeNull();
    await fetchOperationAccountEncryptionIdentity(rotated, { request: ambient });
    expect(reads).toBe(2);
    expect(readAccountEncryptionObservationBinding(ambient, { ...credentials })).toBe(binding);
    // A withdrawn or absent transport binding forces the operation's own read.
    current = false;
    await fetchOperationAccountEncryptionIdentity(credentials, { request: ambient });
    expect(reads).toBe(3);
    current = true;
    transport = null;
    await fetchOperationAccountEncryptionIdentity(credentials, { request: ambient });
    expect(reads).toBe(4);
    // Capturing authority over the ambient request itself keeps its read-time resolver.
    transport = binding;
    const { bindAccountEncryptionObservation } = await import('@/sync/http/accountEncryptionObservationBinding');
    const snapshot = { ...binding, isCurrent: () => false };
    expect(bindAccountEncryptionObservation(ambient, snapshot)).toBe(ambient);
    expect(readAccountEncryptionObservationBinding(ambient, credentials)).toBe(binding);
});

it('refuses to replace a captured request binding with a different one', async () => {
    const { bindAccountEncryptionObservation, readAccountEncryptionObservationBinding } = await import('@/sync/http/accountEncryptionObservationBinding');
    const credentials = { token: createAccountTokenForTests('rebind-owner', { currentAccount: true }) };
    const settled = { ...createPlainAccountEncryptionCurrentnessFixture() } as Awaited<ReturnType<typeof fetchAccountEncryptionIdentity>>;
    const create = () => ({ credentials, credentialScopeKey: 'rebind', serverId: 'rebind', endpointUrl: 'https://rebind.test',
        runtimeOrigin: 'https://rebind.test', homeCarrierEndpointId: null, isCurrent: () => true,
        read: async () => settled, readWitness: async () => createPlainAccountEncryptionCurrentnessFixture(),
        peek: () => settled });
    const first = create();
    const request = bindAccountEncryptionObservation(async () => Response.json({}), first);
    // Re-wrapping with the same binding stays a no-op.
    expect(bindAccountEncryptionObservation(request, first)).toBe(request);
    expect(() => bindAccountEncryptionObservation(request, create())).toThrow(TypeError);
    expect(readAccountEncryptionObservationBinding(request, credentials)).toBe(first);
});

it('discloses read catalogs under the connection admitted mode while pushed mode changes, credential changes and writes stay fresh', async () => {
    const { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/connect/connectedAccountPresentationRowsV1');
    const { readConnectedMetadataCatalogInContext, setConnectedAcknowledgementInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
    const accountId = 'disclosure-admitted-account';
    const serverUrl = 'https://disclosure-admitted-account.test';
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Disclosure admission', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    let currentness: AccountEncryptionCurrentnessResponse = createPlainAccountEncryptionCurrentnessFixture();
    let reads = 0;
    setRuntimeFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') {
            reads++;
            return Response.json(currentness);
        }
        return home.request(url, init);
    });
    for (const route of [CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1]) {
        home.answer(serverId, `GET ${route}`, { body: { status: 'deleted', revision: 3 } });
    }
    home.answer(serverId, `POST ${CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1}`, { body: { status: 'updated', revision: 4, cursor: 4 } });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    apiSocket.initialize({ endpoint: serverUrl, token: credentials.token, credentials, serverId,
        generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials }), isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const context = await captureLazyActionAccountContext(serverId);
    try {
        await expect(context.resolveAccountMode()).resolves.toBe('plain');
        const read = () => readConnectedMetadataCatalogInContext(context, undefined, undefined, false);
        await read();
        // Settled observation: repeated read-only disclosures cost no currentness read.
        const settled = reads;
        for (let index = 0; index < 3; index++) {
            expect((await read()).presentation).toMatchObject({ status: 'ready' });
        }
        expect(reads - settled).toBe(0);

        // A write keeps its own fresh authority point even while the observation is settled.
        await setConnectedAcknowledgementInContext(context, { subject: { kind: 'warning', warningId: 'disclosure',
            scope: { kind: 'account' } }, acknowledged: true });
        expect(reads - settled).toBeGreaterThanOrEqual(1);

        // Another credential never borrows this connection's observation: an actual catalog read
        // with a rotated token admits over HTTP.
        const { readAccountEncryptionObservationBinding } = await import('@/sync/http/accountEncryptionObservationBinding');
        const rotated = { token: credentials.token.replace(/\.signature$/, '.rotated-signature') };
        expect(rotated.token).not.toBe(credentials.token);
        expect(readAccountEncryptionObservationBinding(context.request, rotated)).toBeNull();
        const beforeRotated = reads;
        await readConnectedMetadataCatalogInContext({ ...context, credentials: rotated }, undefined, undefined, false);
        expect(reads - beforeRotated).toBeGreaterThanOrEqual(1);

        // A mode change pushed to the socket withdraws the observation: the next read re-admits
        // and refuses to disclose rows read under the retired mode.
        currentness = { ...currentness, mode: 'e2ee', version: 2, updatedAt: 2,
            signingKeyFingerprint: 'changed-signing-key', contentKeyFingerprint: 'changed-content-key',
            recipientEnvelopeReadiness: { status: 'available' } };
        const beforePush = reads;
        invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self', hint: { encryptionMode: 'e2ee' } }], { serverId });
        await expect(read()).rejects.toMatchObject({ code: 'account_storage_currentness_unavailable' });
        expect(reads - beforePush).toBeGreaterThanOrEqual(1);


        // Reconnect: transport loss withdraws the binding, so the next disclosure reads fresh.
        currentness = createPlainAccountEncryptionCurrentnessFixture();
        apiSocket.disconnect();
        expect(readAccountEncryptionObservationBinding(context.request, context.credentials)?.peek() ?? null).toBeNull();
        const beforeReconnect = reads;
        await read();
        expect(reads - beforeReconnect).toBeGreaterThanOrEqual(1);
    } finally { context.dispose(); }
});

it('refuses a read catalog as account-mode-mismatch when a mode change is pushed while its rows are in flight', async () => {
    const { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/connect/connectedAccountPresentationRowsV1');
    const { readConnectedMetadataCatalogInContext } = await import('@/sync/api/account/apiConnectedMetadataCatalog');
    const { createAccountScopedCryptoMaterialSnapshotV1 } = await import('@happier-dev/protocol/crypto/accountScopedCipher');
    const { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } = await import('@happier-dev/protocol/account/encryptionKeyFingerprintV1');
    const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const accountId = 'disclosure-pushed-mismatch';
    const serverUrl = 'https://disclosure-pushed-mismatch.test';
    const token = createAccountTokenForTests(accountId, { currentAccount: true });
    // An E2EE Account whose device holds its material only as historical custody, so a verified
    // E2EE→plain transition is admissible and the disclosure check observes a different mode.
    const credentials = { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url'), custody: 'historical' as const };
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(createAccountScopedCryptoMaterialSnapshotV1({
        accountEncryptionMode: 'e2ee', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials)! }).contentPublicKeyFingerprint);
    const serverId = await home.addHome({ name: 'Pushed mismatch', serverUrl, accountId, credentials,
        accountEncryptionMode: 'e2ee', currentAccount: true });
    let currentness: AccountEncryptionCurrentnessResponse = { ...createPlainAccountEncryptionCurrentnessFixture(), mode: 'e2ee',
        contentKeyFingerprint: fingerprint, recipientEnvelopeReadiness: { status: 'available' } };
    setRuntimeFetch(async (url, init) => new URL(String(url)).pathname === '/v1/account/encryption/currentness'
        ? Response.json(currentness) : home.request(url, init));
    const held = createDeferred<void>();
    home.answer(serverId, `GET ${CONNECTED_PRESENTATION_ROWS_ROUTE_V1}`, { respondAfter: held.promise, body: { status: 'deleted', revision: 3 } });
    home.answer(serverId, `GET ${CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1}`, { respondAfter: held.promise, body: { status: 'deleted', revision: 3 } });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    apiSocket.initialize({ endpoint: serverUrl, token: credentials.token, credentials, serverId,
        generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials }), isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const context = await captureLazyActionAccountContext(serverId);
    let reading: Promise<unknown> | undefined;
    try {
        await expect(context.resolveAccountMode()).resolves.toBe('e2ee');
        reading = readConnectedMetadataCatalogInContext(context, undefined, undefined, false);
        await waitForHomeGovernance(() => expect(home.requestsFor(CONNECTED_PRESENTATION_ROWS_ROUTE_V1)).toHaveLength(1));
        currentness = { ...createPlainAccountEncryptionCurrentnessFixture(), version: 2, updatedAt: 2 };
        invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self', hint: { encryptionMode: 'plain' } }], { serverId });
        held.resolve();
        await expect(reading).rejects.toMatchObject({ code: 'account-mode-mismatch' });
    } finally { held.resolve(); await Promise.allSettled([reading]); context.dispose(); }
});

it('makes one fresh observation per reconnect that every consumer then uses', async () => {
    const accountId = 'reconnect-one-observation';
    const serverUrl = 'https://reconnect-one-observation.test';
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Reconnect observation', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    let currentness: AccountEncryptionCurrentnessResponse = createPlainAccountEncryptionCurrentnessFixture();
    let currentnessReads = 0;
    let modeReads = 0;
    setRuntimeFetch(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') { currentnessReads++; return Response.json(currentness); }
        if (path === '/v1/account/encryption') { modeReads++; return Response.json({ mode: currentness.mode, updatedAt: currentness.updatedAt }); }
        return home.request(url, init);
    });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    apiSocket.initialize({ endpoint: serverUrl, token: credentials.token, credentials, serverId,
        generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials }), isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const longLived = await captureLazyActionAccountContext(serverId);
    const consume = async () => {
        // The consumers the recovery burst attributes: fresh Action contexts, their encryption and
        // mode, identity storage readers and a context captured before the reconnect.
        await Promise.all(Array.from({ length: 6 }, async () => {
            const context = await captureLazyActionAccountContext(serverId);
            try {
                await context.resolveAccountMode();
                await context.resolveAccountEncryption();
                await fetchAccountEncryptionIdentity(context.credentials, { request: context.request, usage: 'identity' });
                await fetchAccountEncryptionMode(context.credentials, { request: context.request, usage: 'identity' });
            } finally { context.dispose(); }
        }));
        await fetchAccountEncryptionIdentity(longLived.credentials, { request: longLived.request, usage: 'identity' });
    };
    try {
        await longLived.resolveAccountMode();
        await consume();
        // Transport loss. A context captured while the socket is down has no observation yet.
        socket!.disconnect();
        const heldThroughReconnect = await captureLazyActionAccountContext(serverId);
        const beforeCurrentness = currentnessReads;
        const beforeMode = modeReads;
        socket!.connect();
        await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
        try {
            await consume();
            await heldThroughReconnect.resolveAccountMode();
            await fetchAccountEncryptionIdentity(heldThroughReconnect.credentials, { request: heldThroughReconnect.request, usage: 'identity' });
            await consume();
        } finally { heldThroughReconnect.dispose(); }
        // The socket's own connect read is the one fresh observation; every consumer borrows it.
        expect({ currentness: currentnessReads - beforeCurrentness, mode: modeReads - beforeMode })
            .toEqual({ currentness: 1, mode: 0 });

        // A mode change pushed after the reconnect is still honored: the next reader re-admits once.
        currentness = { ...currentness, version: 2, updatedAt: 2 };
        const beforeChange = currentnessReads;
        invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self', hint: { encryptionMode: 'plain' } }], { serverId });
        await consume();
        expect(currentnessReads - beforeChange).toBe(1);
    } finally { longLived.dispose(); }
});

it('lets finite operations share the reconnect observation while its read is still pending', async () => {
    const { fetchOperationAccountEncryptionIdentity } = await import('./apiAccountEncryptionMode');
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const accountId = 'reconnect-operation-share';
    const serverUrl = 'https://reconnect-operation-share.test';
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'Reconnect operations', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    let reads = 0;
    let failReads = false;
    let gate: Promise<void> = Promise.resolve();
    setRuntimeFetch(async (url, init) => {
        if (new URL(String(url)).pathname !== '/v1/account/encryption/currentness') return home.request(url, init);
        reads++;
        await gate;
        return failReads ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(createPlainAccountEncryptionCurrentnessFixture());
    });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    apiSocket.initialize({ endpoint: serverUrl, token: credentials.token, credentials, serverId,
        generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials }), isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const context = await captureLazyActionAccountContext(serverId);
    try {
        await context.resolveAccountMode();
        socket!.disconnect();
        const held = createDeferred<void>();
        gate = held.promise;
        const before = reads;
        socket!.connect();
        await waitForHomeGovernance(() => expect(reads - before).toBe(1));
        const operations = Promise.all(Array.from({ length: 5 }, () =>
            fetchOperationAccountEncryptionIdentity(context.credentials, { request: context.request })));
        held.resolve();
        await expect(operations).resolves.toHaveLength(5);
        expect(reads - before).toBe(1);

        // A failed observation read never strands an operation: it re-admits over its own request.
        gate = Promise.resolve();
        socket!.disconnect();
        failReads = true;
        socket!.connect();
        await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
        await expect(fetchOperationAccountEncryptionIdentity(context.credentials, { request: context.request })).rejects.toBeDefined();
        failReads = false;
        await expect(fetchOperationAccountEncryptionIdentity(context.credentials, { request: context.request })).resolves.toMatchObject({ mode: 'plain' });
    } finally { context.dispose(); }
});
