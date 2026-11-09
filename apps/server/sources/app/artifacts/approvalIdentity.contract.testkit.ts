import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { z } from 'zod/mini';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent,
    openSessionDataKeyBundleV0, sealSessionDataKeyBundleV0, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createApprovalRequestArtifact } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { db } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { createArtifactTx } from './artifactWriteService';
import { inTx } from '@/storage/inTx';

/** Shared real HTTP/storage contract, run against disposable SQLite and PostgreSQL. */
export function approvalIdentityContract() {
    describe('Account-scoped approval identity through real Artifact HTTP admission', () => {
        async function account(mode: 'plain' | 'e2ee') {
            const keys = tweetnacl.box.keyPair();
            const row = await db.account.create({ data: { encryptionMode: mode,
                ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
            const key = tweetnacl.randomBytes(32);
            return {
                id: row.id,
                dataEncryptionKey: mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
                    : privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
                        recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes })),
                encode: async (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
                    : privacyKit.encodeBase64(await sealSessionDataKeyBundleV0(value, key)),
                decode: async (value: string): Promise<unknown> => {
                    if (mode === 'plain') return decodePlainArtifactStoredContent(value);
                    const result = await openSessionDataKeyBundleV0(privacyKit.decodeBase64(value), key);
                    if (result.status !== 'authenticated') throw new Error('Fixture content failed authentication');
                    return result.value;
                },
            };
        }

        function proposal(accountId: string): ApprovalRequestV2 {
            return ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
                createdBy: { surface: 'cli' }, requestedSurface: 'cli', summary: 'Delete Session',
                actionId: 'session.delete', actionArgs: { sessionId: 'session' },
                executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                    serverId: 'home', serverIdentityId: 'home-identity', accountId,
                    actionId: 'session.delete', requestId: randomUUID() } });
        }

        it.each(['plain', 'e2ee'] as const)('keeps ordinary UUID8/variant8 creates and reads available for %s', async mode => {
            const owner = await account(mode);
            // Existing Role/Saved-Secret producers use this distinct UUID8
            // subspace. Reserving every UUID8 would refuse legitimate writers.
            const hex = randomUUID().replaceAll('-', '');
            const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
            await withAuthenticatedTestApp(artifactsRoutes, async app => {
                const headers = { 'x-test-user-id': owner.id };
                const created = await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: {
                    id, header: await owner.encode({ title: 'Ordinary document' }),
                    body: await owner.encode({ body: 'ordinary' }), dataEncryptionKey: owner.dataEncryptionKey,
                } });
                expect(created.statusCode).toBe(200);
                const read = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers });
                expect(read.statusCode).toBe(200);
                const wire = ArtifactHttpReadV1Schema.parse(read.json());
                expect(wire.access).toBe('owner');
                expect(await owner.decode(wire.body)).toEqual({ body: 'ordinary' });
            });
        });

        it.each(['plain', 'e2ee'] as const)('refuses a foreign %s preclaim, then deduplicates the owner retry', async mode => {
            const owner = await account(mode);
            const foreign = await account(mode);
            const request = proposal(owner.id);
            let preclaimed = false;
            await withAuthenticatedTestApp(artifactsRoutes, async app => {
                const headers = { 'x-test-user-id': owner.id };
                const foreignHeaders = { 'x-test-user-id': foreign.id };
                const foreignContent = { header: await foreign.encode({ title: 'Ordinary Artifact' }),
                    body: await foreign.encode({ body: 'foreign' }), dataEncryptionKey: foreign.dataEncryptionKey };
                let sourceId = '';
                // Obtain the actual public legacy identity without persisting an
                // owner receipt, then preclaim it before the owner's first read.
                await createApprovalRequestArtifact({ request, accountId: owner.id, newId: randomUUID,
                    read: async () => null,
                    create: async (_id, header, body, idScope?: unknown) => {
                        sourceId = z.object({ sourceId: z.string() }).parse(idScope).sourceId;
                        return { header, body, access: 'owner' };
                    },
                });
                const legacy = await app.inject({ method: 'POST', url: '/v1/artifacts', headers: foreignHeaders,
                    payload: { id: sourceId, ...foreignContent } });
                expect(legacy.statusCode).toBe(200);
                const open = async (value: unknown) => {
                    const wire = ArtifactHttpReadV1Schema.parse(value);
                    const header = z.record(z.string(), z.unknown()).parse(await owner.decode(wire.header));
                    const content = z.object({ body: z.string() }).parse(await owner.decode(wire.body));
                    return { header, body: content.body, access: wire.access };
                };
                const create = () => createApprovalRequestArtifact({ request, accountId: owner.id, newId: randomUUID,
                    read: async artifactId => {
                        const response = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}`, headers });
                        if (response.statusCode === 404) return null;
                        expect(response.statusCode).toBe(200);
                        return open(response.json());
                    },
                    create: async (id, header, body, idScope?: unknown) => {
                        if (!preclaimed) {
                            preclaimed = true;
                            // An ordinary-kind request without the scope must not reserve this ID.
                            const omitted = await app.inject({ method: 'POST', url: '/v1/artifacts', headers: foreignHeaders,
                                payload: { id, ...foreignContent } });
                            expect(omitted.statusCode).toBe(400);
                            const forged = await app.inject({ method: 'POST', url: '/v1/artifacts', headers: foreignHeaders,
                                payload: { id, idScope, ...foreignContent } });
                            expect(forged.statusCode).toBe(400);
                            // Domain transactions share the same admission, even
                            // when they bypass HTTP and disguise the stored kind.
                            const direct = await inTx(tx => createArtifactTx(tx, {
                                actorUserId: foreign.id, artifactId: id,
                                header: privacyKit.decodeBase64(foreignContent.header),
                                body: privacyKit.decodeBase64(foreignContent.body),
                                dataEncryptionKey: privacyKit.decodeBase64(foreignContent.dataEncryptionKey),
                            }));
                            expect(direct).toEqual({ ok: false, error: 'invalid-params' });
                            expect(await db.artifact.count({ where: { id } })).toBe(0);
                        }
                        const response = await app.inject({ method: 'POST', url: '/v1/artifacts', headers,
                            payload: { id, ...(idScope === undefined ? {} : { idScope }), header: await owner.encode(header),
                                body: await owner.encode({ body }), dataEncryptionKey: owner.dataEncryptionKey } });
                        expect(response.statusCode).toBe(200);
                        const stored = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers });
                        expect(stored.statusCode).toBe(200);
                        return open(stored.json());
                    },
                });
                const first = await create();
                expect(preclaimed).toBe(true);
                expect((await create()).artifactId).toBe(first.artifactId);
                expect(await db.artifact.count({ where: { accountId: owner.id } })).toBe(1);
                expect(await db.artifact.findUniqueOrThrow({ where: { id: first.artifactId },
                    select: { headerVersion: true, bodyVersion: true } })).toEqual({ headerVersion: 1, bodyVersion: 1 });
            });
        });

        it.each(['plain', 'e2ee'] as const)('rejoins an existing %s approval at its original ID without another write', async mode => {
            const owner = await account(mode);
            const request = proposal(owner.id);
            let legacyId = '';
            // Use the real identity producer to obtain its compatibility source ID.
            await createApprovalRequestArtifact({ request, accountId: owner.id, newId: randomUUID,
                read: async () => null,
                create: async (id, header, body, idScope?: unknown) => {
                    legacyId = idScope === undefined ? id : z.object({ sourceId: z.string() }).parse(idScope).sourceId;
                    return { header, body, access: 'owner' };
                },
            });
            await withAuthenticatedTestApp(artifactsRoutes, async app => {
                const headers = { 'x-test-user-id': owner.id };
                const seeded = await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: {
                    id: legacyId, header: await owner.encode(buildApprovalRequestArtifactHeaderV1(request)),
                    body: await owner.encode({ body: JSON.stringify(request) }), dataEncryptionKey: owner.dataEncryptionKey,
                } });
                expect(seeded.statusCode).toBe(200);
                const result = await createApprovalRequestArtifact({ request, accountId: owner.id, newId: randomUUID,
                    read: async id => {
                        const response = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers });
                        if (response.statusCode === 404) return null;
                        expect(response.statusCode).toBe(200);
                        const wire = ArtifactHttpReadV1Schema.parse(response.json());
                        return { header: z.record(z.string(), z.unknown()).parse(await owner.decode(wire.header)),
                            body: z.object({ body: z.string() }).parse(await owner.decode(wire.body)).body, access: wire.access };
                    },
                    create: async () => { throw new Error('Existing owner consent must not be duplicated'); },
                });
                expect(result.artifactId).toBe(legacyId);
                expect(result.request.status).toBe('open');
                expect(await db.artifact.count({ where: { accountId: owner.id } })).toBe(1);
            });
        });
    });
}
