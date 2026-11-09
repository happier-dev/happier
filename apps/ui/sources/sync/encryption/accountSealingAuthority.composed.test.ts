import { afterEach, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resetServerReachabilitySupervisors } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { prepareSessionOrganizationDisplayEnvelope } from '@/sync/ops/sessionOrganization/sessionOrganizationDisplayEnvelope';
import { createArtifactWithHeaderViaApi } from '@/sync/engine/artifacts/syncArtifacts';
import { createReviewCommentsHttpActionExecutor } from '@/sync/domains/reviews/comments/api';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import * as nativeCrypto from 'rn-encryption';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { ReviewCommentPrepareMutationRequestV1Schema, ReviewCommentPrepareMutationResponseV1Schema,
    deriveReviewCommentStructuralMutationV1 } from '@happier-dev/protocol/reviews/comments/mutation';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// The real process singleton forwards ambient identity demand to the admitted
// Account socket. Loading it during collection keeps cold graph setup out of a hook.
await loadSyncSingletonForTests();
afterEach(async () => {
    apiSocket.disconnect();
    await resetServerReachabilitySupervisors();
    await home.reset();
    resetRuntimeFetch();
});

it.each(['organization', 'artifact', 'review-comment'] as const)(
    'refuses to emit plain %s content after authority becomes E2EE while its socket identity remains plain', async kind => {
        const accountId = `sealing-authority-${kind}`;
        const serverUrl = `https://sealing-authority-${kind}.test`;
        const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
        const serverId = await home.addHome({ name: 'Sealing authority', serverUrl, accountId, credentials,
            accountEncryptionMode: 'plain', currentAccount: true });
        let socket: Socket | undefined;
        installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
        let mode: 'plain' | 'e2ee' = 'plain';
        let authorityReads = 0;
        const emittedBodies: string[] = [];
        setRuntimeFetch(async (rawUrl, init) => {
            const path = new URL(String(rawUrl)).pathname;
            if (path === '/v1/account/encryption' || path === '/v1/account/encryption/currentness') {
                authorityReads++;
                return Response.json(path.endsWith('/currentness') ? createPlainAccountEncryptionCurrentnessFixture()
                    : { mode, updatedAt: mode === 'plain' ? 1 : 2 });
            }
            if ((path === '/v1/artifacts' || path.startsWith('/v1/reviews/comments')) && init?.method !== 'GET') {
                emittedBodies.push(String(init?.body));
                return Response.json({ error: 'content_mode_mismatch' }, { status: 400 });
            }
            return home.request(rawUrl, init);
        });
        const lifetime = new AbortController();
        const captured = await captureLazyActionAccountContext(serverId, lifetime.signal);
        try {
            const admitted = captured.credentials;
            apiSocket.initialize({ endpoint: serverUrl, token: admitted.token, credentials: admitted, serverId,
                generation: getActiveServerSnapshot().generation,
                request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials: admitted }),
                isCurrent: captured.accountLifetime.isCurrent }, null);
            await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
            expect(apiSocket.getAccountEncryptionObservationBinding(admitted)).not.toBeNull();
            await expect(fetchAccountEncryptionMode(admitted)).resolves.toMatchObject({ mode: 'plain' });
            const warmedReads = authorityReads;
            await expect(fetchAccountEncryptionMode(admitted)).resolves.toMatchObject({ mode: 'plain' });
            expect(authorityReads).toBe(warmedReads);
            // Only HTTP authority changes. No push or disconnect is delivered.
            mode = 'e2ee';
            const seal = kind === 'organization'
                        ? prepareSessionOrganizationDisplayEnvelope({ credentials: admitted, value: { label: 'Private label' } })
                        : kind === 'artifact'
                            ? createArtifactWithHeaderViaApi({ credentials: admitted, encryption: null,
                                artifactDataKeys: new Map(), header: { title: 'Private Artifact' }, body: 'Private body', addArtifact: () => {} })
                            : createReviewCommentsHttpActionExecutor()('reviews.comments.create', {
                                projectId: 'project', anchor: { kind: 'file', filePath: 'private.ts' },
                                snapshot: { kind: 'too_large', filePath: 'private.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
                                body: 'Private review', clientMutationId: 'private-mutation',
                            });
            await expect(seal).rejects.toBeInstanceOf(Error);
            expect(authorityReads).toBe(warmedReads + 1);
            expect(emittedBodies).toEqual([]);
            expect(socket?.connected).toBe(true);
        } finally { lifetime.abort(); captured.dispose(); }
    },
);

async function e2eeSealingHome(kind: string, domainRequest: (path: string, init?: RequestInit) => Promise<Response | null>) {
    const accountId = `late-sealing-${kind}`;
    const serverUrl = `https://late-sealing-${kind}.test`;
    const secret = new Uint8Array(32).fill(7);
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }), secret: encodeBase64(secret, 'base64url') };
    const encryption = await Encryption.create(secret);
    const contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint);
    const serverId = await home.addHome({ name: 'Late sealing', serverUrl, accountId, credentials,
        accountEncryptionMode: 'e2ee', currentAccount: true });
    let socket: Socket | undefined;
    installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
    let mode: 'plain' | 'e2ee' = 'e2ee';
    let modeReads = 0;
    setRuntimeFetch(async (rawUrl, init) => {
        const path = new URL(String(rawUrl)).pathname;
        if (path === '/v1/account/encryption') { modeReads++; return Response.json({ mode, updatedAt: 1 }); }
        if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'e2ee', version: 1,
            signingKeyFingerprint: 'signing-current', contentKeyFingerprint, updatedAt: 1 });
        return await domainRequest(path, init) ?? await home.request(rawUrl, init);
    });
    const lifetime = new AbortController();
    const captured = await captureLazyActionAccountContext(serverId, lifetime.signal);
    apiSocket.initialize({ endpoint: serverUrl, token: captured.credentials.token, credentials: captured.credentials, serverId,
        generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials: captured.credentials }),
        isCurrent: captured.accountLifetime.isCurrent }, encryption);
    await waitForHomeGovernance(() => expect(socket?.connected).toBe(true));
    await expect(fetchAccountEncryptionMode(captured.credentials)).resolves.toMatchObject({ mode: 'e2ee' });
    const warmReads = modeReads;
    await expect(fetchAccountEncryptionMode(captured.credentials)).resolves.toMatchObject({ mode: 'e2ee' });
    expect(modeReads).toBe(warmReads);
    return { accountId, serverId, credentials: captured.credentials, encryption, modeReads: () => modeReads,
        changeMode: () => { mode = 'plain'; }, dispose: () => { lifetime.abort(); captured.dispose(); } };
}

it('withholds a captured review mutation when mode changes while the real prepare response is held', async () => {
    const requested = createDeferred<void>();
    const release = createDeferred<void>();
    let commits = 0;
    let accountId = '';
    const fixture = await e2eeSealingHome('review', async (path, init) => {
        if (path === '/v1/reviews/comments/mutations/prepare') {
            const request = ReviewCommentPrepareMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
            const derived = deriveReviewCommentStructuralMutationV1({ mutation: request.mutation, accountId,
                actor: { kind: 'user', userId: accountId }, current: [], runtime: { now: () => 1, createId: () => 'comment-late' } });
            const response = ReviewCommentPrepareMutationResponseV1Schema.parse({ v: 1, request,
                receipt: 'late-receipt', replayed: false, ...derived });
            requested.resolve(undefined);
            await release.promise;
            return Response.json(response);
        }
        if (path === '/v1/reviews/comments/mutations/commit') {
            commits++;
            return Response.json({ error: 'unexpected_commit' }, { status: 400 });
        }
        return null;
    });
    accountId = fixture.accountId;
    try {
        const result = createDefaultActionExecutor().execute('reviews.comments.create', {
            projectId: 'project', anchor: { kind: 'file', filePath: 'private.ts' },
            snapshot: { kind: 'too_large', filePath: 'private.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'Private review', clientMutationId: 'late-review',
        }, { serverId: fixture.serverId, surface: 'ui', authority: 'present_user', bypassApprovals: true });
        await Promise.race([requested.promise, result.then(value => { throw new Error(`Action did not reach prepare: ${JSON.stringify(value)}`); })]);
        expect(fixture.modeReads()).toBe(0);
        fixture.changeMode();
        release.resolve(undefined);
        const outcome = await result;
        expect(commits, JSON.stringify(outcome)).toBe(0);
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: false, errorCode: 'review_comment_encryption_mode_mismatch' });
        expect(fixture.modeReads()).toBe(1);
    } finally { release.resolve(undefined); fixture.dispose(); }
});

it('withholds Artifact creation when mode changes while native encryption is held', async () => {
    let writes = 0;
    const fixture = await e2eeSealingHome('artifact-crypto', async (path, init) => {
        if (path === '/v1/artifacts' && init?.method === 'POST') {
            writes++;
            return Response.json({ error: 'unexpected_write' }, { status: 400 });
        }
        return null;
    });
    const requested = createDeferred<void>();
    const release = createDeferred<void>();
    const encrypt = nativeCrypto.encryptAsyncAES;
    const native = vi.spyOn(nativeCrypto, 'encryptAsyncAES').mockImplementationOnce(async (...args) => {
        requested.resolve(undefined);
        await release.promise;
        return await encrypt(...args);
    });
    try {
        const create = createArtifactWithHeaderViaApi({ credentials: fixture.credentials, encryption: fixture.encryption,
            artifactDataKeys: new Map(), header: { title: 'Private Artifact' }, body: 'Private body', addArtifact: () => {} });
        const refused = expect(create).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
        await Promise.race([requested.promise, create.then(() => { throw new Error('Artifact creation bypassed native encryption'); })]);
        fixture.changeMode();
        release.resolve(undefined);
        await refused;
        expect(writes).toBe(0);
        expect(fixture.modeReads()).toBe(1);
    } finally { release.resolve(undefined); native.mockRestore(); fixture.dispose(); }
});

it('readmits the Artifact mode on the existing physical retry after authority changes', async () => {
    let writes = 0;
    let changeMode = () => {};
    const fixture = await e2eeSealingHome('artifact-retry', async (path, init) => {
        if (path === '/v1/artifacts' && init?.method === 'POST') {
            writes++;
            changeMode();
            return Response.json({ error: writes === 1 ? 'unavailable' : 'unexpected_write' }, { status: writes === 1 ? 503 : 400 });
        }
        return null;
    });
    changeMode = fixture.changeMode;
    try {
        await expect(createArtifactWithHeaderViaApi({ credentials: fixture.credentials, encryption: fixture.encryption,
            artifactDataKeys: new Map(), header: { title: 'Private Artifact' }, body: 'Private body', addArtifact: () => {} }))
            .rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
        expect(writes).toBe(1);
        expect(fixture.modeReads()).toBe(2);
    } finally { fixture.dispose(); }
});
