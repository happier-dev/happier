import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createPlainSessionOwnerMetadataEnvelopeV1, encodeSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createMaterializedEphemeralRunnerFixture } from '@/app/ephemeralRunner/materializedRunner.testkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionCreateOrLoadRoute } from './registerSessionCreateOrLoadRoute';
import { registerSessionDeleteRoute } from './registerSessionDeleteRoute';
import { registerSessionListingRoutes } from './registerSessionListingRoutes';
import { registerSessionReadBatchRoute } from './registerSessionReadBatchRoute';
import { encodeBase64 } from '../../../../../../ui/sources/encryption/base64';
import { Encryption } from '../../../../../../ui/sources/sync/encryption/encryption';
import { createFakeCryptoWorker } from '../../../../../../ui/sources/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { createSessionReadBatchHttpBoundary } from '../../../../../../ui/sources/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createDeferred } from '../../../../../../ui/sources/dev/testkit/hooks/createDeferred';
import { createDataKeyAccountEncryptionCurrentnessFixture } from '../../../../../../ui/sources/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createCapturedServerReadTransport } from '../../../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { fetchAndApplySessionById } from '../../../../../../ui/sources/sync/engine/sessions/sessionById';
import { createSessionSnapshotReadCurrentness, reconcileSessionSnapshotMembership } from '../../../../../../ui/sources/sync/engine/sessions/snapshotMembership';

describe('Session batch observation → held UI read → list omission (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-batch-membership-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('keeps a newer held batch read through an older omission, then applies a real later withdrawal without leaking an Account cut', async () => {
        const machineKey = new Uint8Array(32).fill(7);
        const pair = tweetnacl.box.keyPair.fromSecretKey(machineKey);
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(pair.publicKey) } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: { publicKey: encodeBase64(pair.publicKey, 'base64'), machineKey: encodeBase64(machineKey, 'base64') } };
        const headers = { authorization: `Bearer ${token}`, 'x-happier-account-stored-content-protocol': '4' };
        const author = await Encryption.createFromContentKeyPair({ publicKey: pair.publicKey, machineKey });
        author.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const authorId = randomUUID();
        const key = new Uint8Array(32).fill(8);
        await author.initializeSessions(new Map([[authorId, key]]));
        const metadata = await author.getSessionEncryption(authorId)!.encryptRaw({ name: 'New readable Session' });
        const dataEncryptionKey = encodeBase64(await author.encryptEncryptionKey(key), 'base64');

        await withAuthenticatedTestApp(app => {
            registerSessionCreateOrLoadRoute(app);
            registerSessionDeleteRoute(app);
            registerSessionListingRoutes(app);
            registerSessionReadBatchRoute(app);
        }, async app => {
            const earlierResponse = await app.inject({ method: 'GET', url: '/v2/sessions', headers });
            expect(earlierResponse.statusCode, earlierResponse.body).toBe(200);
            const earlier = V2SessionListResponseSchema.parse(earlierResponse.json());
            expect(earlier.sessions).toEqual([]);
            expect(earlier.observationCursor).toEqual(expect.any(Number));

            const created = await app.inject({ method: 'POST', url: '/v1/sessions', headers,
                payload: { tag: randomUUID(), metadata, dataEncryptionKey, encryptionMode: 'e2ee' } });
            expect(created.statusCode, created.body).toBe(200);
            const sessionId: string = created.json().session.id;
            const reader = await Encryption.createFromContentKeyPair({ publicKey: pair.publicKey, machineKey });
            const entered = createDeferred<void>();
            const release = createDeferred<void>();
            const worker = createFakeCryptoWorker();
            // Native crypto is the system boundary: keep real hydration pending
            // after the batch response's access/cursor observation is consumed.
            reader.configureNativeCryptoWorker({ worker: { ...worker, decryptDataKeyEnvelopeV1: async request => {
                entered.resolve();
                await release.promise;
                return worker.decryptDataKeyEnvelopeV1(request);
            } }, routing: { mode: 'auto', minPayloadBytes: 0 } });
            const physicalReads: string[] = [];
            const boundary = createSessionReadBatchHttpBoundary(async observation => {
                if (observation.path !== '/v2/sessions/read-batch') throw new Error('Expected the real batch HTTP route');
                physicalReads.push(observation.path);
                const response = await app.inject({ method: 'POST', url: observation.path, headers, payload: observation.body });
                // Preserve the actual HTTP envelope; never synthesize it from
                // scalar fixtures, which would hide the decorating-route defect.
                return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
            });
            const request = async (path: string, init: RequestInit) => {
                const url = new URL(path, 'https://session-batch.test');
                const response = await boundary.handle({ home: url.origin, accountId: owner.id, url, path: url.pathname,
                    method: init.method ?? 'GET', headers: new Headers(init.headers), signal: init.signal,
                    body: init.body ? JSON.parse(String(init.body)) : undefined });
                if (!response) throw new Error('Missing real Session batch response');
                return response;
            };
            const serverId = `composed-${owner.id}`;
            const readTransport = createCapturedServerReadTransport({ serverId, credentials, prepared: {
                endpointUrl: 'https://session-batch.test', generation: 1,
                request: async (path, init, _options, consume) => consume(await request(path, init ?? {})),
            } });
            const pending = createSessionSnapshotReadCurrentness();
            const applySessions = vi.fn();
            const read = fetchAndApplySessionById({ sessionId, serverId, credentials, encryption: reader,
                accountCurrentness: createDataKeyAccountEncryptionCurrentnessFixture({ machineKey, publicKey: pair.publicKey }),
                sessionDataKeys: new Map(), request, readTransport, includeTurnsProjection: false,
                accessProjectionVersion: 1, onSessionObservation: pending.observe, isCurrent: pending.isCurrent,
                applySessions, log: { log() {} } });
            let membership = new Set([sessionId]);
            const retired: string[] = [];
            try {
                await Promise.race([entered.promise, read.then(result => {
                    throw new Error(`Session read settled before the native crypto hold: ${result.errorCode ?? result.ok}`);
                })]);
                expect(applySessions).not.toHaveBeenCalled();
                membership = reconcileSessionSnapshotMembership({ previous: membership, sessionIds: earlier.sessions.map(row => row.id),
                    observation: earlier, readMember: () => undefined,
                    pendingReads: [{ sessionId, ...pending }], retireSession: id => retired.push(id) });
                expect([...membership]).toEqual([sessionId]);
                expect(pending.isCurrent()).toBe(true);
                expect(retired).toEqual([]);
                expect(pending.read()?.observationCursor).toBeGreaterThan(earlier.observationCursor!);
            } finally { release.resolve(); await read; }
            await expect(read).resolves.toMatchObject({ ok: true, session: { id: sessionId, metadata: { name: 'New readable Session' } } });
            expect(applySessions).toHaveBeenCalledWith([expect.objectContaining({ id: sessionId })]);
            expect(physicalReads).toEqual(['/v2/sessions/read-batch']);
            expect(boundary.componentRequests).toEqual([]);

            const restrictedReader = await createMaterializedEphemeralRunnerFixture();
            await db.session.update({ where: { id: restrictedReader.sessionId }, data: {
                metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: { summary: { text: 'Restricted Session', updatedAt: 0 } } })),
                ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 })),
            } });
            const restricted = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                headers: { ...headers, authorization: `Bearer ${restrictedReader.token}` },
                payload: { sessionIds: [restrictedReader.sessionId], underSessionId: restrictedReader.sessionId,
                    accessProjectionVersion: 1, includeSnapshot: true, includeTurns: false, includeMessages: false } });
            expect(restricted.statusCode, restricted.body).toBe(200);
            const restrictedDetail = SessionReadBatchResponseV1Schema.parse(restricted.json()).results[0]?.detail;
            expect(restrictedDetail?.status, JSON.stringify(restrictedDetail)).toBe(200);
            expect(restrictedDetail?.body).not.toHaveProperty('observationCursor');

            const deleted = await app.inject({ method: 'DELETE', url: `/v1/sessions/${sessionId}`, headers });
            expect(deleted.statusCode, deleted.body).toBe(200);
            const laterResponse = await app.inject({ method: 'GET', url: '/v2/sessions', headers });
            expect(laterResponse.statusCode, laterResponse.body).toBe(200);
            const later = V2SessionListResponseSchema.parse(laterResponse.json());
            expect(later.observationCursor).toBeGreaterThan(pending.read()!.observationCursor!);
            membership = reconcileSessionSnapshotMembership({ previous: membership, sessionIds: later.sessions.map(row => row.id),
                observation: later, readMember: () => pending.read(), pendingReads: [], retireSession: id => retired.push(id) });
            expect([...membership]).toEqual([]);
            expect(retired).toEqual([sessionId]);
        }, { authentication: 'real' });
    }, 120_000);
});
