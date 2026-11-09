import { afterEach, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import tweetnacl from 'tweetnacl';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { ProfileRecordV1Schema, sealProfileRecordContentV1, PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { computeAccountEncryptionMigrateKeyFingerprintV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { sealRemoteHostCatalogContentV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { encodeBase64 } from '@/encryption/base64';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { fetchAccountEncryptionMode } from './apiAccountEncryptionMode';
import { readSavedSecretReferenceInContext } from './apiSavedSecretCatalog';
import { readRemoteHostCatalog, readRemoteHostCatalogProjection, readRemoteHostCatalogProjectionInContext } from './apiRemoteHostCatalog';
import { readProfileCatalogProjection } from './apiProfileCatalog';
import { importLegacySavedSecretsInContext } from '@/sync/ops/settings/savedSecretResourceOperations';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await loadSyncSingletonForTests();
afterEach(async () => {
    apiSocket.disconnect();
    await resetServerReachabilitySupervisors();
    await home.reset();
    resetRuntimeFetch();
});

it.each([
    { kind: 'profile', authority: 'matching', pinned: false },
    { kind: 'profile', authority: 'revoked', pinned: false },
    { kind: 'profile', authority: 'fingerprint-changed', pinned: false },
    { kind: 'importer', authority: 'revoked', pinned: false },
    { kind: 'importer', authority: 'revoked', pinned: true },
] as const)('borrows only initial Settings discovery ($kind, $authority, pinned=$pinned)', async ({ kind, authority, pinned }) => {
    const accountId = `source-discovery-${kind}-${authority}-${pinned}`;
    const serverUrl = `https://${accountId}.test`;
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }),
        secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') };
    const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);
    if (!material) throw new Error('Expected real E2EE discovery material');
    const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint);
    const changedFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(
        tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(25)).publicKey);
    const serverId = await home.addHome({ name: 'Initial source discovery', serverUrl, accountId, credentials,
        accountEncryptionMode: 'e2ee', currentAccount: true });
    const requested = createDeferred<void>();
    const bodyReady = createDeferred<void>();
    let committed = false;
    let authorityReads = 0;
    let authorityAtFirstSettings: number | undefined;
    let settingsReads = 0;
    const finalAuthority: string[] = [];
    const afterCommitRequests: string[] = [];
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'private-profile', enabled: true, promptStack: [], secretBindings: {},
        definition: { kind: 'inline', profile: { v: 2, id: 'private-profile', name: 'Privately opened', createdAt: 1, updatedAt: 1 } } });
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (committed) afterCommitRequests.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness') {
            authorityReads++;
            if (committed) finalAuthority.push(path);
            if (committed && authority === 'revoked') return Response.json({}, { status: 401 });
            return Response.json(path.endsWith('/currentness') ? { mode: 'e2ee', version: 1, settingsVersion: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: committed && authority === 'fingerprint-changed'
                    ? changedFingerprint : fingerprint, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } }
                : { mode: 'e2ee', updatedAt: 1 });
        }
        if (path === '/v2/account/settings') {
            settingsReads++;
            authorityAtFirstSettings ??= authorityReads;
            const payload = { version: 1, content: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                kind: 'account_settings', material, payload: {}, randomBytes: tweetnacl.randomBytes }) } };
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                requested.resolve(undefined);
                void bodyReady.promise.then(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); });
            } }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (path === PROFILE_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows: [{ id: record.id, revision: 1,
            content: sealProfileRecordContentV1({ mode: 'e2ee', material, record }) }], complete: true, nextCursor: null,
            diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } });
        if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json({ status: 'ready', revision: 1 });
        if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
        if (path === '/v1/account/saved-secrets/resources/materials') {
            // A missing materials route would stop on HTTP404 before reaching
            // the fresh authority refusal this held-source test protects.
            return Response.json(SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [] }));
        }
        return home.request(rawUrl, init);
    });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    apiSocket.initialize({ endpoint: serverUrl, token: credentials.token, credentials, serverId,
        generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials }), isCurrent: () => true }, null);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    const captured = await captureLazyActionAccountContext(serverId);
    try {
        expect(await captured.resolveAccountMode()).toBe('e2ee');
        expect(authorityReads).toBe(1);
        authorityReads = 0;
        const scope = { serverId, accountId };
        const read = kind === 'profile' ? readProfileCatalogProjection(scope, undefined, { deferCleanup: true, migrateSkills: false })
            : importLegacySavedSecretsInContext(captured, 'e2ee', scope, undefined,
                pinned ? { mode: 'e2ee', raw: {}, version: 1 } : undefined);
        await Promise.race([requested.promise, read.then(() => { throw new Error('Source completed before its private Settings body was held'); })]);
        committed = true;
        bodyReady.resolve(undefined);
        const result = await read;
        if (kind === 'profile') {
            expect(result).toMatchObject(authority === 'matching' ? { catalog: { status: 'ready', records: [{ record }] } }
                : { catalog: { status: 'unavailable' }, artifactsById: new Map(), source: null });
            expect(finalAuthority).toEqual(Array(authority === 'matching' ? 2 : 1).fill('/v1/account/encryption/currentness'));
        } else {
            expect(finalAuthority, JSON.stringify(afterCommitRequests)).toEqual(['/v1/account/encryption/currentness']);
            // Explicit maintenance reaches its final fresh proof in the history
            // owner. A refusal there is pending history, never a completed import.
            expect(result).toEqual({ status: 'pending', reason: 'history-pending' });
            expect(settingsReads).toBe(1);
            expect(afterCommitRequests.filter(request => request.includes('/v2/account/settings/history'))).toEqual([]);
            expect(afterCommitRequests.filter(request => !request.startsWith('GET '))).toEqual([]);
        }
        // The projection keeps its write-bearing outer admission. Only its
        // nested discovery borrows; a pinned import must still admit afresh.
        expect(authorityAtFirstSettings).toBe(kind === 'profile' || pinned ? 1 : 0);
    } finally {
        bodyReady.resolve(undefined);
        captured.dispose();
    }
});

it.each((['plain', 'e2ee'] as const).flatMap(mode => (['cold', 'warm'] as const).map(warmth => ({ mode, warmth }))))(
    'enters the RemoteHost scope admission only once ($warmth identity, $mode)', async ({ warmth, mode }) => {
    const accountId = `remote-host-single-admission-${warmth}-${mode}`;
    const serverUrl = `https://remote-host-single-admission-${warmth}-${mode}.test`;
    const token = createAccountTokenForTests(accountId, { currentAccount: true });
    const credentials = mode === 'e2ee' ? { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') } : { token };
    const material = mode === 'e2ee' ? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : null;
    const fingerprint = material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint) : null;
    const serverId = await home.addHome({ name: 'One RemoteHost admission', serverUrl, accountId, credentials,
        accountEncryptionMode: mode, currentAccount: true });
    let rowRead = false;
    const initialAuthority: string[] = [];
    const finalAuthority: string[] = [];
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness') {
            (rowRead ? finalAuthority : initialAuthority).push(path);
            return Response.json(path.endsWith('/currentness') ? mode === 'plain' ? createPlainAccountEncryptionCurrentnessFixture()
                : { mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: fingerprint,
                    updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } } : { mode, updatedAt: 1 });
        }
        if (path === '/v1/account/entity-rows/remote-hosts') {
            rowRead = true;
            return Response.json({ status: 'present', revision: 1,
                content: sealRemoteHostCatalogContentV1({ mode, material, record: { v: 1, hosts: [] } }) });
        }
        return home.request(rawUrl, init);
    });
    if (warmth === 'warm') {
        let socket: Socket | undefined;
        installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
        apiSocket.initialize({ endpoint: serverUrl, token: credentials.token, credentials, serverId,
            generation: getActiveServerSnapshot().generation,
            request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials }), isCurrent: () => true }, null);
        await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
        const warm = await captureLazyActionAccountContext(serverId);
        try { await expect(warm.resolveAccountMode()).resolves.toBe(mode); }
        finally { warm.dispose(); }
        expect(initialAuthority).toEqual(['/v1/account/encryption/currentness']);
        initialAuthority.length = 0;
    }
    // This is the production scope entry, not a manually branded test context.
    await expect(readRemoteHostCatalog({ serverId, accountId })).resolves.toMatchObject({ status: 'ready', hosts: [] });
    expect(initialAuthority).toEqual(warmth === 'warm' ? [] : ['/v1/account/encryption', '/v1/account/encryption/currentness']);
    // Read-only disclosure borrows the connection's admitted observation; cold reads admit over HTTP.
    expect(finalAuthority).toEqual(warmth === 'warm' ? [] : ['/v1/account/encryption/currentness']);
});

it.each(['none', 'pending', 'cleanup'] as const)('reuses the last RemoteHost publication admission for its return (%s publication)', async publication => {
    const accountId = `remote-host-publication-count-${publication}`;
    const serverUrl = `https://remote-host-publication-count-${publication}.test`;
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const serverId = await home.addHome({ name: 'One return admission', serverUrl, accountId, credentials,
        accountEncryptionMode: 'plain', currentAccount: true });
    let opened = false;
    let finalAuthorityReads = 0;
    const publications: number[] = [];
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') {
            if (opened) finalAuthorityReads++;
            return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }));
        }
        if (path === '/v1/account/entity-rows/remote-hosts') {
            opened = true;
            return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, hosts: [] } } });
        }
        if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
        if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
        if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
        return home.request(rawUrl, init);
    });
    await expect(readRemoteHostCatalogProjection({ serverId, accountId }, undefined, {
        ...(publication !== 'cleanup' ? { hasPendingCleanup: () => true } : {}),
        ...(publication !== 'none' ? { onReady: () => { publications.push(finalAuthorityReads); } } : {}),
    })).resolves.toMatchObject({ status: 'ready', hosts: [] });
    if (publication === 'none') expect(finalAuthorityReads).toBe(1);
    else {
        expect(publications).toHaveLength(publication === 'cleanup' ? 2 : 1);
        if (publication === 'pending') expect(finalAuthorityReads).toBe(1);
        // No private work follows the last awaited publication, so returning
        // that same result must not acquire a third authority observation.
        expect(finalAuthorityReads).toBe(publications.at(-1));
    }
});

it.each([401, 403])('retains typed RemoteHost publication refusal without an external callback (%s)', async status => {
    const accountId = `remote-host-typed-publication-${status}`;
    const serverUrl = `https://remote-host-typed-publication-${status}.test`;
    const serverId = await home.addHome({ name: 'Typed refusal', serverUrl, accountId,
        credentials: { token: createAccountTokenForTests(accountId, { currentAccount: true }) },
        accountEncryptionMode: 'plain', currentAccount: true });
    let opened = false;
    let refusedReads = 0;
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') {
            if (opened) { refusedReads++; return Response.json({}, { status }); }
            return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        }
        if (path === '/v1/account/entity-rows/remote-hosts') {
            opened = true;
            return Response.json({}, { status });
        }
        return home.request(rawUrl, init);
    });
    await expect(readRemoteHostCatalogProjection({ serverId, accountId }, undefined, { hasPendingCleanup: () => true }))
        .resolves.toEqual({ status: 'unavailable', reason: status === 401 ? 'unauthorized' : 'forbidden' });
    expect(refusedReads).toBe(1);
});

const disclosureCases = (['saved-secret', 'remote-host'] as const).flatMap(kind =>
    (['connected', 'reconnect-gap'] as const).map(transport => ({ kind, transport, authority: 'revoked' as const })));
const encryptedCases = (['matching', 'fingerprint-changed', 'revoked'] as const).map(authority => ({
    kind: 'encrypted-secret' as const, transport: 'connected' as const, authority,
}));
it.each([...disclosureCases, ...encryptedCases])('admits privately opened $kind through held publication ($transport, $authority)', async ({ kind, transport, authority }) => {
    const accountId = `${kind}-${authority}-${transport}`;
    const serverUrl = `https://${kind}-${authority}-${transport}.test`;
    const ref = 'happier:shared-secret:v1:held';
    const encrypted = kind === 'encrypted-secret';
    const token = createAccountTokenForTests(accountId, { currentAccount: true });
    const credentials = encrypted ? { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') } : { token };
    const encryption = encrypted ? await createEncryptionFromAuthCredentials(credentials) : null;
    const material = encrypted ? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : null;
    const fingerprint = material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint) : null;
    const changedFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(
        tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(25)).publicKey);
    const resourceDataKey = new Uint8Array(32).fill(19);
    const accountMode = encrypted ? 'e2ee' : 'plain';
    const serverId = await home.addHome({ name: 'Held private material', serverUrl, accountId, credentials,
        accountEncryptionMode: accountMode, currentAccount: true });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => {
        socket = current;
        configureConnectedServerSocketBoundary(current);
    });
    let committed = false;
    let identityAuthorityReads = 0;
    const requested = createDeferred<void>();
    const bodyReady = createDeferred<void>();
    const authorityAfterCommit: string[] = [];
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness') {
            identityAuthorityReads++;
            if (committed) authorityAfterCommit.push(path);
            if (committed && authority === 'revoked') {
                return Response.json({ error: 'unauthorized' }, { status: 401 });
            }
            return Response.json(path.endsWith('/currentness') ? encrypted ? { mode: 'e2ee', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: committed && authority === 'fingerprint-changed'
                    ? changedFingerprint : fingerprint, updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } }
                : createPlainAccountEncryptionCurrentnessFixture() : { mode: accountMode, updatedAt: 1 });
        }
        if (path === (kind !== 'remote-host' ? '/v1/account/saved-secrets/resources/materials' : '/v1/account/entity-rows/remote-hosts')) {
            const content = { v: 1 as const, name: 'Held', kind: 'token' as const, value: 'must-stay-private' };
            const payload = kind !== 'remote-host' ? { resources: [{ resourceId: 'held', encryptionMode: accountMode,
                recipientEnvelope: encryption ? { encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                    dataKey: resourceDataKey, recipientPublicKey: encryption.contentDataKey, randomBytes: tweetnacl.randomBytes }), 'base64'),
                    recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey) } : null,
                storedContent: encrypted ? sealSavedSecretResourceStoredContentV1({ resourceId: 'held', mode: 'e2ee',
                    resourceDataKey, content, randomBytes: tweetnacl.randomBytes }) : { t: 'plain', v: content },
                entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Held', kind: 'token', revision: 1,
                    materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] }
                : { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, hosts: [{ id: 'held-host', name: 'Private host',
                    ssh: { target: 'private@example.test', authMode: 'agent' }, createdAt: 1, updatedAt: 1, lastUsedAt: null }] } } };
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                requested.resolve(undefined);
                void bodyReady.promise.then(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); });
            } }), { headers: { 'Content-Type': 'application/json' } });
        }
        return home.request(rawUrl, init);
    });
    const lifetime = new AbortController();
    const captured = await captureLazyActionAccountContext(serverId, lifetime.signal);
    try {
        const admittedCredentials = captured.credentials;
        const initialRequest = createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials: admittedCredentials });
        apiSocket.initialize({ endpoint: serverUrl, token: admittedCredentials.token, credentials: admittedCredentials,
            serverId, generation: getActiveServerSnapshot().generation, request: initialRequest,
            isCurrent: captured.accountLifetime.isCurrent }, null);
        await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
        const binding = apiSocket.getAccountEncryptionObservationBinding(admittedCredentials);
        expect(binding).not.toBeNull();
        const request = createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials: admittedCredentials,
            signal: lifetime.signal, isCurrent: captured.accountLifetime.isCurrent, accountEncryptionObservation: binding ?? undefined });
        const resolveAccountMode = async () => (await fetchAccountEncryptionMode(admittedCredentials, { request, usage: 'identity' })).mode;
        // Keep the real Action capture/currentness and use the exact admitted
        // Socket binding on its real captured HTTP transport.
        const context = { ...captured, request };
        expect(await resolveAccountMode()).toBe(accountMode);
        expect(identityAuthorityReads).toBe(1);
        const warmedAuthorityReads = identityAuthorityReads;
        expect(await resolveAccountMode()).toBe(accountMode);
        // Prove this is a borrowed observation, not the unbranded HTTP fallback.
        expect(identityAuthorityReads).toBe(warmedAuthorityReads);
        let published = false;
        const read = kind !== 'remote-host' ? readSavedSecretReferenceInContext(context, ref)
            : readRemoteHostCatalogProjectionInContext(context, undefined, {
                onReady: () => { published = true; }, hasPendingCleanup: () => true,
            });
        await Promise.race([requested.promise, read.then(() => { throw new Error('Reader completed before its private response body was held'); })]);
        // The authority boundary now models a committed token epoch change.
        // Neither an Account push nor a server disconnect has been delivered.
        committed = true;
        if (transport === 'reconnect-gap') {
            socket!.disconnect();
            socket!.connect();
        }
        bodyReady.resolve(undefined);
        // A read-only catalog row discloses under the connection's admitted observation: a revocation
        // committed but not yet delivered takes effect at the next boundary (a delivered push, a
        // reconnect, or the next request). Saved Secret plaintext keeps its fresh authority point.
        const nextBoundary = kind === 'remote-host' && transport === 'connected';
        await expect(read).resolves.toMatchObject(authority === 'matching' ? { ok: true, value: 'must-stay-private', revision: 1 }
            : kind !== 'remote-host' ? { ok: false } : nextBoundary ? { status: 'ready' } : { status: 'unavailable' });
        expect(published).toBe(nextBoundary);
        if (nextBoundary) expect(authorityAfterCommit).toEqual([]);
        else if (encrypted) expect(authorityAfterCommit).toEqual(['/v1/account/encryption/currentness']);
        else expect(authorityAfterCommit).toContain(kind === 'saved-secret' ? '/v1/account/encryption' : '/v1/account/encryption/currentness');
    } finally { bodyReady.resolve(undefined); lifetime.abort(); captured.dispose(); }
});
